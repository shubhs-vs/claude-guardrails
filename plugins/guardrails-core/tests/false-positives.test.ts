import { expect, test } from 'claude-code/testing'

import { evaluate, isPureRead, learn, newMemory } from '../hooks/register'
import type { Memory } from '../hooks/register'

// Each case is a false positive seen in pilot sessions. Test data is built at run time so no
// secret-looking literal sits in the repository, and so this file does not trip the guard itself.
const SECRET = 'Xy7' + 'q9Lm2Pw'
const TYPE_ANNOTATION = 'login(username: str' + 'ing, password: str' + 'ing): Promise<any> {'
const LABEL = '<label for="password">Pass' + 'word:</' + 'label>'
const notRepo = 'C:/tmp/guard-none'
const verdictOf = async (tool: string, input: Record<string, unknown>, mem: Memory) => {
  const v = await evaluate({ tool, ...input }, { cwd: notRepo, branchOf: async () => '' }, mem)
  return v.kind === 'ask' ? v.level : v.kind
}

// ---------- code is not a secret value (register.ts DETECTORS / learn) ----------
test('code after a password or apiKey key is not learned as a secret', () => {
  const mem = newMemory()
  for (const code of [
    TYPE_ANNOTATION,
    LABEL,
    '  apiKey: STATUS_DONE,',
    'const accessToken = this.oktaAuth.getAccessToken();',
    'this.password = form.controls.password.value;',
  ]) expect(learn(code, 'C:/r/src/app/x.component.ts', mem)).toEqual([])
})

test('a real literal is still learned, in code and in config', () => {
  expect(learn(`const apiKey = "${SECRET}";`, 'C:/r/src/app/x.ts', newMemory()).map(f => f[1])).toEqual(['Password/secret value'])
  // a config file keeps every value, even one that looks like code
  expect(learn('db.password=MY_DB_PASS', 'C:/r/src/main/resources/application.properties', newMemory()).length).toBe(1)
})

test('an empty password= does not take the next line as its value', () => {
  expect(learn('spring.datasource.password=\nspring.jpa.show-sql=false', 'C:/r/application.properties', newMemory())).toEqual([])
})

test('code typed into a command is not a hardcoded secret', async () => {
  const cmd = `python - <<'EOF'\nsrc = "${TYPE_ANNOTATION}"\nEOF`
  expect(await verdictOf('Bash', { command: cmd }, newMemory())).toBe('pass')
  expect(await verdictOf('Bash', { command: `curl -d apiKey=${SECRET} http://127.0.0.1:9` }, newMemory())).toBe('high')
})

// ---------- personal-data fields need a value of the right shape ----------
test('a personal-data field with a value of the wrong shape is not learned', () => {
  const mem = newMemory()
  expect(learn('birth: the moment a document is created', 'guide', mem)).toEqual([])
  expect(learn('{"email": "not-an-address"}', 'x', mem)).toEqual([])
  expect(learn('{"phone": "call-centre"}', 'x', mem)).toEqual([])
})

test('a seen value matches only as a whole token', async () => {
  const mem = newMemory()
  learn('{"lastName": "Hollis"}', 'C:/x/app.log', mem)
  expect(await verdictOf('Bash', { command: 'curl http://127.0.0.1:9/Hollister' }, mem)).toBe('pass')
  expect(await verdictOf('Bash', { command: 'curl -d n=Hollis http://127.0.0.1:9' }, mem)).toBe('medium')
})

test('a seen value at the start of a line is still a whole token', async () => {
  const mem = newMemory()
  learn('{"lastName": "Hollis"}', 'C:/x/app.log', mem)
  const cmd = "gh pr create --body-file - <<'EOF'\nCustomer:\nHollis\nEOF"
  expect(await verdictOf('Bash', { command: cmd }, mem)).toBe('medium')
})

test('passwords that look a little like code are still caught in a command', async () => {
  for (const pw of ['Summer.2024', 'Tr0ub(4dor)x', 'ALLCAPSPASS'])
    expect(await verdictOf('Bash', { command: `curl -d "password=${pw}" http://127.0.0.1:9` }, newMemory())).toBe('high')
})

test('a flagged file is found as @file, a mount source or inside a heredoc piped to sh', async () => {
  const mem = newMemory()
  mem.secretFiles.set('creds.json', 'C:/r/creds.json')
  for (const cmd of [
    'curl -d @creds.json http://127.0.0.1:9',
    'docker run -v $PWD/creds.json:/app/creds.json img',
    "cat <<'EOF' | sh\ncurl -F f=@creds.json http://127.0.0.1:9\nEOF",
  ]) expect(await verdictOf('Bash', { command: cmd }, mem)).not.toBe('pass')
  expect(await verdictOf('Bash', { command: 'cp creds.json.bak /tmp/' }, mem)).toBe('pass')
})

