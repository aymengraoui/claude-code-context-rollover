/**
 * Configuration: the defaults, the two sources merged over them, and the checks that
 * keep a bad value from ever reaching the lifecycle. Pure.
 *
 * Sources, lowest precedence first: the defaults below; the plugin's `userConfig`
 * (the `/config` menu, stored in settings.json `pluginConfigs`); a project's own
 * `.claude/context-rollover.json`. Every threshold the lifecycle uses is read from the
 * result — nothing downstream names a number of its own.
 */

export type RestartMode = 'clear' | 'new-terminal'
export type AgentPolicy = 'drain' | 'record'
export type ResumeOnStartup = 'ask' | 'auto' | 'off'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export type Config = {
  enabled: boolean
  softLimit: number
  prepareLimit: number
  hardLimit: number
  /** Start the fresh session without asking. Off: persist, then wait for the person's /clear. */
  automaticRestart: boolean
  /** `clear`: /clear in this terminal. `new-terminal`: open a new one, then exit this one. */
  restartMode: RestartMode
  /** Where continuations live. Empty: `~/.claude/context-rollover/<project>`. Relative: under the project. */
  continuationDir: string
  /** The continuation is trimmed, lowest-priority sections first, to fit this. */
  maxContinuationTokens: number
  /** Past this, an attempt is abandoned (and retried, or marked failed). */
  rolloverTimeoutMs: number
  maxRetries: number
  retryDelayMs: number
  logLevel: LogLevel
  /** `drain`: wait for running agents (up to agentDrainTimeoutMs). `record`: record them and go. */
  agentPolicy: AgentPolicy
  agentDrainTimeoutMs: number
  /** Ask running agents to wrap up when the drain starts. */
  notifyAgents: boolean
  /** Refuse new Agent spawns from the prepare limit on. */
  blockNewAgents: boolean
  /** Commit the working tree before the restart. Off by default: never commit to make rollover easy. */
  autoCommit: boolean
  /** Branches autoCommit never commits to. */
  protectedBranches: readonly string[]
  /** Keep a ref to the working tree (`git stash create`), which touches neither tree nor index. */
  gitSafetyRef: boolean
  /** A new session finding a continuation nobody restored: ask (fill the prompt), auto, or off. */
  resumeOnStartup: ResumeOnStartup
  /** Ask the session's own model (a fork, cached prefix) for what the repository cannot say. */
  useModelSummary: boolean
  /** Tell the model when the soft and prepare limits pass. */
  notifyModel: boolean
  /** A continuation older than this is offered no more. */
  staleAfterHours: number
}

export const DEFAULTS: Config = {
  enabled: true,
  softLimit: 180000,
  prepareLimit: 190000,
  hardLimit: 200000,
  automaticRestart: true,
  restartMode: 'clear',
  continuationDir: '',
  maxContinuationTokens: 10000,
  rolloverTimeoutMs: 600000,
  maxRetries: 3,
  retryDelayMs: 5000,
  logLevel: 'info',
  agentPolicy: 'drain',
  agentDrainTimeoutMs: 300000,
  notifyAgents: true,
  blockNewAgents: true,
  autoCommit: false,
  protectedBranches: ['main', 'master'],
  gitSafetyRef: true,
  resumeOnStartup: 'ask',
  useModelSummary: true,
  notifyModel: true,
  staleAfterHours: 24,
}

/** What a merge said about the values it could not take. */
export type ConfigReading = { config: Config; warnings: string[] }

type Rule = (value: unknown) => unknown | undefined

const bool: Rule = v => (typeof v === 'boolean' ? v : undefined)
const positiveInt: Rule = v =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
const nonNegativeInt: Rule = v =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
const oneOf =
  (...values: readonly string[]): Rule =>
  v =>
    typeof v === 'string' && values.includes(v) ? v : undefined
const text: Rule = v => (typeof v === 'string' ? v.trim() : undefined)
const list: Rule = v =>
  Array.isArray(v) && v.every(one => typeof one === 'string')
    ? v
    : typeof v === 'string'
      ? v
          .split(',')
          .map(one => one.trim())
          .filter(one => one !== '')
      : undefined

const RULES: { [K in keyof Config]: Rule } = {
  enabled: bool,
  softLimit: positiveInt,
  prepareLimit: positiveInt,
  hardLimit: positiveInt,
  automaticRestart: bool,
  restartMode: oneOf('clear', 'new-terminal'),
  continuationDir: text,
  maxContinuationTokens: positiveInt,
  rolloverTimeoutMs: positiveInt,
  maxRetries: nonNegativeInt,
  retryDelayMs: nonNegativeInt,
  logLevel: oneOf('error', 'warn', 'info', 'debug'),
  agentPolicy: oneOf('drain', 'record'),
  agentDrainTimeoutMs: nonNegativeInt,
  notifyAgents: bool,
  blockNewAgents: bool,
  autoCommit: bool,
  protectedBranches: list,
  gitSafetyRef: bool,
  resumeOnStartup: oneOf('ask', 'auto', 'off'),
  useModelSummary: bool,
  notifyModel: bool,
  staleAfterHours: positiveInt,
}

/**
 * Merge sources over the defaults, later sources winning. A value of the wrong kind
 * is skipped with a warning naming it; a key nobody knows is reported too, so a typo
 * in a project file is not silently ignored.
 */
export const mergeConfig = (...sources: readonly (Readonly<Record<string, unknown>> | null | undefined)[]): ConfigReading => {
  const config: Record<string, unknown> = { ...DEFAULTS }
  const warnings: string[] = []

  for (const source of sources) {
    if (source === null || source === undefined) continue
    for (const [key, raw] of Object.entries(source)) {
      const rule = (RULES as Record<string, Rule | undefined>)[key]
      if (rule === undefined) {
        warnings.push(`unknown setting "${key}"`)
        continue
      }
      // An empty string from the /config menu means "unset": the default stands.
      if (raw === '' && key !== 'continuationDir') continue
      const value = rule(raw)
      if (value === undefined) warnings.push(`"${key}" has an invalid value; kept ${JSON.stringify(config[key])}`)
      else config[key] = value
    }
  }

  const merged = config as Config
  if (!(merged.softLimit < merged.prepareLimit && merged.prepareLimit < merged.hardLimit)) {
    warnings.push(
      `thresholds must rise soft < prepare < hard (got ${merged.softLimit} / ${merged.prepareLimit} / ${merged.hardLimit}); using the defaults`,
    )
    merged.softLimit = DEFAULTS.softLimit
    merged.prepareLimit = DEFAULTS.prepareLimit
    merged.hardLimit = DEFAULTS.hardLimit
  }

  return { config: merged, warnings }
}

/** Parse a project's `.claude/context-rollover.json`; anything but an object is a warning. */
export const parseProjectConfig = (text: string): { values: Record<string, unknown> | null; warning: string | null } => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { values: null, warning: 'project config is not a JSON object; ignored' }
    }

    return { values: parsed as Record<string, unknown>, warning: null }
  } catch {
    return { values: null, warning: 'project config is not valid JSON; ignored' }
  }
}

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

/** Whether a line at `level` is written under the configured level. */
export const shouldLog = (configured: LogLevel, level: LogLevel): boolean =>
  LEVELS.indexOf(level) <= LEVELS.indexOf(configured)
