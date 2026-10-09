/**
 * The lifecycle end to end, on a simulated process (tests/world.ts). These are
 * simulations: they exercise every decision the mod makes against the engine's
 * documented behaviour; they are not a real Claude Code session transition.
 */

import { expect, test } from 'claude-code/testing'

import { DRAIN_MESSAGE, HOLD_AGENTS_MESSAGE } from '../hooks/lib/rollover'
import type { Rollover } from '../hooks/lib/rollover'
import { conversation, fiveAgents, World } from './world'

let turns = 0

/** One main-loop turn: each reading is one response's usage, mid-turn. */
const turn = async (r: Rollover, w: World, readings: readonly number[]): Promise<void> => {
  turns += 1
  await r.onTurnStart(`turn-${turns}`)
  for (const tokens of readings) {
    w.tokens = tokens
    await r.observe(tokens, null, 'turn.step')
  }
  await r.onTurnEnd()
  await r.settled()
}

const phaseOf = (w: World): string => w.status?.phase ?? 'none'

test('below the soft limit it only monitors: no notes, no files, no gate', async () => {
  const w = new World()
  const r = w.rollover()
  await r.start()
  await turn(r, w, [50000, 120000, 179999])
  expect(phaseOf(w)).toBe('monitoring')
  expect(w.status?.context.tokens).toBe(179999)
  expect(w.status?.context.source).toBe('turn.step')
  expect(w.notes).toEqual([])
  expect(w.snapshotNames()).toEqual([])
  expect(await r.gate('Agent', true)).toBeNull()
})

test('soft, then prepare, then the turn end: each threshold acts once, in order', async () => {
  const w = new World()
  w.messages = conversation()
  const r = w.rollover()
  await r.start()

  await r.onTurnStart('t1')
  await r.observe(181000, null, 'turn.step')
  expect(phaseOf(w)).toBe('preparing')
  await r.observe(185000, null, 'turn.step')
  expect(w.notes).toHaveLength(1)

  await r.observe(191000, null, 'turn.step')
  expect(phaseOf(w)).toBe('ready')
  expect(w.notes).toHaveLength(2)
  // New agents are held from the prepare limit; other work goes on until the turn ends.
  expect(await r.gate('Agent', true)).toBe(HOLD_AGENTS_MESSAGE)
  expect(await r.gate('Bash', true)).toBeNull()
  await r.settled()
  expect(w.snapshotNames().some(name => name.endsWith('-draft.json'))).toBe(true)
  expect(w.status?.continuation.status).toBe('draft')

  await r.onTurnEnd()
  await r.settled()
  expect(w.clears).toBe(1)
  expect(phaseOf(w)).toBe('resuming')
})

test('configured thresholds are the ones used', async () => {
  const w = new World()
  const r = w.rollover({ softLimit: 50000, prepareLimit: 60000, hardLimit: 70000 })
  await r.start()
  await r.onTurnStart('t')
  await r.observe(55000, null, 'turn.step')
  expect(phaseOf(w)).toBe('preparing')
  expect(w.status?.thresholds).toEqual({ soft: 50000, prepare: 60000, hard: 70000 })
})

test('a small model window pulls the thresholds down so the hard limit keeps a margin', async () => {
  const w = new World()
  w.window = 200000
  const r = w.rollover()
  await r.start()
  expect(w.status?.thresholds.hard).toBe(180000)
  await r.onTurnStart('t')
  await r.observe(171000, 200000, 'session.measure')
  expect(phaseOf(w)).toBe('ready')
})

test('the hard limit mid-turn drains: main-loop tools are refused, task tools allowed, agents go on', async () => {
  const w = new World()
  const r = w.rollover()
  await r.start()
  await r.onTurnStart('t-hard')
  await r.observe(201000, null, 'turn.step')
  expect(phaseOf(w)).toBe('draining')
  expect(await r.gate('Bash', true)).toBe(DRAIN_MESSAGE)
  expect(await r.gate('TaskUpdate', true)).toBeNull()
  expect(await r.gate('Edit', false)).toBeNull()
  expect(await r.gate('Agent', false)).toBe(HOLD_AGENTS_MESSAGE)
  await r.onTurnEnd()
  await r.settled()
  expect(phaseOf(w)).toBe('resuming')
})

