/**
 * The context-rollover state contract, schema version 1.
 *
 * This mod is the single writer of `$.state` `context-rollover.status`. Any other mod
 * (the Cockpit sidebar) may read it: the host versions every write and redraws the
 * readers, so an observer never polls. An observer must validate what it reads —
 * check `schemaVersion`, and treat a missing value, a malformed one or an old
 * `heartbeatAt` as UNAVAILABLE or STALE — and must never trigger a rollover itself.
 *
 * Bump `schemaVersion` on any change an older reader would misread; adding an
 * optional field is not such a change.
 */

/** Where the rollover lifecycle stands. */
export type RolloverPhase =
  /** The mod is loaded but switched off by configuration. */
  | 'disabled'
  /** Below the soft limit: watching context usage. */
  | 'monitoring'
  /** Past the soft limit: the model has been told; state is being gathered. */
  | 'preparing'
  /** Past the prepare limit: a draft continuation is persisted; new agents are held. */
  | 'ready'
  /** Rolling over now: new main-loop work is refused while the turn and agents wind down. */
  | 'draining'
  /** Writing the final continuation: git, tasks, agents, the targeted summary. */
  | 'persisting'
  /** The old conversation is being ended and a fresh one started (/clear or a new terminal). */
  | 'restarting'
  /** The fresh session has been handed the continuation and is resuming. */
  | 'resuming'
  /** The fresh session finished its first turn: the transition is complete. */
  | 'completed'
  /** Persisted, but the restart is left to the person (automaticRestart off, or it failed). */
  | 'awaiting-restart'
  /** The last attempt failed and retries are exhausted; the continuation (if any) is kept. */
  | 'failed'

/** Where the continuation (the handoff) stands. */
export type HandoffStatus =
  | 'none'
  /** Being gathered or written. */
  | 'in-progress'
  /** A draft snapshot is on disk: a crash from here on loses little. */
  | 'draft'
  /** The final snapshot is on disk and verified, not yet restored. */
  | 'persisted'
  /** A persisted continuation from an earlier session is waiting to be restored. */
  | 'pending'
  /** Restored into this session. */
  | 'restored'
  | 'failed'

/** Agents of this session by status, as `$.agent.list()` reports them. */
export type AgentCounts = {
  /** running or waiting */
  active: number
  idle: number
  pending: number
  completed: number
  /** failed or killed */
  failed: number
  total: number
}

/** The task list by status, as the TaskList tool or the last TodoWrite reports it. */
export type TaskCounts = {
  pending: number
  inProgress: number
  completed: number
  total: number
  source: 'TaskList' | 'TodoWrite'
}

/** Where a context figure came from; every one is the engine's own count, none estimated. */
export type ContextSource = 'turn.step' | 'session.measure' | 'session.usage'

/** The outcome of the last rollover this project's chain attempted. */
export type RolloverOutcome = {
  outcome: 'success' | 'failed' | 'interrupted'
  rolloverId: string
  /** Epoch ms. */
  at: number
  fromSessionId: string
  toSessionId: string | null
  /** Tokens the old session held when it rolled over. */
  finalTokens: number | null
  detail: string | null
}

export type RolloverError = {
  message: string
  /** Epoch ms. */
  at: number
  /** True when a retry (automatic or `/rollover now`) may succeed. */
  isRetriable: boolean
}

/** The whole shared state. */
export type RolloverStatus = {
  schemaVersion: 1
  /** The session these figures belong to; changes on every rollover. */
  sessionId: string | null
  /** Rollovers this chain has done: 0 for a session that was never rolled into. */
  generation: number
  phase: RolloverPhase
  enabled: boolean
  context: {
    /** Input tokens the last main-loop response was answered over; null before the first. */
    tokens: number | null
    /** The model's context window, as the engine reports it. */
    window: number | null
    measuredAt: number | null
    source: ContextSource | null
  }
  /** The thresholds in force, after any clamp to the model's window. */
  thresholds: { soft: number; prepare: number; hard: number }
  continuation: {
    status: HandoffStatus
    /** The snapshot file, absolute. */
    path: string | null
    rolloverId: string | null
    bytes: number | null
    /** A size bound for the artifact (characters / 3.5), not a context reading. */
    approxTokens: number | null
    updatedAt: number | null
  }
  /** null: not available (never fabricated). */
  agents: AgentCounts | null
  tasks: TaskCounts | null
  last: RolloverOutcome | null
  /** What is happening now, or the next thing that will. */
  operation: string
  error: RolloverError | null
  restart: { mode: 'clear' | 'new-terminal'; isAutomatic: boolean }
  /** Bumped every few seconds while the mod runs: an old one means it stopped. */
  heartbeatAt: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-rollover': { status: RolloverStatus }
  }
}
