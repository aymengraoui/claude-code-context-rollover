/**
 * The mod through the engine's own dispatch (`claude plugin test`): register.ts's
 * hooks, `$.state` as the host keeps it, the gate as the tool chain sees it, the
 * resume prompt as prompt.submit carries it. The engine's own effects beneath (the
 * model, /clear, the disk) are answered by the test's hooks.
 */

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { RolloverStatus } from '../types'
import { seal, snapshotName } from '../hooks/lib/store'

const ROOT = 'C:/Users/me/.claude/context-rollover/C--work-game'

const posix = (path: string): string => path.split(String.fromCharCode(92)).join('/')

/** The engine's effects a session start reaches, answered in memory; returns the latest published status. */
const world = (on: On, files: Map<string, string>, tokens: number | null = 20000): (() => RolloverStatus) => {
  let latest: unknown = null
  on('state.set', (_$, e, next) => {
    if (e.plugin === 'context-rollover') latest = e.value
    return next(e)
  })
  on('command.register', () => ({ value: { command: 'rollover' } }))
  on('session.cwd', () => ({ value: 'C:/work/game' }))
  on('session.id', () => ({ value: 'sessA000-0000' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, ...(tokens === null ? {} : { tokens, percent: tokens / 10000 }) }, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  on('clock.now', () => ({ value: 1_760_000_000_000 }))
  on('clock.every', () => ({ deny: 'no timers in tests' }))
  on('fs.read', (_$, e) => {
    const text = files.get(posix(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(posix(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: [...files.keys()].filter(one => one.startsWith(`${posix(e.path)}/`)).map(one => ({ name: one.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.exists', (_$, e) => ({ value: files.has(posix(e.path)) }))

  return () => latest as RolloverStatus
}

test('at start the mod publishes a valid status with the engine’s own reading', async ($, on) => {
  const statusOf = world(on, new Map(), 20000)
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  const s = statusOf()
  expect(s.schemaVersion).toBe(1)
  expect(s.sessionId).toBe('sessA000-0000')
  expect(s.phase).toBe('monitoring')
  expect(s.context).toMatchObject({ tokens: 20000, window: 1000000, source: 'session.usage' })
  expect(s.thresholds).toEqual({ soft: 180000, prepare: 190000, hard: 200000 })
})

test('a measurement past the soft limit moves the shared state to preparing and tells the model', async ($, on) => {
  const notes: string[] = []
  const statusOf = world(on, new Map())
  on('session.append', (_$, e, next) => {
    notes.push(JSON.stringify(e.message.content))
    return next(e)
  })
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { window: 1000000, tokens: 183000, percent: 18 }, rateLimits: [], changed: ['context'] })
  const s = statusOf()
  expect(s.phase).toBe('preparing')
  expect(s.context).toMatchObject({ tokens: 183000, source: 'session.measure' })
  expect(notes.some(one => one.includes('[context-rollover] Context is at 183k'))).toBe(true)
})

test('the project’s own config file sets the thresholds', async ($, on) => {
  const files = new Map([['C:/work/game/.claude/context-rollover.json', JSON.stringify({ softLimit: 90000, prepareLimit: 95000, hardLimit: 100000 })]])
  const statusOf = world(on, files)
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  expect(statusOf().thresholds).toEqual({ soft: 90000, prepare: 95000, hard: 100000 })
})

test('from the prepare limit the tool chain refuses a new Agent, and lets other tools run', async ($, on) => {
  const statusOf = world(on, new Map())
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: 'turn-1' }))
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.list', () => ({ value: [] }))
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await $.session.measure({ context: { window: 1000000, tokens: 192000, percent: 19 }, rateLimits: [], changed: ['context'] })
  expect(statusOf().phase).toBe('ready')

  const agent = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(String((agent as { text?: string; deny?: string }).text ?? (agent as { deny?: string }).deny)).toContain('do not start new agents')
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((bash as { isError?: boolean }).isError === true).toBe(false)
})

test('/rollover resume hands the continuation to the model, then starts the turn', async ($, on) => {
  const files = new Map<string, string>()
  const snapshot = seal({
    rolloverId: 'g1-sessZ-1',
    kind: 'final',
    generation: 1,
    createdAt: 1_759_999_000_000,
    fromSessionId: 'sessZ',
    project: 'C:/work/game',
    markdown: '# Context rollover continuation — g1-sessZ-1\n\n## Objective\n\nBuild the game',
    data: { finalTokens: 195000 } as never,
  })
  files.set(`${ROOT}/snapshots/${snapshotName(snapshot)}`, JSON.stringify(snapshot))
  const statusOf = world(on, files)
  const seen: string[] = []
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('session.append', (_$, e, next) => {
    seen.push(`append:${JSON.stringify(e.message.content)}`)
    return next(e)
  })
  on('prompt.submit', (_$, e) => {
    seen.push(`submit:${e.text}`)
    return { text: e.text }
  })
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'rollover', args: 'resume g1-sessZ-1' } as never)
  expect(out.text ?? '').toContain('Restoring g1-sessZ-1')
  for (let i = 0; i < 20000 && !seen.some(one => one.startsWith('submit:')); i += 1) await Promise.resolve()
  const append = seen.findIndex(one => one.startsWith('append:') && one.includes('## Objective'))
  const submit = seen.findIndex(one => one.startsWith('submit:[context-rollover] Fresh session after rollover g1-sessZ-1'))
  expect(append).toBeGreaterThan(-1)
  expect(submit).toBeGreaterThan(append)
  expect(statusOf().continuation).toMatchObject({ status: 'restored', rolloverId: 'g1-sessZ-1' })
  expect(files.has(`${ROOT}/claims/g1-sessZ-1.json`)).toBe(true)
})

test('a continuation nobody restored is offered at startup, in the prompt box', async ($, on) => {
  const files = new Map<string, string>()
  const snapshot = seal({ rolloverId: 'g3-sessQ-9', kind: 'final', generation: 3, createdAt: 1_759_999_900_000, fromSessionId: 'sessQ', project: 'C:/work/game', markdown: '# x', data: {} as never })
  files.set(`${ROOT}/snapshots/${snapshotName(snapshot)}`, JSON.stringify(snapshot))
  const statusOf = world(on, files)
  const filled: string[] = []
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  expect(filled).toEqual(['/rollover resume g3-sessQ-9'])
  expect(statusOf().continuation).toMatchObject({ status: 'pending', rolloverId: 'g3-sessQ-9' })
})

test('/rollover status describes the state in words', async ($, on) => {
  const statusOf = world(on, new Map(), 142000)
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'rollover', args: 'status' } as never)
  expect(out.text ?? '').toContain('context 142k / 200k')
  expect(out.text ?? '').toContain('phase monitoring')
})

test('a response’s own usage, mid-turn, past the hard limit drains the turn: main-loop tools are refused', async ($, on) => {
  const statusOf = world(on, new Map())
  on('session.start', () => ({ cwd: 'C:/work/game' }))
  on('turn.start', () => ({ turnId: 'turn-9' }))
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  on('clock.sleep', () => new Promise<never>(() => undefined))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 199000, cache_creation_input_tokens: 1500, model: 'claude-opus-5-5' },
    } as never
  })
  await $.session.start({ cwd: 'C:/work/game', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-9' })
  const stream = $.turn.step({ turnId: 'turn-9', index: 3, model: 'claude-opus-5-5', messageCount: 40 })
  for await (const _ of stream) {
    // drain the stream
  }
  expect(statusOf().context).toMatchObject({ tokens: 202500, source: 'turn.step' })
  expect(statusOf().phase).toBe('draining')
  const bash = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(String((bash as { text?: string }).text ?? (bash as { deny?: string }).deny)).toContain('Context rollover in progress')
  const task = await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  expect((task as { isError?: boolean }).isError === true).toBe(false)
})