test('a turn that will not end is ended after the grace period', async () => {
  const w = new World()
  const r = w.rollover({ rolloverTimeoutMs: 200000 })
  await r.start()
  await r.onTurnStart('t-stuck')
  await r.observe(205000, null, 'turn.step')
  // The grace sleep has already elapsed on the simulated clock.
  await Promise.resolve()
  await Promise.resolve()
  expect(w.aborted).toEqual(['t-stuck'])
})

test('readings that repeat a zone, and triggers that repeat a rollover, do nothing twice', async () => {
  const w = new World()
  w.messages = conversation()
  const r = w.rollover()
  await r.start()
  await r.onTurnStart('t')
  for (const tokens of [181000, 182000, 183000]) await r.observe(tokens, null, 'turn.step')
  expect(w.notes).toHaveLength(1)
  await r.observe(195000, null, 'turn.step')
  await r.settled()
  const drafts = w.snapshotNames().length
  await r.observe(196000, null, 'turn.step')
  await r.settled()
  expect(w.snapshotNames().length).toBe(drafts)

  // Three triggers at once: the turn end, a measurement past the hard limit, /rollover now.
  await r.onTurnEnd()
  const all = Promise.all([r.rollover('duplicate'), r.rollover('another'), r.observe(205000, null, 'session.measure')])
  await all
  await r.settled()
  expect(w.clears).toBe(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.snapshotNames().filter(name => name.endsWith('-final.json'))).toHaveLength(1)
})

test('compaction that drops the context back below the soft limit stands the rollover down', async () => {
  const w = new World()
  const r = w.rollover()
  await r.start()
  await r.onTurnStart('t')
  await r.observe(185000, null, 'turn.step')
  await r.observe(40000, null, 'session.measure')
  expect(phaseOf(w)).toBe('monitoring')
})

test('uncommitted work is recorded, kept by a safety ref, and never reset, cleaned or committed', async () => {
  const w = new World()
  w.messages = conversation()
  const r = w.rollover()
  await r.start()
  await r.rollover('test')
  await r.settled()
  const markdown = await r.contextFor(w.submitted[0] ?? '')
  expect(markdown).toContain('src/engine/physics.ts')
  expect(markdown).toContain('? notes/ideas.md')
  expect(markdown).toContain('refs/context-rollover/')
  expect(w.gitCalls.some(([verb]) => verb === 'commit')).toBe(false)
  expect(w.gitCalls.some(([verb, sub]) => verb === 'stash' && sub === 'create')).toBe(true)
  expect(w.destructiveGitCalls()).toEqual([])
})

test('autoCommit, when switched on, commits on a feature branch and records the commit', async () => {
  const w = new World()
  const r = w.rollover({ autoCommit: true })
  await r.start()
  await r.rollover('test')
  const markdown = await r.contextFor(w.submitted[0] ?? '')
  expect(w.gitCalls.some(([verb]) => verb === 'commit')).toBe(true)
  expect(markdown).toContain('checkpoint commit made for this rollover: `c0ffee1`')
  expect(w.destructiveGitCalls()).toEqual([])
})

test('autoCommit refuses a protected branch and says why', async () => {
  const w = new World()
  w.porcelain = w.porcelain.replace('feat/game', 'main')
  const r = w.rollover({ autoCommit: true })
  await r.start()
  await r.rollover('test')
  expect(w.gitCalls.some(([verb]) => verb === 'commit')).toBe(false)
  expect(await r.contextFor(w.submitted[0] ?? '')).toContain('autoCommit skipped: main is protected')
})

