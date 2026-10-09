/**
 * The context-rollover mod: the engine's events wired to the lifecycle in
 * `lib/rollover.ts`, and `$` adapted to its port. Nothing here decides anything.
 *
 * Reading:  turn.step (each main-loop response's own usage), session.measure, $.session.usage
 * Acting:   tool.call (the gate), /clear, $.session.append (the continuation), $.prompt.submit
 * Sharing:  $.state `context-rollover.status`, the contract in types/index.d.ts
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RolloverStatus } from '../types'
import type { AgentSeen } from './lib/agents'
import { mergeConfig, parseProjectConfig, shouldLog } from './lib/config'
import type { Config } from './lib/config'
import { HEARTBEAT_MS, initialStatus, validateStatus } from './lib/contract'
import { isWindowsPath, launchCommands } from './lib/launch'
import { ALLOWED_WHILE_DRAINING, Rollover } from './lib/rollover'
import type { Port } from './lib/rollover'
import { rootFor } from './lib/store'
import { contextTokensOf } from './lib/thresholds'
import { tasksFromTaskList } from './lib/transcript'
import type { MessageSeen } from './lib/transcript'

const PROJECT_CONFIG = '.claude/context-rollover.json'

const status = atom({ plugin: 'context-rollover', key: 'status' } as const, initialStatus({ soft: 180000, prepare: 190000, hard: 200000 }, 0))

/** The lifecycle of this load; a reload makes a new one over the state the host kept. */
let rollover: Rollover | null = null

const toPosix = (path: string): string => path.split(String.fromCharCode(92)).join('/')

const asMessages = (rows: unknown): MessageSeen[] => (Array.isArray(rows) ? (rows as MessageSeen[]) : [])

/** Run `work` from a timer, outside any hook a turn waits on, and settle with it. */
const detached = <T>($: EngineInterface, work: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    $.clock.after(1, () => {
      work().then(resolve, reject)
    })
  })

const readConfig = async ($: EngineInterface, options: Readonly<Record<string, unknown>>): Promise<{ config: Config; warnings: string[] }> => {
  const cwd = toPosix(await $.session.cwd().catch(() => ''))
  const file = cwd === '' ? null : await $.fs.read(`${cwd}/${PROJECT_CONFIG}`).catch(() => null)
  const project = file === null ? { values: null, warning: null } : parseProjectConfig(file)
  const merged = mergeConfig(options, project.values)

  return { config: merged.config, warnings: project.warning === null ? merged.warnings : [project.warning, ...merged.warnings] }
}

/** `$` as the lifecycle's port. */
const portOf = ($: EngineInterface, getConfig: () => Config): Port => {
  let root: string | null = null

  return {
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    timer: (ms, fn) => {
      const timer = $.clock.after(ms, fn)

      return () => timer.cancel()
    },
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
    },
    root: async () => {
      if (root !== null) return root
      const [cwd, profile, home] = await Promise.all([$.session.cwd(), $.env.get('USERPROFILE'), $.env.get('HOME')])
      root = rootFor(getConfig().continuationDir, toPosix(cwd), profile ?? home ?? null)

      return root
    },
    readStatus: async () => {
      const held = await $.state.get({ plugin: 'context-rollover', key: 'status' })
      const checked = validateStatus(held.value)

      return checked.isValid && held.version > 0 ? checked.status : null
    },
    writeStatus: async change => {
      await update($, status, prev => change(validateStatus(prev).isValid ? prev : initialStatus(prev.thresholds, Date.now())))
    },
    sessionId: () => $.session.id(),
    cwd: async () => toPosix(await $.session.cwd()),
    usage: async () => {
      const { context } = await $.session.usage()

      return { tokens: context.tokens ?? null, window: context.window ?? null }
    },
    agents: async () =>
      (await $.agent.list()).map(
        (one): AgentSeen => ({
          id: one.id,
          status: one.status,
          description: one.description,
          type: one.type,
          ...(one.name === undefined ? {} : { name: one.name }),
          ...(one.teammateId === undefined ? {} : { teammateId: one.teammateId }),
          ...(one.parentId === undefined ? {} : { parentId: one.parentId }),
        }),
      ),
    agentMessages: async agentId => {
      const rows = await $.session.messages({ agentId })

      return Array.isArray(rows) ? asMessages(rows) : null
    },
    messages: async () => asMessages(await $.session.messages()),
    taskList: async () => {
      const listed = await $.tool.list().catch(() => [])
      if (!listed.some(one => one.name === 'TaskList')) return null
      const ran = await $.tool.call({ tool: 'TaskList' } as never)
      if ('deny' in ran && typeof ran.deny === 'string') return null

      return tasksFromTaskList(ran.result ?? ran.text ?? null)
    },
    git: async args => {
      try {
        const cwd = await $.session.cwd()
        const ran = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 30000 })

        return { exitCode: ran.exitCode, stdout: ran.stdout }
      } catch {
        return { exitCode: -1, stdout: '' }
      }
    },
    fork: async prompt => {
      const reply = await $.model.fork({ prompt })

      return reply.isAnswered ? { isAnswered: true, text: reply.text } : { isAnswered: false, reason: reply.reason }
    },
    sendToAgent: async (agentId, text) => {
      await $.session.send({ to: { agentId }, text })
    },
    noteToModel: async text => {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    },
    clear: () =>
      detached($, async () => {
        await $.command.run({ command: 'clear' })
      }),
    submit: text =>
      detached($, async () => {
        await $.prompt.submit({ text })
      }),
    launchTerminal: async (command, cwd) => {
      for (const argv of launchCommands(command, cwd, isWindowsPath(cwd))) {
        const ran = await $.process.run(argv).catch(() => null)
        if (ran?.exitCode === 0) return true
      }

      return false
    },
    exit: () =>
      detached($, async () => {
        await $.command.run({ command: 'exit' })
      }),
    abortTurn: turnId => $.turn.abort({ turnId }),
    fillPrompt: async text => {
      await $.prompt.fill({ text })
    },
    toast: text => $.ui.toast(text),
    log: (level, text, toTranscript) => {
      if (!shouldLog(getConfig().logLevel, level)) return
      $.ui.log(`context-rollover: ${text}`, toTranscript ? undefined : { to: 'debug' })
    },
  }
}

