/**
 * Thresholds and where a context reading stands against them. Pure.
 *
 * The reading is the engine's own: the input tokens the last main-loop response was
 * answered over (uncached + cache-written + cache-read), the figure the status line
 * shows. It is the size of the context as of that response — the next request is
 * that plus the response and any tool results, which is why the limits sit below the
 * point where the session would actually stop.
 */

export type Thresholds = { soft: number; prepare: number; hard: number }

export type Zone = 'below' | 'soft' | 'prepare' | 'hard'

/** The share of the model's window a hard limit may claim: room above it for the last turn. */
export const WINDOW_SHARE = 0.9

/**
 * The thresholds in force. Configured values stand unless the model's window is too
 * small for them; then all three move down together, keeping their gaps, so the hard
 * limit leaves a tenth of the window for the turn that is running when it passes.
 */
export const effectiveThresholds = (configured: Thresholds, window: number | null): Thresholds => {
  if (window === null || !Number.isFinite(window) || window <= 0) return configured
  const ceiling = Math.floor(window * WINDOW_SHARE)
  if (configured.hard <= ceiling) return configured

  const shift = configured.hard - ceiling
  const soft = Math.max(1, configured.soft - shift)
  const prepare = Math.max(soft + 1, configured.prepare - shift)

  return { soft, prepare, hard: Math.max(prepare + 1, ceiling) }
}

export const zoneOf = (tokens: number | null, t: Thresholds): Zone => {
  if (tokens === null) return 'below'
  if (tokens >= t.hard) return 'hard'
  if (tokens >= t.prepare) return 'prepare'
  if (tokens >= t.soft) return 'soft'

  return 'below'
}

/** Progress toward the hard limit, 0–100, clamped; null without a reading. */
export const progressOf = (tokens: number | null, hard: number): number | null => {
  if (tokens === null || !Number.isFinite(tokens) || hard <= 0) return null

  return Math.max(0, Math.min(100, (tokens / hard) * 100))
}

/** The next threshold above the reading and how far off it is; null past the hard limit. */
export const nextThreshold = (
  tokens: number | null,
  t: Thresholds,
): { name: 'soft' | 'prepare' | 'hard'; at: number; remaining: number } | null => {
  if (tokens === null) return { name: 'soft', at: t.soft, remaining: t.soft }
  for (const name of ['soft', 'prepare', 'hard'] as const) {
    if (tokens < t[name]) return { name, at: t[name], remaining: t[name] - tokens }
  }

  return null
}

/** Input tokens a response was answered over, from its usage: the status line's figure. */
export const contextTokensOf = (usage: {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens?: number
}): number => usage.input_tokens + usage.cache_read_input_tokens + (usage.cache_creation_input_tokens ?? 0)