test('five agents: running ones are told to wrap up and waited for; every one is recorded with its role', async () => {
  const w = new World()
  w.messages = conversation()
  w.agents = fiveAgents()
  w.agentRows['ag-physics'] = [{ role: 'assistant', text: 'Physics done: fixed step, tests green.', toolUses: [] }]
  w.agentRows['ag-levels'] = [{ role: 'assistant', text: 'Levels 1-2 done, level 3 in progress.', toolUses: [] }]
  // Levels finishes after a few seconds; audio never does.
  w.onSleep = world => {
    const levels = world.agents.find(one => one.id === 'ag-levels')
    if (levels !== undefined && world.clock > 1_760_000_000_000 + 5000) levels.status = 'completed'
  }
  const r = w.rollover({ agentDrainTimeoutMs: 20000 })
  await r.start()
  expect(w.status?.agents).toEqual({ active: 2, idle: 1, pending: 1, completed: 1, failed: 0, total: 5 })
  await r.rollover('test')

  expect(w.sent.map(one => one.agentId).sort()).toEqual(['ag-audio', 'ag-levels'])
  const markdown = (await r.contextFor(w.submitted[0] ?? '')) ?? ''
  for (const name of ['physics', 'levels', 'audio', 'ui', 'qa']) expect(markdown).toContain(`**${name}**`)
  expect(markdown).toContain('Own src/engine: deterministic physics at 60 Hz.')
  expect(markdown).toContain('Physics done: fixed step, tests green.')
  expect(markdown).toMatch(/\*\*audio\*\* \(general-purpose, running, id `ag-audio`\) → re-dispatch/)
  expect(markdown).toMatch(/\*\*levels\*\* \(general-purpose, completed, id `ag-levels`\) → review-output/)
  expect(markdown).toMatch(/\*\*ui\*\* \(teammate, idle, id `ag-ui`\) → re-dispatch/)
  expect(w.logs.some(one => one.text.includes('still running at the drain deadline'))).toBe(true)
})

test('the record policy rolls over at once, without waiting for agents', async () => {
  const w = new World()
  w.agents = fiveAgents()
  const r = w.rollover({ agentPolicy: 'record' })
  await r.start()
  const before = w.clock
  await r.rollover('test')
  expect(w.sent).toEqual([])
  expect(w.clock - before).toBeLessThan(5000)
})

test('the continuation restores tasks, decisions, next actions and the person’s requests, within its budget', async () => {
  const w = new World()
  w.messages = conversation()
  w.taskList = {
    source: 'TaskList',
    items: [
      { id: '1', subject: 'Finish level 3', status: 'in_progress', owner: 'levels' },
      { id: '2', subject: 'Scoring UI', status: 'pending', owner: 'ui', blockedBy: ['1'] },
      { id: '3', subject: 'Physics engine', status: 'completed', owner: 'physics' },
    ],
  }
  const r = w.rollover()
  await r.start()
  await r.rollover('test')
  const markdown = (await r.contextFor(w.submitted[0] ?? '')) ?? ''
  expect(markdown).toContain('[~] #1 Finish level 3 — owner: levels')
  expect(markdown).toContain('[ ] #2 Scoring UI — owner: ui — blocked by 1')
  expect(markdown).toContain('fixed 60 Hz physics step')
  expect(markdown).toContain('1. Run the physics tests')
  expect(markdown).toContain('Prioritise level 3 over audio polish.')
  expect(markdown).toContain('Collision tunnelling')
  expect(w.status?.continuation.approxTokens ?? 99999).toBeLessThanOrEqual(10000)
})

test('without a usable model summary the rollover still persists the structured state', async () => {
  const w = new World()
  w.messages = conversation()
  w.forkReply = { isAnswered: false, reason: 'api-error' }
  const r = w.rollover()
  await r.start()
  await r.rollover('test')
  const markdown = (await r.contextFor(w.submitted[0] ?? '')) ?? ''
  expect(markdown).toContain('No model summary: the summary request failed (api-error)')
  expect(markdown).toContain('Level 3')
  expect(phaseOf(w)).toBe('resuming')
})

test('a /clear that fails is retried with backoff, then succeeds', async () => {
  const w = new World()
  w.clearBehaviour = 'fail'
  w.clearFailuresLeft = 2
  const r = w.rollover({ maxRetries: 3 })
  await r.start()
  await r.rollover('test')
  expect(w.clears).toBe(3)
  expect(phaseOf(w)).toBe('resuming')
  // Persisted once; retries reuse the same snapshot.
  expect(w.snapshotNames().filter(name => name.endsWith('-final.json'))).toHaveLength(1)
})

