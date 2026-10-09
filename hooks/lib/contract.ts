/**
 * The shared state contract's runtime side: the empty value, and the check every
 * read goes through. Pure. The types are in `types/index.d.ts`.
 */

import type { RolloverPhase, RolloverStatus } from '../../types'
import type { Thresholds } from './thresholds'

export const SCHEMA_VERSION = 1 as const

/** How often the heartbeat is bumped; an observer calls the state stale past 3×. */
export const HEARTBEAT_MS = 15000

export const PHASES: readonly RolloverPhase[] = [
  'disabled',
  'monitoring',
  'preparing',
  'ready',
  'draining',
  'persisting',
  'restarting',
  'resuming',
  'completed',
  'awaiting-restart',
  'failed',
]

/** Phases in which a rollover is under way: a second trigger is a duplicate. */
export const BUSY: ReadonlySet<RolloverPhase> = new Set(['draining', 'persisting', 'restarting', 'resuming'])

export const initialStatus = (thresholds: Thresholds, now: number): RolloverStatus => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId: null,
  generation: 0,
  phase: 'monitoring',
  enabled: true,
  context: { tokens: null, window: null, measuredAt: null, source: null },
  thresholds,
  continuation: { status: 'none', path: null, rolloverId: null, bytes: null, approxTokens: null, updatedAt: null },
  agents: null,
  tasks: null,
  last: null,
  operation: 'Monitoring context usage',
  error: null,
  restart: { mode: 'clear', isAutomatic: true },
  heartbeatAt: now,
  updatedAt: now,
})

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type Validated = { isValid: true; status: RolloverStatus } | { isValid: false; reason: string }

/**
 * Whether a value read from `$.state` (or anywhere) is a status this version can draw.
 * Checks the fields a reader relies on; extra fields are allowed.
 */
export const validateStatus = (value: unknown): Validated => {
  if (value === undefined || value === null) return { isValid: false, reason: 'missing' }
  if (!isObj(value)) return { isValid: false, reason: 'not an object' }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    return { isValid: false, reason: `schema ${String(value.schemaVersion)} unsupported` }
  }
  if (typeof value.phase !== 'string' || !PHASES.includes(value.phase as RolloverPhase)) {
    return { isValid: false, reason: 'unknown phase' }
  }
  const context = value.context
  if (!isObj(context) || !isNumOrNull(context.tokens) || !isNumOrNull(context.window)) {
    return { isValid: false, reason: 'bad context' }
  }
  const t = value.thresholds
  if (!isObj(t) || !isNum(t.soft) || !isNum(t.prepare) || !isNum(t.hard) || t.hard <= 0) {
    return { isValid: false, reason: 'bad thresholds' }
  }
  if (!isObj(value.continuation) || typeof value.continuation.status !== 'string') {
    return { isValid: false, reason: 'bad continuation' }
  }
  if (!isNum(value.heartbeatAt) || !isNum(value.updatedAt)) return { isValid: false, reason: 'bad timestamps' }
  if (typeof value.operation !== 'string') return { isValid: false, reason: 'bad operation' }

  return { isValid: true, status: value as RolloverStatus }
}

/** Whether the writer has stopped: no heartbeat for three periods. */
export const isStale = (status: RolloverStatus, now: number, heartbeatMs = HEARTBEAT_MS): boolean =>
  now - status.heartbeatAt > heartbeatMs * 3