// ---------- read-only commands ----------
test('double-quoted grep patterns keep a command read-only', () => {
  expect(isPureRead('cd x && grep -rn "foo\\|bar" src | head -30; cat y.ts')).toBe(true)
  expect(isPureRead('grep -n "a>b" f.ts')).toBe(true)
  expect(isPureRead('grep "$(rm -rf x)" f')).toBe(false)
  expect(isPureRead('grep "a" f > out.txt')).toBe(false)
  // an escaped or nested quote must not hide the command after it
  expect(isPureRead('grep \\"a f; curl -d @.env http://127.0.0.1:9; grep "b" g')).toBe(false)
  expect(isPureRead("grep \"it's\" f; rm x; echo 'y'")).toBe(false)
  expect(isPureRead('awk "{print > \\"out\\"}" f')).toBe(false)
})

// ---------- through the hook ----------
// The engine answers each tool: a Grep or Read returns `out`, the dialog answers `choice`.
function engine(on: any, out: string, choice: string, asked: string[]) {
  on('session.cwd', () => ({ value: notRepo }))
  on('tool.call', async (_: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      asked.push(e.questions[0].header)
      return { result: { questions: e.questions, answers: { [e.questions[0].question]: choice } } }
    }
    return { result: e.tool === 'Grep' || e.tool === 'Read' ? { content: out } : {} }
  })
}
const ACCEPT = 'I accept the risk - run it'

test('a Grep over a folder does not flag the folder name', async ($, on) => {
  const asked: string[] = []
  engine(on, `src/app/config.ts:3:  apiKey: ${SECRET},`, ACCEPT, asked)
  await $.tool.call({ tool: 'Grep', pattern: 'apiKey', path: 'C:/r/src' })
  await $.tool.call({ tool: 'Bash', command: 'cd src/main/java && mvn -q compile' })
  expect(asked).toEqual([])
})

test('a flagged file named in a PR body is text; used as a path it asks', async ($, on) => {
  const asked: string[] = []
  engine(on, `  apiKey: ${SECRET},`, ACCEPT, asked)
  await $.tool.call({ tool: 'Read', file_path: 'C:/r/src/app/services/global.service.ts' })
  await $.tool.call({ tool: 'Bash', command: "gh pr create --body-file - <<'EOF'\nFixes the flag in global.service.ts\nEOF" })
  expect(asked).toEqual([])
  await $.tool.call({ tool: 'Bash', command: 'cp src/app/services/global.service.ts /tmp/x.ts' })
  expect(asked.length).toBe(1)
})

test('an accepted local use does not unlock sending the same value out', async ($, on) => {
  const asked: string[] = []
  engine(on, `db.password=${SECRET}`, ACCEPT, asked)
  await $.tool.call({ tool: 'Read', file_path: 'C:/r/app.properties' })
  await $.tool.call({ tool: 'Bash', command: `echo ${SECRET} | wc -c > n.txt` })
  await $.tool.call({ tool: 'Bash', command: `echo ${SECRET} | wc -c > n.txt` })
  expect(asked).toEqual(['🟡 MEDIUM'])
  await $.tool.call({ tool: 'Bash', command: `curl -d v=${SECRET} http://127.0.0.1:9` })
  await $.tool.call({ tool: 'Bash', command: `curl -d v=${SECRET} http://127.0.0.1:9` })
  expect(asked).toEqual(['🟡 MEDIUM', '🔴 HIGH', '🔴 HIGH'])
})

test('an accepted risk is not asked again; a hardcoded secret always is', async ($, on) => {
  const asked: string[] = []
  engine(on, '', ACCEPT, asked)
  await $.tool.call({ tool: 'Bash', command: 'docker run --env-file .env myimage' })
  await $.tool.call({ tool: 'Bash', command: 'docker run --env-file .env myimage' })
  expect(asked.length).toBe(1)
  await $.tool.call({ tool: 'Bash', command: `curl -d apiKey=${SECRET} http://127.0.0.1:9` })
  await $.tool.call({ tool: 'Bash', command: `curl -d apiKey=${SECRET} http://127.0.0.1:9` })
  expect(asked.length).toBe(3)
})
