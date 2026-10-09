/**
 * The rollover lifecycle: one deep module behind a narrow port. It decides when to
 * prepare, when to roll over, what to persist, how to start the fresh session and how
 * to recover; the port is everything it needs from the outside world, so the whole
 * lifecycle runs in a test with fakes, and `register.ts` only adapts `$` to the port.
 *
 *   monitoring ─soft→ preparing ─prepare→ ready ─turn ends─→ persisting → restarting → resuming → completed → monitoring
 *                                              └─hard mid-turn→ draining ─turn ends─┘
 *
 * Every step checks whether it already happened (a snapshot on disk, a session id that
 * already changed, a claim already held), so a retry, a module reload or a second
 * trigger resumes the same rollover instead of starting a competing one.
 */

import type { AgentCounts, RolloverError, RolloverOutcome, RolloverPhase, RolloverStatus, TaskCounts } from '../../types'
import { countAgents, recordAgents, stillWorking, WRAP_UP_MESSAGE } from './agents'
import type { AgentSeen } from './agents'
import type { Config, LogLevel } from './config'
import { buildContinuation, cut, resumePrompt, rolloverIdIn } from './continuation'
import type { ContinuationData, TaskItem, TaskList } from './continuation'
import { BUSY, initialStatus } from './contract'
import { commitDecision, IN_PROGRESS_MARKERS, parsePorcelain, safetyRefName } from './git'
import type { GitState } from './git'
import { claim, findPending, findSnapshot, readJournals, seal, snapshotName, writeJournal, writeSnapshot } from './store'
import type { FilePort, Snapshot } from './store'
import { parseSummary, SUMMARY_PROMPT } from './summary'
import type { Summary } from './summary'
import { effectiveThresholds, zoneOf } from './thresholds'
import type { Thresholds } from './thresholds'
import { agentCalls, filesWritten, lastAnswer, lastTodos, recentErrors, userRequests } from './transcript'
import type { MessageSeen } from './transcript'

export type ContextSource = 'turn.step' | 'session.measure' | 'session.usage'

/** Everything the lifecycle needs from outside. Each call may reject; the lifecycle copes. */
export type Port = {
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** Calls `fn` once after `ms` unless the returned cancel runs first. */
  timer: (ms: number, fn: () => void) => () => void
  fs: FilePort
  /** Where this project's record lives (resolved once by the adapter). */
  root: () => Promise<string>
  readStatus: () => Promise<RolloverStatus | null>
  writeStatus: (change: (prev: RolloverStatus) => RolloverStatus) => Promise<void>
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  usage: () => Promise<{ tokens: number | null; window: number | null }>
  agents: () => Promise<AgentSeen[] | null>
  agentMessages: (agentId: string) => Promise<MessageSeen[] | null>
  messages: () => Promise<MessageSeen[]>
  taskList: () => Promise<TaskList | null>
  /** git with the given arguments, in the project; never throws, exitCode -1 when it could not run. */
  git: (args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>
  fork: (prompt: string) => Promise<{ isAnswered: boolean; text?: string; reason?: string }>
  sendToAgent: (agentId: string, text: string) => Promise<void>
  /** A user-role row the model reads and the person does not see as typed. */
  noteToModel: (text: string) => Promise<void>
  /** /clear: the conversation ends, the process goes on under a new session id. */
  clear: () => Promise<void>
  submit: (text: string) => Promise<void>
  launchTerminal: (command: string, cwd: string) => Promise<boolean>
  exit: () => Promise<void>
  abortTurn: (turnId: string) => Promise<void>
  fillPrompt: (text: string) => Promise<void>
  toast: (text: string) => void
  log: (level: LogLevel, text: string, toTranscript: boolean) => void
}

/** Tools the model may still use while a rollover drains: the ones that record state. */
export const ALLOWED_WHILE_DRAINING: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

export const DRAIN_MESSAGE =
  'Context rollover in progress: the context limit has been reached. Do not call more tools. End your turn now with a short status of what you were doing; the work continues automatically in a fresh session with the project state restored.'

export const HOLD_AGENTS_MESSAGE =
  'Context rollover is imminent: do not start new agents now. Record the task (TaskCreate or TodoWrite) so the fresh session dispatches it.'

const SETTLE_MS = 400
const NEW_SESSION_WAIT_MS = 15000
const AGENT_POLL_MS = 3000

type Counter = { pending: number; inProgress: number; completed: number }

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Run `work`, or reject with `timed out` once the port's timer for `ms` fires. */
const within = async <T>(port: Port, ms: number, work: Promise<T>): Promise<T> => {
  let cancel = (): void => undefined
  const timer = new Promise<never>((_, reject) => {
    cancel = port.timer(ms, () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)))
  })
  try {
    return await Promise.race([work, timer])
  } finally {
    cancel()
  }
}

export class Rollover {
  private config: Config
  private configWarnings: string[]
  private inFlight: Promise<void> | null = null
  private turnId: string | null = null
  private isTurnRunning = false
  private notified = new Set<string>()
  private draft: Promise<void> | null = null
  /** Continuations handed to a fresh session, by rollover id, so `contextFor` need not read the disk. */
  private handed = new Map<string, string>()
  /** Tasks the TaskCreate/TaskUpdate calls of this session have built, by id. */
  private tasks = new Map<string, TaskItem>()
  private todos: TaskItem[] | null = null
  /** The resumed session's first reading: its size before it did any work. */
  private baseline: number | null = null

