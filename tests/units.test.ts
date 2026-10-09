import { expect, test } from 'claude-code/testing'

import { actionFor, countAgents, recordAgents, stillWorking } from '../hooks/lib/agents'
import { DEFAULTS, mergeConfig, parseProjectConfig, shouldLog } from '../hooks/lib/config'
import { approxTokens, buildContinuation, redact, resumePrompt, rolloverIdIn } from '../hooks/lib/continuation'
import type { ContinuationData } from '../hooks/lib/continuation'
import { initialStatus, isStale, validateStatus } from '../hooks/lib/contract'
import { commitDecision, parsePorcelain, safetyRefName } from '../hooks/lib/git'
import { checksum, claim, findPending, findSnapshot, parseSnapshot, rootFor, seal, writeSnapshot } from '../hooks/lib/store'
import type { FilePort } from '../hooks/lib/store'
import { parseSummary } from '../hooks/lib/summary'
import { contextTokensOf, effectiveThresholds, nextThreshold, progressOf, zoneOf } from '../hooks/lib/thresholds'
import { agentCalls, filesWritten, lastTodos, recentErrors, tasksFromTaskList, userRequests } from '../hooks/lib/transcript'
import { conversation, fiveAgents, PORCELAIN } from './world'

const T = { soft: 180000, prepare: 190000, hard: 200000 }