test('a replacement session that never starts leaves the continuation safe, the gate lifted, and the way back offered', async () => {
  const w = new World()
  w.clearBehaviour = 'noop'
  const r = w.rollover({ maxRetries: 1 })
  await r.start()
  await r.onTurnStart('t')
  await r.observe(201000, null, 'turn.step')
  await r.onTurnEnd()
  await r.settled()
  expect(phaseOf(w)).toBe('awaiting-restart')
  expect(w.status?.continuation.status).toBe('persisted')
  expect(w.status?.last?.outcome).toBe('failed')
  expect(w.status?.error?.message).toContain('did not start a new session')
  expect(await r.gate('Bash', true)).toBeNull()
  expect(w.filled).toContain('/clear')

  // The person runs /clear: the saved continuation is restored without asking again.
  w.clearBehaviour = 'ok'
  const fresh = w.newSession()
  await r.onCleared(fresh)
  expect(phaseOf(w)).toBe('resuming')
  expect(w.submitted).toHaveLength(1)
})

test('a /clear that hangs times out, and the attempt is retried', async () => {
  const w = new World()
  w.clearBehaviour = 'hang'
  const r = w.rollover({ maxRetries: 0, rolloverTimeoutMs: 60000 })
  await r.start()
  const running = r.rollover('test')
  for (let i = 0; i < 10000 && w.clears === 0; i += 1) await Promise.resolve()
  expect(w.clears).toBe(1)
  w.advance(60001)
  await running
  expect(phaseOf(w)).toBe('awaiting-restart')
  expect(w.status?.error?.message).toContain('timed out')
})

test('a submit that fails is retried; a session already changed is not cleared twice', async () => {
  const w = new World()
  w.submitBehaviour = 'fail'
  const r = w.rollover({ maxRetries: 2 })
  await r.start()
  const running = r.rollover('test')
  w.onSleep = world => {
    world.submitBehaviour = 'ok'
  }
  await running
  expect(w.clears).toBe(1)
  expect(w.submitted).toHaveLength(1)
  expect(phaseOf(w)).toBe('resuming')
})

test('manual restart persists and waits; the person’s /clear resumes', async () => {
  const w = new World()
  const r = w.rollover({ automaticRestart: false })
  await r.start()
  await r.rollover('test')
  expect(w.clears).toBe(0)
  expect(phaseOf(w)).toBe('awaiting-restart')
  expect(w.status?.operation).toContain('/clear')
  await r.onCleared(w.newSession())
  expect(phaseOf(w)).toBe('resuming')
})

test('a plain /clear with nothing pending starts a new chain', async () => {
  const w = new World()
  const r = w.rollover()
  await r.start()
  await r.onTurnStart('t')
  await r.observe(150000, null, 'turn.step')
  await r.onCleared(w.newSession())
  expect(phaseOf(w)).toBe('monitoring')
  expect(w.status?.context.tokens).toBeNull()
  expect(w.status?.generation).toBe(0)
  expect(w.submitted).toEqual([])
})