  constructor(
    private readonly port: Port,
    config: Config,
    warnings: readonly string[] = [],
  ) {
    this.config = config
    this.configWarnings = [...warnings]
  }

  setConfig(config: Config, warnings: readonly string[]): void {
    this.config = config
    this.configWarnings = [...warnings]
  }

  get settings(): Config {
    return this.config
  }

  private log(level: LogLevel, text: string, toTranscript = false): void {
    this.port.log(level, text, toTranscript)
  }

  private async patch(change: Partial<RolloverStatus> | ((prev: RolloverStatus) => Partial<RolloverStatus>)): Promise<void> {
    const now = await this.port.now()
    await this.port.writeStatus(prev => ({
      ...prev,
      ...(typeof change === 'function' ? change(prev) : change),
      updatedAt: now,
      heartbeatAt: now,
    }))
  }

  private async status(): Promise<RolloverStatus> {
    const now = await this.port.now()

    return (await this.port.readStatus()) ?? initialStatus(this.configured(), now)
  }

  private configured(): Thresholds {
    return { soft: this.config.softLimit, prepare: this.config.prepareLimit, hard: this.config.hardLimit }
  }

  private thresholdsFor(window: number | null): Thresholds {
    return effectiveThresholds(this.configured(), window)
  }

  private async journal(sessionId: string, phase: string, rolloverId: string | null, generation: number, toSessionId: string | null, error: string | null = null): Promise<void> {
    try {
      await writeJournal(this.port.fs, await this.port.root(), { sessionId, phase, rolloverId, generation, toSessionId, error, updatedAt: await this.port.now() })
    } catch (err) {
      this.log('warn', `journal not written: ${errorText(err)}`)
    }
  }

  // ─── start and recovery ────────────────────────────────────────────────────

  /**
   * At every load: a fresh process, or a reload of this module mid-session. A reload
   * keeps the state the host holds; a rollover it interrupted is picked up again.
   */
  async start(): Promise<void> {
    const [sessionId, held, usage, now] = await Promise.all([
      this.port.sessionId().catch(() => ''),
      this.port.readStatus().catch(() => null),
      this.port.usage().catch(() => ({ tokens: null, window: null })),
      this.port.now(),
    ])
    const thresholds = this.thresholdsFor(usage.window)
    const isReload = held !== null && held.sessionId === sessionId
    const warning = this.configWarnings.length > 0 ? this.configWarnings.join('; ') : null

    await this.port.writeStatus(prev => {
      const base = isReload ? prev : { ...initialStatus(thresholds, now), last: held?.last ?? null }
      const phase: RolloverPhase = !this.config.enabled ? 'disabled' : base.phase === 'disabled' ? 'monitoring' : base.phase

      return {
        ...base,
        sessionId: sessionId === '' ? null : sessionId,
        enabled: this.config.enabled,
        phase,
        thresholds,
        context: usage.tokens === null && isReload ? base.context : { tokens: usage.tokens, window: usage.window, measuredAt: usage.tokens === null ? null : now, source: usage.tokens === null ? null : 'session.usage' },
        restart: { mode: this.config.restartMode, isAutomatic: this.config.automaticRestart },
        operation: phase === 'disabled' ? 'Disabled by configuration' : base.operation,
        error: warning === null ? (isReload ? base.error : null) : { message: `config: ${warning}`, at: now, isRetriable: false },
        heartbeatAt: now,
        updatedAt: now,
      }
    })
    await this.refreshAgents()
    if (!this.config.enabled) return

    if (isReload) {
      // A reload dropped the work in flight; the same rollover carries on.
      if (held !== null && (held.phase === 'draining' || held.phase === 'persisting' || held.phase === 'restarting') && held.continuation.rolloverId !== null) {
        this.log('info', `resuming rollover ${held.continuation.rolloverId} after a reload`)
        void this.rollover('reload')
      }
      return
    }

    await this.recover(sessionId)
  }

  /** A fresh process: is there a continuation nobody restored, or a rollover that died? */
  private async recover(sessionId: string): Promise<void> {
    let root: string
    try {
      root = await this.port.root()
    } catch {
      return
    }
    const now = await this.port.now()
    const journals = await readJournals(this.port.fs, root).catch(() => [])
    const died = journals.find(j => j.sessionId !== sessionId && ['draining', 'persisting', 'restarting', 'resuming'].includes(j.phase) && now - j.updatedAt > 60000)
    if (died !== undefined && died.rolloverId !== null) {
      const last: RolloverOutcome = {
        outcome: 'interrupted',
        rolloverId: died.rolloverId,
        at: died.updatedAt,
        fromSessionId: died.sessionId,
        toSessionId: died.toSessionId,
        finalTokens: null,
        detail: `stopped while ${died.phase}`,
      }
      await this.patch({ last })
      await this.journal(died.sessionId, 'interrupted', died.rolloverId, 0, died.toSessionId, `stopped while ${died.phase}`)
    }

    const pending = await findPending(this.port.fs, root, now, this.config.staleAfterHours * 3600000).catch(() => null)
    if (pending === null || pending.snapshot.fromSessionId === sessionId) return
    const { snapshot, path } = pending
    await this.patch({
      continuation: { status: 'pending', path, rolloverId: snapshot.rolloverId, bytes: snapshot.markdown.length, approxTokens: null, updatedAt: snapshot.createdAt },
      operation: this.config.resumeOnStartup === 'off' ? `Continuation ${snapshot.rolloverId} waiting — /rollover resume` : `Restoring continuation ${snapshot.rolloverId}`,
    })
    if (this.config.resumeOnStartup === 'auto') {
      await this.resume(snapshot.rolloverId)
    } else if (this.config.resumeOnStartup === 'ask') {
      await this.port.fillPrompt(`/rollover resume ${snapshot.rolloverId}`).catch(() => undefined)
      this.port.toast(`A rollover continuation (${snapshot.rolloverId}) was never restored — press Enter to restore it`)
    }
  }