const memoryFs = (): FilePort & { files: Map<string, string> } => {
  const files = new Map<string, string>()
  return {
    files,
    read: async path => {
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
    write: async (path, text) => {
      files.set(path, text)
    },
    list: async path =>
      [...files.keys()]
        .filter(one => one.startsWith(`${path}/`) && !one.slice(path.length + 1).includes('/'))
        .map(one => ({ name: one.slice(path.length + 1), kind: 'file' })),
    exists: async path => files.has(path),
  }
}

const data = (overrides: Partial<ContinuationData> = {}): ContinuationData => ({
  rolloverId: 'g1-sessA000-abc',
  generation: 1,
  previousRolloverId: null,
  fromSessionId: 'sessA000',
  createdAt: 1_760_000_000_000,
  project: 'C:/work/game',
  finalTokens: 195000,
  thresholds: T,
  objective: 'Build the game',
  carriedDecisions: [],
  userRequests: ['Build a game'],
  summary: null,
  summaryNote: 'model summary is off',
  tasks: { source: 'TodoWrite', items: [{ subject: 'Level 3', status: 'in_progress' }] },
  agents: [],
  git: null,
  files: [],
  errors: [],
  ...overrides,
})

// ─── configuration ──────────────────────────────────────────────────────────

test('the defaults are the documented thresholds', () => {
  const { config, warnings } = mergeConfig()
  expect([config.softLimit, config.prepareLimit, config.hardLimit]).toEqual([180000, 190000, 200000])
  expect(config.autoCommit).toBe(false)
  expect(warnings).toEqual([])
})

test('later sources win, and every threshold comes from configuration', () => {
  const { config } = mergeConfig({ softLimit: 100000, prepareLimit: 120000, hardLimit: 150000 }, { hardLimit: 160000 })
  expect([config.softLimit, config.prepareLimit, config.hardLimit]).toEqual([100000, 120000, 160000])
})

test('a bad value is skipped with a warning naming it; thresholds out of order fall back together', () => {
  const bad = mergeConfig({ softLimit: 'lots', restartMode: 'teleport', mystery: 1 })
  expect(bad.config.softLimit).toBe(DEFAULTS.softLimit)
  expect(bad.config.restartMode).toBe('clear')
  expect(bad.warnings.length).toBe(3)
  const disorder = mergeConfig({ softLimit: 300000 })
  expect(disorder.config.softLimit).toBe(180000)
  expect(disorder.warnings[0]).toContain('soft < prepare < hard')
})

test('an empty /config field means unset, and a comma list becomes a list', () => {
  const { config } = mergeConfig({ softLimit: '', protectedBranches: 'main, release' })
  expect(config.softLimit).toBe(180000)
  expect(config.protectedBranches).toEqual(['main', 'release'])
})

test('a project config that is not a JSON object is reported, not trusted', () => {
  expect(parseProjectConfig('{"hardLimit": 250000}').values).toEqual({ hardLimit: 250000 })
  expect(parseProjectConfig('[1]').warning).toContain('not a JSON object')
  expect(parseProjectConfig('{oops').warning).toContain('not valid JSON')
})

test('log levels filter by rank', () => {
  expect(shouldLog('info', 'warn')).toBe(true)
  expect(shouldLog('info', 'debug')).toBe(false)
  expect(shouldLog('error', 'warn')).toBe(false)
})

// ─── thresholds and progress ───────────────────────────────────────────────

test('a reading falls in exactly one zone, each threshold inclusive', () => {
  expect(zoneOf(null, T)).toBe('below')
  expect(zoneOf(179999, T)).toBe('below')
  expect(zoneOf(180000, T)).toBe('soft')
  expect(zoneOf(189999, T)).toBe('soft')
  expect(zoneOf(190000, T)).toBe('prepare')
  expect(zoneOf(200000, T)).toBe('hard')
  expect(zoneOf(688000, T)).toBe('hard')
})

test('progress is tokens over the hard limit, clamped to 0–100', () => {
  expect(progressOf(142000, 200000)).toBe(71)
  expect(progressOf(250000, 200000)).toBe(100)
  expect(progressOf(-5, 200000)).toBe(0)
  expect(progressOf(null, 200000)).toBeNull()
  expect(progressOf(12000, 200000)).toBe(6)
})

test('the next threshold is the first one above the reading', () => {
  expect(nextThreshold(142000, T)).toEqual({ name: 'soft', at: 180000, remaining: 38000 })
  expect(nextThreshold(184000, T)).toEqual({ name: 'prepare', at: 190000, remaining: 6000 })
  expect(nextThreshold(195000, T)).toEqual({ name: 'hard', at: 200000, remaining: 5000 })
  expect(nextThreshold(200000, T)).toBeNull()
})

test('thresholds stand inside a large window and move down together inside a small one', () => {
  expect(effectiveThresholds(T, 1_000_000)).toEqual(T)
  expect(effectiveThresholds(T, null)).toEqual(T)
  // A 200k window: the hard limit moves to 180k, keeping the 10k and 20k gaps.
  expect(effectiveThresholds(T, 200000)).toEqual({ soft: 160000, prepare: 170000, hard: 180000 })
})

test('the context reading is the response’s input tokens, cached or not', () => {
  expect(contextTokensOf({ input_tokens: 1200, cache_read_input_tokens: 150000, cache_creation_input_tokens: 3000 })).toBe(154200)
})

// ─── the state contract ─────────────────────────────────────────────────────

test('a status validates; missing, malformed and future-schema ones do not', () => {
  const good = initialStatus(T, 1000)
  expect(validateStatus(good).isValid).toBe(true)
  expect(validateStatus(undefined)).toEqual({ isValid: false, reason: 'missing' })
  expect(validateStatus('hello')).toEqual({ isValid: false, reason: 'not an object' })
  expect(validateStatus({ ...good, schemaVersion: 2 })).toEqual({ isValid: false, reason: 'schema 2 unsupported' })
  expect(validateStatus({ ...good, phase: 'dancing' })).toEqual({ isValid: false, reason: 'unknown phase' })
  expect(validateStatus({ ...good, thresholds: { soft: 1, prepare: 2, hard: 0 } })).toEqual({ isValid: false, reason: 'bad thresholds' })
  expect(validateStatus({ ...good, context: { tokens: 'many', window: null } })).toEqual({ isValid: false, reason: 'bad context' })
})

test('a status is stale once its heartbeat is three periods old', () => {
  const s = initialStatus(T, 1000)
  expect(isStale(s, 1000 + 45000)).toBe(false)
  expect(isStale(s, 1000 + 45001)).toBe(true)
})

// ─── git ────────────────────────────────────────────────────────────────────

test('porcelain v2 gives branch, head, divergence, changes and untracked files', () => {
  const git = parsePorcelain(PORCELAIN)
  expect(git.branch).toBe('feat/game')
  expect(git.head).toBe('0bd1c4f5a6b7')
  expect(git.ahead).toBe(2)
  expect(git.changes).toEqual([
    { path: 'src/engine/physics.ts', status: 'M' },
    { path: 'src/levels/level3.ts', status: 'A' },
  ])
  expect(git.untracked).toEqual(['notes/ideas.md'])
  expect(parsePorcelain('u UU N... 100644 100644 100644 100644 a b c src/x.ts').conflicted).toEqual(['src/x.ts'])
  expect(parsePorcelain('# branch.head (detached)').branch).toBeNull()
})

test('autoCommit commits only when switched on and safe', () => {
  const git = { branch: 'feat/game', changes: [{ path: 'a', status: 'M' }], untracked: [], conflicted: [], inProgress: null }
  expect(commitDecision(git, false, ['main'])).toEqual({ shouldCommit: false, reason: 'autoCommit is off' })
  expect(commitDecision(git, true, ['main'])).toEqual({ shouldCommit: true })
  expect(commitDecision({ ...git, branch: 'main' }, true, ['main']).shouldCommit).toBe(false)
  expect(commitDecision({ ...git, branch: null }, true, ['main']).shouldCommit).toBe(false)
  expect(commitDecision({ ...git, conflicted: ['a'] }, true, ['main']).shouldCommit).toBe(false)
  expect(commitDecision({ ...git, inProgress: 'rebase' }, true, ['main']).shouldCommit).toBe(false)
  expect(commitDecision({ ...git, changes: [] }, true, ['main'])).toEqual({ shouldCommit: false, reason: 'nothing to commit' })
  expect(safetyRefName('g1-ab/cd')).toBe('refs/context-rollover/g1-ab-cd')
})

// ─── agents and the transcript ──────────────────────────────────────────────

test('agents are counted by status, never invented', () => {
  expect(countAgents(fiveAgents())).toEqual({ active: 2, idle: 1, pending: 1, completed: 1, failed: 0, total: 5 })
  expect(countAgents([])).toEqual({ active: 0, idle: 0, pending: 0, completed: 0, failed: 0, total: 0 })
  expect(stillWorking(fiveAgents())).toBe(3)
})

test('interrupted work is re-dispatched, finished work reviewed, an idle teammate re-dispatched', () => {
  expect(actionFor('running', false, false)).toBe('re-dispatch')
  expect(actionFor('killed', true, false)).toBe('re-dispatch')
  expect(actionFor('completed', true, false)).toBe('review-output')
  expect(actionFor('completed', false, false)).toBe('none')
  expect(actionFor('idle', false, true)).toBe('re-dispatch')
})

test('each agent keeps its identity, its responsibility and its last output', () => {
  const records = recordAgents(fiveAgents(), agentCalls(conversation()), { 'ag-physics': 'Physics done; tests green.' })
  const physics = records.find(one => one.id === 'ag-physics')
  expect(physics?.name).toBe('physics')
  expect(physics?.responsibility).toContain('deterministic physics')
  expect(physics?.lastOutput).toBe('Physics done; tests green.')
  expect(physics?.action).toBe('review-output')
  expect(records.find(one => one.id === 'ag-ui')?.teammateId).toBe('ui@game')
  expect(records.find(one => one.id === 'ag-levels')?.action).toBe('re-dispatch')
})

test('the transcript yields requests, the last plan, files, errors and agent calls', () => {
  const messages = conversation()
  expect(userRequests(messages).first).toContain('robotics lab game')
  expect(userRequests(messages).recent.at(-1)).toBe('Prioritise level 3 over audio polish.')
  expect(lastTodos(messages)?.items.map(one => one.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(filesWritten(messages)).toEqual(['src/engine/physics.ts'])
  expect(recentErrors(messages)[0]).toContain('npm test: FAIL physics.test.ts')
  expect(agentCalls(messages)).toHaveLength(5)
})

test('the resume prompt and reminders are never mistaken for the person’s requests', () => {
  const messages = [
    { role: 'user' as const, text: resumePrompt('g1-x', 1, '/p'), toolUses: [] },
    { role: 'user' as const, text: '<system-reminder>x</system-reminder>', toolUses: [] },
  ]
  expect(userRequests(messages).first).toBeNull()
})

test('the TaskList answer is read from its record or its text', () => {
  const tasks = { tasks: [{ id: '1', subject: 'Level 3', status: 'in_progress', owner: 'levels', blockedBy: [] }] }
  expect(tasksFromTaskList(tasks)?.items[0]).toEqual({ id: '1', subject: 'Level 3', status: 'in_progress', owner: 'levels', blockedBy: [] })
  expect(tasksFromTaskList(JSON.stringify(tasks))?.source).toBe('TaskList')
  expect(tasksFromTaskList('nonsense')).toBeNull()
})

// ─── the targeted summary ───────────────────────────────────────────────────

test('a summary is read out of prose or a code fence, and an empty one is refused', () => {
  const reply = 'Here you go:\n```json\n{"objective":"Ship it","nextActions":["Run tests"],"decisions":[],"notes":"has a } brace"}\n```'
  expect(parseSummary(reply)?.objective).toBe('Ship it')
  expect(parseSummary(reply)?.notes).toBe('has a } brace')
  expect(parseSummary('{"notes":"only notes"}')).toBeNull()
  expect(parseSummary('no json at all')).toBeNull()
  expect(parseSummary('{"objective": broken')).toBeNull()
})

// ─── the continuation ───────────────────────────────────────────────────────

test('a continuation carries the objective, tasks, and the resume protocol', () => {
  const { markdown } = buildContinuation(data(), '/snap.json', 10000)
  expect(markdown).toContain('## Objective')
  expect(markdown).toContain('Build the game')
  expect(markdown).toContain('[~] Level 3')
  expect(markdown).toContain('## Resume protocol')
  expect(markdown).toContain('/snap.json')
})

test('an oversized continuation is trimmed lowest priority first, keeping the protocol and objective', () => {
  const huge = data({
    files: Array.from({ length: 400 }, (_, i) => `src/generated/file-${i}.ts`),
    errors: Array.from({ length: 50 }, (_, i) => `Bash npm test: failure number ${i} `.repeat(4)),
    userRequests: ['x'.repeat(500)],
  })
  const { markdown, approxTokens: size, omittedLines } = buildContinuation(huge, '/snap.json', 2000)
  expect(size).toBeLessThanOrEqual(2000)
  expect(approxTokens(markdown)).toBe(size)
  expect(omittedLines).toBeGreaterThan(0)
  expect(markdown).toContain('## Resume protocol')
  expect(markdown).toContain('Build the game')
  expect(markdown).toContain('lower-priority lines were left out')
})

test('credentials are redacted from a continuation', () => {
  expect(redact('key sk-ant-REDACTME0123456789abcdef here')).toBe('key [REDACTED] here')
  expect(redact('password: hunter2hunter2')).toBe('password: [REDACTED]')
  const { markdown } = buildContinuation(data({ userRequests: ['use token=ghp_abcdefghijklmnopqrstuvwxyz0123'] }), '/s', 10000)
  expect(markdown.includes('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(false)
})

test('the resume prompt names its rollover so the continuation can be attached', () => {
  expect(rolloverIdIn(resumePrompt('g2-sessB000-xyz', 2, '/p'))).toBe('g2-sessB000-xyz')
  expect(rolloverIdIn('an ordinary prompt')).toBeNull()
})

// ─── the durable record ─────────────────────────────────────────────────────

const snapshotOf = (rolloverId: string, createdAt: number, kind: 'draft' | 'final' = 'final') =>
  seal({ rolloverId, kind, generation: 1, createdAt, fromSessionId: 'sessA000', project: 'C:/work/game', markdown: `# ${rolloverId}`, data: data({ rolloverId }) })

test('a snapshot round-trips, and any change to it fails its checksum', () => {
  const s = snapshotOf('g1-a', 1000)
  expect(parseSnapshot(JSON.stringify(s))?.rolloverId).toBe('g1-a')
  expect(parseSnapshot(JSON.stringify({ ...s, markdown: '# tampered' }))).toBeNull()
  expect(parseSnapshot(JSON.stringify(s).slice(0, 200))).toBeNull()
  expect(checksum('abc')).toBe(checksum('abc'))
  expect(checksum('abc') === checksum('abd')).toBe(false)
})

test('snapshots are new files, verified after writing; nothing is ever overwritten', async () => {
  const fs = memoryFs()
  const first = await writeSnapshot(fs, '/r', snapshotOf('g1-a', 1000, 'draft'))
  const second = await writeSnapshot(fs, '/r', snapshotOf('g1-a', 2000, 'final'))
  expect(first === second).toBe(false)
  expect(fs.files.has(first)).toBe(true)
  expect(fs.files.get(second.replace(/\.json$/, '.md'))).toBe('# g1-a')
  expect((await findSnapshot(fs, '/r', 'g1-a'))?.snapshot.kind).toBe('final')
})

test('a write that does not verify rejects', async () => {
  const fs = memoryFs()
  const torn: FilePort = { ...fs, write: async (path, text) => fs.write(path, text.slice(0, 50)) }
  let message = ''
  await writeSnapshot(torn, '/r', snapshotOf('g1-a', 1000)).catch(err => {
    message = String(err)
  })
  expect(message).toContain('did not verify')
})

test('the newest valid unclaimed final snapshot is pending; a corrupted newest falls back', async () => {
  const fs = memoryFs()
  await writeSnapshot(fs, '/r', snapshotOf('g1-old', 1000))
  const newest = await writeSnapshot(fs, '/r', snapshotOf('g1-new', 2000))
  fs.files.set(newest, '{"corrupted": true')
  expect((await findPending(fs, '/r', 3000, 1e9))?.snapshot.rolloverId).toBe('g1-old')
  // Too old to offer.
  expect(await findPending(fs, '/r', 1e9, 1000)).toBeNull()
})

test('a rollover is claimed once: a second session cannot restore it again', async () => {
  const fs = memoryFs()
  await writeSnapshot(fs, '/r', snapshotOf('g1-a', 1000))
  const settle = async () => undefined
  expect(await claim(fs, '/r', 'g1-a', 'sessB', 2000, settle)).toBe(true)
  expect(await claim(fs, '/r', 'g1-a', 'sessB', 2001, settle)).toBe(true)
  expect(await claim(fs, '/r', 'g1-a', 'sessX', 2002, settle)).toBe(false)
  expect(await findPending(fs, '/r', 3000, 1e9)).toBeNull()
})

test('of two sessions racing for one claim, only the last writer believes it won', async () => {
  const fs = memoryFs()
  let raceIn: () => Promise<void> = async () => undefined
  const settleA = () => raceIn()
  raceIn = async () => {
    // B writes its claim while A waits to read back.
    await fs.write('/r/claims/g1-a.json', JSON.stringify({ rolloverId: 'g1-a', claimedBy: 'sessB', at: 1 }))
  }
  expect(await claim(fs, '/r', 'g1-a', 'sessA', 1, settleA)).toBe(false)
})

test('the record lives under ~/.claude by default, or where configured', () => {
  expect(rootFor('', 'C:\\work\\game', 'C:\\Users\\me')).toBe('C:/Users/me/.claude/context-rollover/C--work-game')
  expect(rootFor('.rollover', '/home/me/game', '/home/me')).toBe('/home/me/game/.rollover/home-me-game')
  expect(rootFor('D:/keep', 'C:/work/game', null)).toBe('D:/keep/C--work-game')
})