/** Lines `/rollover status` prints: the state as the sidebar sees it, in words. */
const describe = (s: RolloverStatus, config: Config): string => {
  const k = (n: number | null): string => (n === null ? '—' : `${Math.round(n / 1000)}k`)
  const lines = [
    `phase ${s.phase} · session ${s.sessionId?.slice(0, 8) ?? '?'} · generation ${s.generation}`,
    `context ${k(s.context.tokens)} / ${k(s.thresholds.hard)} (soft ${k(s.thresholds.soft)}, prepare ${k(s.thresholds.prepare)}${s.thresholds.hard !== config.hardLimit ? `, clamped from ${k(config.hardLimit)} to fit the model's window` : ''})`,
    `handoff ${s.continuation.status}${s.continuation.path === null ? '' : ` · ${s.continuation.path}`}`,
    `restart ${s.restart.isAutomatic ? 'automatic' : 'manual'} via ${s.restart.mode}`,
    `now: ${s.operation}`,
  ]
  if (s.last !== null) lines.push(`last: ${s.last.outcome} · ${s.last.rolloverId} · ${new Date(s.last.at).toISOString()}${s.last.detail === null ? '' : ` · ${s.last.detail}`}`)
  if (s.error !== null) lines.push(`error: ${s.error.message}`)

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  /** The configuration of this load: options from /config, then the project's file. */
  let config: Config = mergeConfig(options).config

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rollover',
      description: 'Context rollover: status, now, resume [id], cancel, config',
      argumentHint: '[status|now|resume [id]|cancel|config]',
    })
    const loaded = await readConfig($, options)
    config = loaded.config
    rollover = new Rollover(portOf($, () => config), config, loaded.warnings)
    await rollover.start().catch(err => $.ui.log(`context-rollover: start failed: ${String(err)}`))

    // The heartbeat says the mod is alive; the agent counts ride along.
    $.clock.every(HEARTBEAT_MS, () => {
      void rollover?.heartbeat().catch(() => undefined)
      void rollover?.refreshAgents().catch(() => undefined)
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await rollover?.onTurnStart(e.turnId).catch(() => undefined)

    return next(e)
  })

  // Each main-loop response's own usage: the exact context, mid-turn, with no extra call.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage !== null) {
      await rollover?.observe(contextTokensOf(result.usage), null, 'turn.step').catch(() => undefined)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await rollover?.observe(e.context.tokens ?? null, e.context.window ?? null, 'session.measure').catch(() => undefined)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await rollover?.onTurnEnd().catch(() => undefined)

    return result
  })

  // The gate: from the prepare limit, no new agents; while draining, no new main-loop work.
  // A failure here lets the call through: this mod must never block work by breaking.
  on('tool.call', async ($, e, next) => {
    const isMain = (e as { agentId?: string }).agentId === undefined
    const refusal = rollover === null ? null : await rollover.gate(e.tool, isMain)
    if (refusal !== null) return { deny: refusal }

    const result = await next(e)
    if (ALLOWED_WHILE_DRAINING.has(e.tool) && !('deny' in result && typeof result.deny === 'string')) {
      await rollover?.onToolResult(e.tool, e as unknown as Record<string, unknown>, result.result).catch(() => undefined)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' && typeof e.session_id === 'string') await rollover?.onCleared(e.session_id).catch(() => undefined)

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await rollover?.refreshAgents().catch(() => undefined)

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await rollover?.refreshAgents().catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'rollover' }, async ($, e) => {
    const current = rollover
    if (current === null) return { text: 'context-rollover is not running yet.' }
    const [verb = 'status', arg] = e.args.trim().split(/\s+/).filter(one => one !== '')
    switch (verb) {
      case 'now':
        if (current.isRolling) return { text: 'A rollover is already under way.' }
        // Detached: the rollover runs /clear, which cannot run inside this command.
        $.clock.after(1, () => void current.rollover('requested with /rollover now'))
        return { text: 'Rolling over now: persisting the continuation, then starting a fresh session.' }
      case 'resume':
        $.clock.after(1, () => void current.resume(arg).then(text => $.ui.toast(text)))
        return { text: arg === undefined ? 'Restoring the newest continuation nobody restored yet.' : `Restoring ${arg}.` }
      case 'cancel':
        return { text: await current.cancel() }
      case 'config':
        return { text: JSON.stringify(current.settings, null, 2) }
      default: {
        const s = await read($, status)
        return { text: describe(s, current.settings) }
      }
    }
  })
}