  // ─── observing ─────────────────────────────────────────────────────────────

  async refreshAgents(): Promise<AgentCounts | null> {
    const agents = await this.port.agents().catch(() => null)
    const counts = agents === null ? null : countAgents(agents)
    const held = await this.port.readStatus().catch(() => null)
    if (held === null || JSON.stringify(held.agents) !== JSON.stringify(counts)) await this.patch({ agents: counts })

    return counts
  }

  async heartbeat(): Promise<void> {
    const now = await this.port.now()
    await this.port.writeStatus(prev => ({ ...prev, heartbeatAt: now }))
  }

  /** A tool call finished: keep the task counts from the task tools' own payloads. */
  async onToolResult(tool: string, input: Readonly<Record<string, unknown>>, result: unknown): Promise<void> {
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todos = lastTodos([{ role: 'assistant', text: '', toolUses: [{ tool, input }] }])?.items.slice() ?? null
    } else if (tool === 'TaskCreate') {
      const task = (result as { task?: { id?: unknown; subject?: unknown } } | null)?.task
      if (typeof task?.id === 'string') this.tasks.set(task.id, { id: task.id, subject: String(task.subject ?? input.subject ?? ''), status: 'pending' })
    } else if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
      const was = this.tasks.get(input.taskId) ?? { id: input.taskId, subject: String(input.subject ?? input.taskId), status: 'pending' as const }
      if (input.status === 'deleted') this.tasks.delete(input.taskId)
      else {
        this.tasks.set(input.taskId, {
          ...was,
          ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
          ...(input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed' ? { status: input.status } : {}),
          ...(typeof input.owner === 'string' ? { owner: input.owner } : {}),
        })
      }
    } else return
    await this.patch({ tasks: this.taskCounts() })
  }

  private taskCounts(): TaskCounts | null {
    const fromTasks = [...this.tasks.values()]
    const items = fromTasks.length > 0 ? fromTasks : this.todos
    if (items === null) return null
    const c: Counter = { pending: 0, inProgress: 0, completed: 0 }
    for (const one of items) {
      if (one.status === 'completed') c.completed += 1
      else if (one.status === 'in_progress') c.inProgress += 1
      else c.pending += 1
    }

    return { ...c, total: items.length, source: fromTasks.length > 0 ? 'TaskList' : 'TodoWrite' }
  }

  onTurnStart(turnId: string): Promise<void> {
    this.turnId = turnId
    this.isTurnRunning = true

    return this.patch(prev => (prev.phase === 'completed' ? { phase: 'monitoring', operation: 'Monitoring context usage' } : {}))
  }

  /**
   * A context reading from the engine. Only phase changes write anything beyond the
   * reading, and each change acts once: a reading that repeats a zone does nothing.
   */
  async observe(tokens: number | null, window: number | null, source: ContextSource): Promise<void> {
    const now = await this.port.now()
    const before = await this.status()
    const thresholds = this.thresholdsFor(window ?? before.context.window)
    await this.patch({ context: { tokens, window: window ?? before.context.window, measuredAt: now, source }, thresholds })
    if (before.phase === 'resuming' && this.baseline === null && tokens !== null) this.baseline = tokens
    if (!this.config.enabled || tokens === null) return

    const phase = before.phase
    if (BUSY.has(phase) || phase === 'awaiting-restart' || phase === 'disabled') return
    const zone = zoneOf(tokens, thresholds)
    const sessionId = before.sessionId ?? ''

    if (zone === 'below') {
      if (phase === 'preparing' || phase === 'ready') await this.patch({ phase: 'monitoring', operation: 'Monitoring context usage', continuation: { ...before.continuation, status: before.continuation.status === 'draft' ? 'none' : before.continuation.status } })
      return
    }
    if (phase === 'failed') return

    if (zone === 'soft' && phase !== 'preparing') {
      if (phase === 'ready') return
      await this.patch({ phase: 'preparing', operation: `Preparing: rollover at ${Math.round(thresholds.prepare / 1000)}k–${Math.round(thresholds.hard / 1000)}k` })
      await this.tellModel(`soft:${sessionId}`, `[context-rollover] Context is at ${Math.round(tokens / 1000)}k tokens; this session will roll over to a fresh one between turns once it passes ${Math.round(thresholds.prepare / 1000)}k (at the latest ${Math.round(thresholds.hard / 1000)}k). Keep the task list current (TaskUpdate/TodoWrite), finish steps cleanly, and prefer not to start large new subtasks. No need to reply to this note.`)
      return
    }
    if (zone === 'prepare' && phase !== 'ready') {
      await this.patch({ phase: 'ready', operation: this.isTurnRunning ? 'Ready: rollover when this turn ends' : 'Ready: rollover at the next turn end' })
      await this.tellModel(`prepare:${sessionId}`, `[context-rollover] Context is at ${Math.round(tokens / 1000)}k tokens. The session rolls over to a fresh one as soon as this turn ends. Wrap up the current step, record remaining work in the task list, and do not start new agents. No need to reply to this note.`)
      this.saveDraft()
      if (!this.isTurnRunning) void this.rollover('prepare limit between turns')
      return
    }
    if (zone === 'hard') {
      if (this.isTurnRunning) await this.startDrain(tokens)
      else void this.rollover('hard limit')
    }
  }

  private async tellModel(key: string, text: string): Promise<void> {
    if (!this.config.notifyModel || this.notified.has(key)) return
    this.notified.add(key)
    await this.port.noteToModel(text).catch(err => this.log('debug', `note to model failed: ${errorText(err)}`))
  }

  /** Hard limit mid-turn: refuse new main-loop work, and end the turn if it will not end. */
  private async startDrain(tokens: number): Promise<void> {
    await this.patch({ phase: 'draining', operation: 'Hard limit: stopping new work, waiting for the turn to end' })
    this.log('info', `context ${Math.round(tokens / 1000)}k reached the hard limit; draining the turn`, true)
    const turnId = this.turnId
    const grace = Math.min(120000, Math.floor(this.config.rolloverTimeoutMs / 4))
    void (async () => {
      await this.port.sleep(grace).catch(() => undefined)
      if (this.isTurnRunning && this.turnId === turnId && turnId !== null) {
        this.log('warn', 'the turn did not end on its own; ending it', true)
        await this.port.abortTurn(turnId).catch(err => this.log('warn', `could not end the turn: ${errorText(err)}`))
      }
    })()
  }

  /** The main loop's turn ended: the safe point for a rollover. */
  async onTurnEnd(): Promise<void> {
    this.isTurnRunning = false
    this.turnId = null
    const s = await this.status()
    if (s.phase === 'resuming') {
      const now = await this.port.now()
      // A fresh session that already starts past the soft limit (a huge system prompt,
      // tool list or CLAUDE.md, or limits set too low) would roll over on every turn.
      const baseline = this.baseline
      this.baseline = null
      if (baseline !== null && baseline >= s.thresholds.soft) {
        const message = `the fresh session already holds ${Math.round(baseline / 1000)}k tokens, past the ${Math.round(s.thresholds.soft / 1000)}k soft limit; rolling over again would not help — raise the limits`
        await this.patch(prev => ({
          phase: 'failed',
          operation: 'Stopped: limits below a fresh session’s size',
          error: { message, at: now, isRetriable: false },
          last: prev.last === null ? null : { ...prev.last, outcome: 'success', toSessionId: prev.sessionId, at: now, detail: 'resumed; limits too low to continue' },
        }))
        this.log('error', message, true)
        return
      }
      await this.patch(prev => ({
        phase: 'completed',
        operation: 'Monitoring context usage',
        last: prev.last === null ? null : { ...prev.last, outcome: 'success', toSessionId: prev.sessionId, at: now, detail: 'resumed' },
      }))
      if (s.sessionId !== null && s.continuation.rolloverId !== null) await this.journal(s.sessionId, 'resumed', s.continuation.rolloverId, s.generation, null)
      this.log('info', `rollover ${s.continuation.rolloverId ?? ''} complete: the fresh session finished its first turn`, true)
      return
    }
    // Not awaited: the rollover runs /clear, which cannot run inside the hook a turn waits on.
    if (s.phase === 'ready' || s.phase === 'draining') void this.rollover(s.phase === 'draining' ? 'hard limit' : 'prepare limit')
  }

  /** Resolves once no rollover or draft is in flight (for tests and for an orderly exit). */
  async settled(): Promise<void> {
    while (this.inFlight !== null || this.draft !== null) await (this.inFlight ?? this.draft)
  }

  /** Whether a tool call may go ahead; a string is the refusal the model reads. */
  async gate(tool: string, isMain: boolean): Promise<string | null> {
    if (!this.config.enabled) return null
    const { phase } = await this.status()
    if ((phase === 'draining' || phase === 'persisting' || phase === 'restarting') && isMain && !ALLOWED_WHILE_DRAINING.has(tool)) return DRAIN_MESSAGE
    if (tool === 'Agent' && this.config.blockNewAgents && (phase === 'ready' || phase === 'draining' || phase === 'persisting' || phase === 'restarting')) return HOLD_AGENTS_MESSAGE

    return null
  }

  // ─── the rollover itself ───────────────────────────────────────────────────

  /** Start (or join) the one rollover of this session. Idempotent: a second trigger joins the first. */
  rollover(trigger: string): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.runWithRetries(trigger).finally(() => {
      this.inFlight = null
    })

    return this.inFlight
  }

  get isRolling(): boolean {
    return this.inFlight !== null
  }

  private async runWithRetries(trigger: string): Promise<void> {
    const before = await this.status()
    const fromSessionId = before.sessionId ?? (await this.port.sessionId())
    const now = await this.port.now()
    // The id outlives retries and reloads: it is in the state the host holds.
    const isOwnId = before.continuation.rolloverId !== null && before.continuation.status !== 'restored' && before.continuation.status !== 'pending' && before.continuation.status !== 'none'
    const rolloverId = isOwnId && before.continuation.rolloverId !== null ? before.continuation.rolloverId : `g${before.generation + 1}-${fromSessionId.slice(0, 8)}-${now.toString(36)}`
    const previousRolloverId = before.continuation.status === 'restored' ? before.continuation.rolloverId : null
    this.log('info', `rollover ${rolloverId} started (${trigger}) at ${before.context.tokens === null ? '?' : `${Math.round(before.context.tokens / 1000)}k`} tokens`, true)
    await this.patch({ continuation: { ...before.continuation, status: 'in-progress', rolloverId }, error: null })

    for (let attempt = 0; ; attempt += 1) {
      try {
        await within(this.port, this.config.rolloverTimeoutMs, this.attempt(rolloverId, fromSessionId, previousRolloverId, before.generation, before.context.tokens))
        return
      } catch (err) {
        const message = errorText(err)
        const at = await this.port.now()
        this.log('error', `rollover ${rolloverId} attempt ${attempt + 1} failed: ${message}`, true)
        if (attempt < this.config.maxRetries) {
          const wait = this.config.retryDelayMs * 2 ** attempt
          await this.patch({ error: { message, at, isRetriable: true }, operation: `Retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${this.config.maxRetries + 1})` })
          await this.port.sleep(wait)
          continue
        }
        await this.fail(rolloverId, fromSessionId, message, before.context.tokens)
        return
      }
    }
  }

  private async fail(rolloverId: string, fromSessionId: string, message: string, finalTokens: number | null): Promise<void> {
    const s = await this.status()
    const now = await this.port.now()
    const isPersisted = s.continuation.status === 'persisted'
    const error: RolloverError = { message, at: now, isRetriable: true }
    const last: RolloverOutcome = { outcome: 'failed', rolloverId, at: now, fromSessionId, toSessionId: null, finalTokens, detail: message }
    // The gate is lifted either way: a failed rollover must never leave the session stuck.
    await this.patch({
      phase: isPersisted ? 'awaiting-restart' : 'failed',
      error,
      last,
      operation: isPersisted ? 'Continuation saved — run /clear to continue in a fresh session' : 'Rollover failed — /rollover now to retry',
    })
    await this.journal(fromSessionId, 'failed', rolloverId, s.generation, null, message)
    this.port.toast(isPersisted ? 'Rollover could not restart the session: run /clear and it resumes from the saved continuation' : `Rollover failed: ${cut(message, 120)}`)
    if (isPersisted) await this.port.fillPrompt('/clear').catch(() => undefined)
  }

  private async attempt(rolloverId: string, fromSessionId: string, previousRolloverId: string | null, generation: number, finalTokens: number | null): Promise<void> {
    const root = await this.port.root()
    const cwd = await this.port.cwd()

    // 1. The old session's work: agents finish (or are recorded), then the state is persisted.
    let persisted = await findSnapshot(this.port.fs, root, rolloverId).then(found => (found?.snapshot.kind === 'final' ? found : null)).catch(() => null)
    const currentId = await this.port.sessionId().catch(() => fromSessionId)
    if (persisted === null) {
      if (currentId !== fromSessionId) throw new Error('the session changed before the continuation was saved; nothing to restore from')
      await this.patch({ phase: 'draining', operation: 'Waiting for agents to finish' })
      await this.journal(fromSessionId, 'draining', rolloverId, generation, null)
      await this.drainAgents()

      await this.patch({ phase: 'persisting', operation: 'Persisting continuation state' })
      await this.journal(fromSessionId, 'persisting', rolloverId, generation, null)
      const snapshot = await this.collect(rolloverId, fromSessionId, previousRolloverId, generation, finalTokens, cwd, root, 'final')
      const path = await writeSnapshot(this.port.fs, root, snapshot.snapshot)
      persisted = { snapshot: snapshot.snapshot, path }
      await this.patch({ continuation: { status: 'persisted', path, rolloverId, bytes: snapshot.snapshot.markdown.length, approxTokens: snapshot.approxTokens, updatedAt: await this.port.now() } })
      await this.journal(fromSessionId, 'persisted', rolloverId, generation, null)
      this.log('info', `continuation saved: ${path} (~${snapshot.approxTokens} tokens)`, true)
    }

    if (!this.config.automaticRestart) {
      await this.patch({ phase: 'awaiting-restart', operation: 'Continuation saved — run /clear to continue in a fresh session' })
      await this.journal(fromSessionId, 'awaiting-restart', rolloverId, generation, null)
      await this.port.fillPrompt('/clear').catch(() => undefined)
      this.port.toast('Context rollover is ready: run /clear and the fresh session resumes from the saved continuation')
      return
    }

    // 2. The fresh session. Skipped when the session already changed (a retry after /clear).
    let toSessionId = await this.port.sessionId().catch(() => fromSessionId)
    if (toSessionId === fromSessionId) {
      await this.patch({ phase: 'restarting', operation: 'Starting a fresh session' })
      await this.journal(fromSessionId, 'restarting', rolloverId, generation, null)
      if (this.config.restartMode === 'new-terminal' && (await this.handOffToTerminal(rolloverId, cwd))) return
      await this.port.clear()
      toSessionId = await this.waitForNewSession(fromSessionId)
    }

    // 3. Hand the continuation over.
    await this.handOver(persisted.snapshot, persisted.path, toSessionId, fromSessionId, finalTokens)
  }

  private async handOffToTerminal(rolloverId: string, cwd: string): Promise<boolean> {
    const isLaunched = await this.port.launchTerminal(`claude "/rollover resume ${rolloverId}"`, cwd).catch(() => false)
    if (!isLaunched) {
      this.log('warn', 'no terminal could be opened; restarting in this one with /clear instead', true)
      return false
    }
    await this.patch({ phase: 'restarting', operation: 'Handed off to a new terminal; closing this session' })
    this.port.toast('The fresh session is starting in a new terminal; this one closes')
    await this.port.sleep(2000)
    await this.port.exit()

    return true
  }

  private async waitForNewSession(fromSessionId: string): Promise<string> {
    const deadline = (await this.port.now()) + NEW_SESSION_WAIT_MS
    for (;;) {
      const id = await this.port.sessionId().catch(() => fromSessionId)
      if (id !== fromSessionId && id !== '') return id
      if ((await this.port.now()) > deadline) throw new Error('/clear did not start a new session')
      await this.port.sleep(250)
    }
  }

  private async handOver(snapshot: Snapshot, path: string, toSessionId: string, fromSessionId: string, finalTokens: number | null): Promise<void> {
    const isMine = await claim(this.port.fs, await this.port.root(), snapshot.rolloverId, toSessionId, await this.port.now(), () => this.port.sleep(SETTLE_MS))
    if (!isMine) throw new Error(`rollover ${snapshot.rolloverId} was already restored by another session`)
    const now = await this.port.now()
    this.handed.set(snapshot.rolloverId, snapshot.markdown)
    await this.patch(prev => ({
      sessionId: toSessionId,
      generation: snapshot.generation,
      phase: 'resuming',
      context: { tokens: null, window: prev.context.window, measuredAt: null, source: null },
      continuation: { status: 'restored', path, rolloverId: snapshot.rolloverId, bytes: snapshot.markdown.length, approxTokens: Math.ceil(snapshot.markdown.length / 3.5), updatedAt: now },
      last: { outcome: 'success', rolloverId: snapshot.rolloverId, at: now, fromSessionId, toSessionId, finalTokens, detail: 'handed over; resuming' },
      operation: 'Resuming unfinished tasks',
      error: null,
    }))
    this.notified.clear()
    this.tasks.clear()
    this.todos = null
    this.baseline = null
    await this.journal(fromSessionId, 'handed-over', snapshot.rolloverId, snapshot.generation, toSessionId)
    await this.journal(toSessionId, 'resuming', snapshot.rolloverId, snapshot.generation, null)
    // The continuation goes in as a row the model reads and the person does not see as
    // typed; the short prompt then starts the turn. Where the row is refused, the
    // continuation rides in the prompt itself, so it always arrives.
    const readable = path.replace(/\.json$/, '.md')
    const isAppended = await this.port
      .noteToModel(snapshot.markdown)
      .then(() => true)
      .catch(err => {
        this.log('warn', `continuation not appended (${errorText(err)}); sending it in the prompt`)
        return false
      })
    const prompt = resumePrompt(snapshot.rolloverId, snapshot.generation, readable)
    await this.port.submit(isAppended ? prompt : `${prompt}\n\n${snapshot.markdown}`)
    this.log('info', `fresh session ${toSessionId.slice(0, 8)} resuming from ${snapshot.rolloverId}`, true)
  }

  /**
   * Restore a persisted continuation into this session: `/rollover resume`, a new
   * process that found one, or the person's own /clear after a manual rollover.
   */
  async resume(rolloverId?: string): Promise<string> {
    const root = await this.port.root()
    const now = await this.port.now()
    const found = rolloverId === undefined ? await findPending(this.port.fs, root, now, this.config.staleAfterHours * 3600000) : await findSnapshot(this.port.fs, root, rolloverId)
    if (found === null) return rolloverId === undefined ? 'No continuation is waiting.' : `No valid snapshot of ${rolloverId} was found.`
    const sessionId = await this.port.sessionId()
    if (found.snapshot.fromSessionId === sessionId) return `${found.snapshot.rolloverId} was written by this very session; run /clear first so it restores into a fresh one.`
    try {
      await this.handOver(found.snapshot, found.path, sessionId, found.snapshot.fromSessionId, found.snapshot.data.finalTokens)
    } catch (err) {
      await this.patch({ error: { message: errorText(err), at: await this.port.now(), isRetriable: false } })
      return `Could not restore: ${errorText(err)}`
    }

    return `Restoring ${found.snapshot.rolloverId}.`
  }

  /** The person ran /clear (or the engine did for us): a new conversation in this process. */
  async onCleared(newSessionId: string): Promise<void> {
    if (this.inFlight !== null) return
    const s = await this.status()
    if (s.sessionId === newSessionId) return
    if (s.phase === 'awaiting-restart' && s.continuation.status === 'persisted' && s.continuation.rolloverId !== null && this.config.enabled) {
      // A manual rollover: the person cleared to continue; restore without asking again.
      await this.patch({ sessionId: newSessionId })
      const found = await findSnapshot(this.port.fs, await this.port.root(), s.continuation.rolloverId).catch(() => null)
      if (found !== null) {
        this.isTurnRunning = false
        await this.handOver(found.snapshot, found.path, newSessionId, found.snapshot.fromSessionId, found.snapshot.data.finalTokens).catch(async err => {
          await this.patch({ phase: 'failed', error: { message: errorText(err), at: await this.port.now(), isRetriable: false } })
        })
        return
      }
    }
    // A plain /clear: a new chain, nothing carried.
    const now = await this.port.now()
    this.notified.clear()
    this.tasks.clear()
    this.todos = null
    await this.patch(prev => ({
      ...initialStatus(prev.thresholds, now),
      sessionId: newSessionId,
      enabled: prev.enabled,
      phase: prev.enabled ? 'monitoring' : 'disabled',
      last: prev.last,
      agents: prev.agents,
      restart: prev.restart,
      context: { tokens: null, window: prev.context.window, measuredAt: null, source: null },
    }))
  }

  /** `/rollover cancel`: stop a rollover that has not restarted yet, and lift the gate. */
  async cancel(): Promise<string> {
    const s = await this.status()
    if (s.phase === 'restarting' || s.phase === 'resuming') return 'Too late to cancel: the fresh session is already starting.'
    await this.patch({ phase: 'monitoring', operation: 'Monitoring context usage (rollover cancelled)', error: null })

    return this.inFlight === null ? 'Nothing to cancel; monitoring.' : 'Cancelled; a persisted continuation stays on disk. /rollover now starts again.'
  }

  /** The continuation a resume prompt names, by its rollover id: from memory, else from disk. */
  async contextFor(text: string): Promise<string | null> {
    const id = rolloverIdIn(text)
    if (id === null) return null
    const held = this.handed.get(id)
    if (held !== undefined) return held
    const found = await findSnapshot(this.port.fs, await this.port.root(), id).catch(() => null)

    return found?.snapshot.markdown ?? null
  }

  // ─── gathering ─────────────────────────────────────────────────────────────

  /** Wait for running agents to finish, by policy; tell them to wrap up first. */
  private async drainAgents(): Promise<void> {
    let agents = await this.port.agents().catch(() => null)
    if (agents === null || this.config.agentPolicy === 'record') return
    let working = stillWorking(agents)
    if (working === 0) return
    if (this.config.notifyAgents) {
      await Promise.all(agents.filter(one => one.status === 'running' || one.status === 'waiting').map(one => this.port.sendToAgent(one.id, WRAP_UP_MESSAGE).catch(() => undefined)))
    }
    const deadline = (await this.port.now()) + this.config.agentDrainTimeoutMs
    while (working > 0 && (await this.port.now()) < deadline) {
      await this.patch({ operation: `Waiting for ${working} agent${working === 1 ? '' : 's'} to finish`, agents: countAgents(agents) })
      await this.port.sleep(AGENT_POLL_MS)
      agents = (await this.port.agents().catch(() => null)) ?? agents
      working = stillWorking(agents)
    }
    if (working > 0) this.log('warn', `${working} agent(s) still running at the drain deadline; recorded for re-dispatch`, true)
  }

  private async tasksNow(messages: readonly MessageSeen[]): Promise<TaskList | null> {
    const listed = await this.port.taskList().catch(() => null)
    if (listed !== null && listed.items.length > 0) return listed
    if (this.tasks.size > 0) return { source: 'TaskList', items: [...this.tasks.values()] }

    return lastTodos(messages)
  }

  private async gitState(rolloverId: string): Promise<GitState | null> {
    const top = await this.port.git(['rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) return null
    const [status, stat, log] = await Promise.all([
      this.port.git(['status', '--porcelain=v2', '--branch']),
      this.port.git(['diff', '--shortstat', 'HEAD']),
      this.port.git(['log', '-5', '--oneline']),
    ])
    let inProgress: string | null = null
    for (const [marker, name] of IN_PROGRESS_MARKERS) {
      const path = (await this.port.git(['rev-parse', '--git-path', marker])).stdout.trim()
      if (path !== '' && (await this.port.fs.exists(path.startsWith('/') || /^[A-Za-z]:/.test(path) ? path : `${top.stdout.trim()}/${path}`).catch(() => false))) {
        inProgress = name
        break
      }
    }
    const parsed = parsePorcelain(status.stdout)
    const git: GitState = {
      root: top.stdout.trim(),
      ...parsed,
      diffStat: stat.stdout.trim(),
      recentCommits: log.stdout.split(/\r?\n/).filter(line => line.trim() !== ''),
      inProgress,
      safetyRef: null,
      commit: null,
      note: null,
    }

    // A ref to the tree as it stands: `git stash create` writes a commit object and
    // touches neither the working tree, the index nor the stash list.
    if (this.config.gitSafetyRef && git.changes.length > 0) {
      const created = await this.port.git(['stash', 'create', `context-rollover ${rolloverId}`])
      const sha = created.stdout.trim()
      if (created.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(sha)) {
        const ref = safetyRefName(rolloverId)
        const updated = await this.port.git(['update-ref', ref, sha])
        if (updated.exitCode === 0) git.safetyRef = ref
      }
    }

    const decision = commitDecision(git, this.config.autoCommit, this.config.protectedBranches)
    if (decision.shouldCommit) {
      const added = await this.port.git(['add', '-A'])
      const committed = added.exitCode === 0 ? await this.port.git(['commit', '-m', `chore(context-rollover): checkpoint before rollover ${rolloverId}`]) : added
      if (committed.exitCode === 0) git.commit = (await this.port.git(['rev-parse', '--short', 'HEAD'])).stdout.trim() || null
      else git.note = 'autoCommit was on but the commit failed; the changes are left uncommitted'
    } else if (this.config.autoCommit) {
      git.note = `autoCommit skipped: ${decision.reason}`
    }

    return git
  }

  private async summarize(): Promise<{ summary: Summary | null; note: string | null }> {
    if (!this.config.useModelSummary) return { summary: null, note: 'model summary is off' }
    const reply = await this.port.fork(SUMMARY_PROMPT).catch(err => ({ isAnswered: false, reason: errorText(err) }) as const)
    if (!reply.isAnswered || reply.text === undefined) return { summary: null, note: `the summary request failed (${reply.reason ?? 'no reply'})` }
    const summary = parseSummary(reply.text)

    return summary === null ? { summary: null, note: 'the summary reply was not usable JSON' } : { summary, note: null }
  }

  private async collect(
    rolloverId: string,
    fromSessionId: string,
    previousRolloverId: string | null,
    generation: number,
    finalTokens: number | null,
    cwd: string,
    root: string,
    kind: 'draft' | 'final',
  ): Promise<{ snapshot: Snapshot; approxTokens: number }> {
    await this.patch({ operation: kind === 'final' ? 'Reading git, tasks and agents' : 'Drafting continuation' })
    const messages = await this.port.messages().catch(() => [] as MessageSeen[])
    const [git, tasks, seen, previous] = await Promise.all([
      this.gitState(rolloverId).catch(() => null),
      this.tasksNow(messages),
      this.port.agents().catch(() => null),
      previousRolloverId === null ? Promise.resolve(null) : findSnapshot(this.port.fs, root, previousRolloverId).catch(() => null),
    ])
    const agents = seen ?? []
    const outputs: Record<string, string | null> = {}
    await Promise.all(
      agents.slice(-12).map(async agent => {
        const rows = await this.port.agentMessages(agent.id).catch(() => null)
        outputs[agent.id] = rows === null ? null : lastAnswer(rows)
      }),
    )
    let summary: Summary | null = null
    let summaryNote: string | null = kind === 'draft' ? 'draft snapshot (no summary yet)' : null
    if (kind === 'final') {
      await this.patch({ operation: 'Asking for a targeted summary' })
      ;({ summary, note: summaryNote } = await this.summarize())
    }
    const requests = userRequests(messages)
    const carried = previous?.snapshot.data
    const data: ContinuationData = {
      rolloverId,
      generation: generation + 1,
      previousRolloverId,
      fromSessionId,
      createdAt: await this.port.now(),
      project: cwd,
      finalTokens,
      thresholds: (await this.status()).thresholds,
      objective: carried?.summary?.objective ?? carried?.objective ?? requests.first,
      carriedDecisions: [...(carried?.carriedDecisions ?? []), ...(carried?.summary?.decisions ?? [])].slice(-20),
      userRequests: requests.recent,
      summary,
      summaryNote,
      tasks,
      agents: recordAgents(agents, agentCalls(messages), outputs),
      git,
      files: filesWritten(messages),
      errors: recentErrors(messages),
    }
    const path = `${root}/snapshots/${snapshotName({ createdAt: data.createdAt, rolloverId, kind })}`
    const built = buildContinuation(data, path, this.config.maxContinuationTokens)
    const snapshot = seal({ rolloverId, kind, generation: generation + 1, createdAt: data.createdAt, fromSessionId, project: cwd, markdown: built.markdown, data })

    return { snapshot, approxTokens: built.approxTokens }
  }

  /** At the prepare limit: a cheap draft on disk, so a crash from here on loses little. */
  private saveDraft(): void {
    if (this.draft !== null) return
    this.draft = (async () => {
      try {
        const s = await this.status()
        const sessionId = s.sessionId ?? (await this.port.sessionId())
        const now = await this.port.now()
        const rolloverId = `g${s.generation + 1}-${sessionId.slice(0, 8)}-${now.toString(36)}`
        const root = await this.port.root()
        const previous = s.continuation.status === 'restored' ? s.continuation.rolloverId : null
        const { snapshot, approxTokens } = await this.collect(rolloverId, sessionId, previous, s.generation, s.context.tokens, await this.port.cwd(), root, 'draft')
        const path = await writeSnapshot(this.port.fs, root, snapshot)
        await this.patch(prev => (BUSY.has(prev.phase) ? {} : { continuation: { status: 'draft', path, rolloverId, bytes: snapshot.markdown.length, approxTokens, updatedAt: now }, operation: prev.phase === 'ready' ? 'Draft saved; rollover at the turn end' : prev.operation }))
      } catch (err) {
        this.log('warn', `draft continuation not saved: ${errorText(err)}`)
      } finally {
        this.draft = null
      }
    })()
  }
}