test('new-terminal mode hands off and exits; with no terminal it falls back to /clear', async () => {
  const w = new World()
  w.canLaunch = true
  const r = w.rollover({ restartMode: 'new-terminal' })
  await r.start()
  await r.rollover('test')
  expect(w.launches[0]).toMatch(/^claude "\/rollover resume g1-sessA000-/)
  expect(w.exits).toBe(1)
  expect(w.clears).toBe(0)

  const v = new World()
  const fallback = v.rollover({ restartMode: 'new-terminal' })
  await fallback.start()
  await fallback.rollover('test')
  expect(v.exits).toBe(0)
  expect(v.clears).toBe(1)
})

test('a process killed mid-rollover is reported, and its saved continuation offered to the next session', async () => {
  const w = new World()
  w.messages = conversation()
  const r = w.rollover({ automaticRestart: false })
  await r.start()
  await r.rollover('test')
  const saved = w.status?.continuation.rolloverId ?? ''
  // The terminal is closed: a new process, a new session, the same disk.
  w.clock += 120000
  w.restartProcess()
  const next = w.rollover()
  await next.start()
  expect(w.status?.continuation.status).toBe('pending')
  expect(w.filled.at(-1)).toBe(`/rollover resume ${saved}`)
  expect(await next.resume(saved)).toBe(`Restoring ${saved}.`)
  expect(phaseOf(w)).toBe('resuming')
  // Restored once: a third session is not offered it again.
  w.restartProcess()
  const third = w.rollover({ resumeOnStartup: 'auto' })
  await third.start()
  expect(w.status?.continuation.status).toBe('none')
})

test('a rollover that died while persisting is marked interrupted for the next session', async () => {
  const w = new World()
  const r = w.rollover()
  await r.start()
  // Simulate a journal left by a session that died while persisting.
  const root = 'C:/Users/me/.claude/context-rollover/C--work-game'
  w.files.set(`${root}/sessions/sessZ.json`, JSON.stringify({ sessionId: 'sessZ', phase: 'persisting', rolloverId: 'g1-sessZ-1', generation: 0, toSessionId: null, error: null, updatedAt: w.clock - 600000 }))
  w.restartProcess()
  await w.rollover().start()
  expect(w.status?.last?.outcome).toBe('interrupted')
  expect(w.status?.last?.detail).toBe('stopped while persisting')
})

test('missing and corrupted continuation files are survived', async () => {
  const w = new World()
  const r = w.rollover()
  await r.start()
  expect(await r.resume()).toBe('No continuation is waiting.')
  expect(await r.resume('g9-nothing')).toBe('No valid snapshot of g9-nothing was found.')
  const root = 'C:/Users/me/.claude/context-rollover/C--work-game'
  w.files.set(`${root}/snapshots/00001760000000000-g1-bad-final.json`, '{"truncated":')
  w.restartProcess()
  await w.rollover().start()
  expect(w.status?.continuation.status).toBe('none')
})

test('a module reload mid-rollover carries on with the same rollover id', async () => {
  const w = new World()
  const r = w.rollover({ automaticRestart: false })
  await r.start()
  await r.rollover('test')
  const id = w.status?.continuation.rolloverId
  // Pretend the reload struck while persisting.
  if (w.status !== null) w.status = { ...w.status, phase: 'persisting' }
  const reloaded = w.rollover()
  await reloaded.start()
  await reloaded.settled()
  expect(w.status?.continuation.rolloverId).toBe(id)
  expect(w.snapshotNames().filter(name => name.endsWith('-final.json'))).toHaveLength(1)
  expect(phaseOf(w)).toBe('resuming')
})

test('disabled, it observes but never acts', async () => {
  const w = new World()
  const r = w.rollover({ enabled: false })
  await r.start()
  expect(phaseOf(w)).toBe('disabled')
  await turn(r, w, [250000])
  expect(phaseOf(w)).toBe('disabled')
  expect(w.status?.context.tokens).toBe(250000)
  expect(w.clears).toBe(0)
  expect(await r.gate('Agent', true)).toBeNull()
})

test('Session A → threshold → persisted → A ended → B started → restored → work resumed → rollover → C', async () => {
  const w = new World()
  w.messages = conversation()
  w.agents = fiveAgents().map(one => ({ ...one, status: 'completed' as const }))
  const r = w.rollover()
  await r.start()
  const sessionA = w.sessionId

  // Session A works up to the prepare limit; the rollover runs at the turn end.
  await turn(r, w, [120000, 170000, 186000, 193000])
  const first = w.status?.continuation.rolloverId ?? ''
  const sessionB = w.sessionId
  expect(sessionB === sessionA).toBe(false)
  expect(w.status?.sessionId).toBe(sessionB)
  expect(w.status?.generation).toBe(1)
  expect(w.status?.last).toMatchObject({ outcome: 'success', fromSessionId: sessionA, toSessionId: sessionB, finalTokens: 193000 })
  // B is genuinely fresh: no transcript, no agents, and context reset.
  expect(w.messages).toEqual([])
  expect(w.status?.context.tokens).toBeNull()
  // B was started with the short prompt; the continuation rides as context.
  expect(w.submitted[0]).toContain(`rollover ${first} (generation 1)`)
  const restored = (await r.contextFor(w.submitted[0] ?? '')) ?? ''
  expect(restored).toContain('Build the robotics game with five agents')
  expect(phaseOf(w)).toBe('resuming')
  expect(w.status?.continuation.status).toBe('restored')

  // B resumes: its first turn completes the transition.
  w.messages = [{ role: 'user', text: w.submitted[0] ?? '', toolUses: [] }]
  await turn(r, w, [12000, 30000])
  expect(phaseOf(w)).toBe('completed')
  expect(w.status?.operation).toBe('Monitoring context usage')
  await turn(r, w, [60000])
  expect(phaseOf(w)).toBe('monitoring')

  // B grows to the hard limit mid-turn: drained, rolled over to C.
  w.messages.push({ role: 'user', text: 'Now add a boss level.', toolUses: [] })
  await r.onTurnStart('b-long')
  for (const tokens of [150000, 185000, 192000, 204000]) {
    w.tokens = tokens
    await r.observe(tokens, null, 'turn.step')
  }
  expect(phaseOf(w)).toBe('draining')
  await r.onTurnEnd()
  await r.settled()
  const sessionC = w.sessionId
  expect(new Set([sessionA, sessionB, sessionC]).size).toBe(3)
  expect(w.status?.generation).toBe(2)
  expect(w.status?.last).toMatchObject({ outcome: 'success', fromSessionId: sessionB, toSessionId: sessionC })
  const second = (await r.contextFor(w.submitted[1] ?? '')) ?? ''
  expect(second).toContain(`Generation 2 (after ${first})`)
  // The objective and decisions survive two generations; the new request is there too.
  expect(second).toContain('Build the robotics game with five agents')
  expect(second).toContain('fixed 60 Hz physics step')
  expect(second).toContain('Now add a boss level.')
  expect(w.clears).toBe(2)
  expect(w.destructiveGitCalls()).toEqual([])

  // C completes; the chain keeps monitoring.
  await turn(r, w, [15000])
  expect(phaseOf(w)).toBe('completed')
})

test('limits below a fresh session’s own size stop after one rollover instead of looping', async () => {
  const w = new World()
  const r = w.rollover({ softLimit: 1000, prepareLimit: 2000, hardLimit: 3000 })
  await r.start()
  await turn(r, w, [25000])
  expect(w.clears).toBe(1)
  // The fresh session's first response is already 22k: past every limit.
  await turn(r, w, [22000])
  expect(phaseOf(w)).toBe('failed')
  expect(w.status?.error?.message).toContain('rolling over again would not help')
  await turn(r, w, [23000])
  await turn(r, w, [24000])
  expect(w.clears).toBe(1)
  expect(await r.gate('Bash', true)).toBeNull()
})

test('the fresh session reads the continuation first, then the short prompt that starts it', async () => {
  const w = new World()
  w.messages = conversation()
  const r = w.rollover()
  await r.start()
  await r.rollover('test')
  const at = w.modelSaw.findIndex(one => one.startsWith('# Context rollover continuation'))
  const prompt = w.modelSaw.findIndex(one => one.startsWith('[context-rollover] Fresh session'))
  expect(at).toBeGreaterThan(-1)
  expect(prompt).toBe(at + 1)
  expect(w.submitted[0]?.length ?? 0).toBeLessThan(600)
  expect(w.submitted[0]).toMatch(/Readable copy, if ever needed: .*-final\.md$/)
})

test('where the continuation row is refused, it rides in the prompt instead', async () => {
  const w = new World()
  w.appendBehaviour = 'fail'
  const r = w.rollover()
  await r.start()
  await r.rollover('test')
  expect(w.submitted[0]).toContain('## Resume protocol')
  expect(phaseOf(w)).toBe('resuming')
})

test('a resumed session that reads files in its first turn is not mistaken for one too large to continue', async () => {
  const w = new World()
  const r = w.rollover({ softLimit: 30000, prepareLimit: 32000, hardLimit: 34000 })
  await r.start()
  await turn(r, w, [26000, 44000])
  // Its first response is 17k; reading the record pushes it to 67k by the turn end.
  await turn(r, w, [17000, 48000, 67000])
  expect(phaseOf(w)).toBe('completed')
})
