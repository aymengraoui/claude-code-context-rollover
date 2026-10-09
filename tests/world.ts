/**
 * A simulated Claude Code process for the lifecycle tests: a clock, a disk, a git
 * repository, agents and a conversation, all in memory, behind the same port the
 * engine adapter implements. `/clear` really does what the engine documents: a new
 * session id, an empty conversation, no live agents.
 *
 * This is a simulation. It shows the lifecycle's logic end to end; it does not show
 * that the engine behaves as documented (see README, "What is and is not tested").
 */

import type { RolloverStatus } from '../types'
import type { AgentSeen } from '../hooks/lib/agents'
import type { Config, LogLevel } from '../hooks/lib/config'
import { mergeConfig } from '../hooks/lib/config'
import type { TaskList } from '../hooks/lib/continuation'
import { initialStatus } from '../hooks/lib/contract'
import type { Port } from '../hooks/lib/rollover'
import { Rollover } from '../hooks/lib/rollover'
import type { MessageSeen } from '../hooks/lib/transcript'

export const PORCELAIN = [
  '# branch.oid 0bd1c4f5a6b7c8d9e0f1',
  '# branch.head feat/game',
  '# branch.ab +2 -0',
  '1 .M N... 100644 100644 100644 0bd1 0bd1 src/engine/physics.ts',
  '1 A. N... 100644 100644 100644 0bd1 0bd1 src/levels/level3.ts',
  '? notes/ideas.md',
  '',
].join('\n')

type Timer = { at: number; fn: () => void; isCancelled: boolean }

export class World {
  clock = 1_760_000_000_000
  files = new Map<string, string>()
  status: RolloverStatus | null = null
  statusVersion = 0
  sessionNumber = 0
  sessionId = 'sessA000-0000-0000-0000-000000000000'
  readonly sessions: string[] = [this.sessionId]
  cwd = 'C:/work/game'
  home = 'C:/Users/me'
  tokens: number | null = null
  window: number | null = 1_000_000
  agents: AgentSeen[] = []
  agentRows: Record<string, MessageSeen[]> = {}
  messages: MessageSeen[] = []
  taskList: TaskList | null = null
  porcelain = PORCELAIN
  isRepo = true
  gitCalls: string[][] = []
  forkReply: { isAnswered: boolean; text?: string; reason?: string } = {
    isAnswered: true,
    text: JSON.stringify({
      objective: 'Build the robotics game with five agents',
      status: 'Physics and levels 1-2 done; level 3 half written',
      decisions: ['Use a fixed 60 Hz physics step because replays must be deterministic'],
      blockers: ['Collision tunnelling at high speed (src/engine/physics.ts)'],
      unfinished: ['Finish level 3', 'Wire the scoring UI'],
      nextActions: ['Run the physics tests', 'Finish src/levels/level3.ts'],
      unverified: ['The audio agent said its assets are committed'],
      skills: ['tdd'],
      notes: '',
    }),
  }
  forkCalls = 0
  /** What /clear does: `ok` as documented, `fail` rejects, `noop` resolves but changes nothing, `hang` never settles. */
  clearBehaviour: 'ok' | 'fail' | 'noop' | 'hang' = 'ok'
  clearFailuresLeft = Number.POSITIVE_INFINITY
  submitBehaviour: 'ok' | 'fail' = 'ok'
  appendBehaviour: 'ok' | 'fail' = 'ok'
  /** Every row the model was handed, in order: notes, continuations and prompts alike. */
  modelSaw: string[] = []
  clears = 0
  exits = 0
  launches: string[] = []
  canLaunch = false
  submitted: string[] = []
  notes: string[] = []
  sent: { agentId: string; text: string }[] = []
  filled: string[] = []
  toasts: string[] = []
  logs: { level: LogLevel; text: string }[] = []
  aborted: string[] = []
  timers: Timer[] = []
  /** Runs on every sleep: lets a test move agents along as time passes. */
  onSleep: (world: World) => void = () => undefined

  advance(ms: number): void {
    this.clock += ms
    for (const timer of this.timers) {
      if (!timer.isCancelled && timer.at <= this.clock) {
        timer.isCancelled = true
        timer.fn()
      }
    }
  }

  newSession(): string {
    this.sessionNumber += 1
    const letter = String.fromCharCode(65 + this.sessionNumber)
    this.sessionId = `sess${letter}000-0000-0000-0000-000000000000`
    this.sessions.push(this.sessionId)
    this.messages = []
    this.tokens = null
    this.agents = []
    this.taskList = null

    return this.sessionId
  }

  /** The terminal closed and a new process started: the host's state is gone, the disk is not. */
  restartProcess(): void {
    this.status = null
    this.newSession()
  }

  port(): Port {
    const tick = (): Promise<void> => Promise.resolve().then(() => undefined)

    return {
      now: async () => this.clock,
      sleep: async ms => {
        this.advance(ms)
        this.onSleep(this)
        await tick()
      },
      timer: (ms, fn) => {
        const timer: Timer = { at: this.clock + ms, fn, isCancelled: false }
        this.timers.push(timer)

        return () => {
          timer.isCancelled = true
        }
      },
      fs: {
        read: async path => {
          const text = this.files.get(path)
          if (text === undefined) throw new Error(`ENOENT ${path}`)
          return text
        },
        write: async (path, text) => {
          this.files.set(path, text)
        },
        list: async path => {
          const prefix = `${path}/`
          const names = [...this.files.keys()].filter(one => one.startsWith(prefix) && !one.slice(prefix.length).includes('/'))
          if (names.length === 0) throw new Error(`ENOENT ${path}`)
          return names.map(one => ({ name: one.slice(prefix.length), kind: 'file' }))
        },
        exists: async path => this.files.has(path),
      },
      root: async () => `${this.home}/.claude/context-rollover/C--work-game`,
      readStatus: async () => this.status,
      writeStatus: async change => {
        this.status = change(this.status ?? initialStatus({ soft: 180000, prepare: 190000, hard: 200000 }, this.clock))
        this.statusVersion += 1
      },
      sessionId: async () => this.sessionId,
      cwd: async () => this.cwd,
      usage: async () => ({ tokens: this.tokens, window: this.window }),
      agents: async () => this.agents.map(one => ({ ...one })),
      agentMessages: async id => this.agentRows[id] ?? null,
      messages: async () => this.messages,
      taskList: async () => this.taskList,
      git: async args => {
        this.gitCalls.push([...args])
        if (!this.isRepo) return { exitCode: 128, stdout: '' }
        const [verb, ...rest] = args
        if (verb === 'rev-parse' && rest[0] === '--show-toplevel') return { exitCode: 0, stdout: `${this.cwd}\n` }
        if (verb === 'rev-parse' && rest[0] === '--git-path') return { exitCode: 0, stdout: `.git/${rest[1] ?? ''}\n` }
        if (verb === 'rev-parse') return { exitCode: 0, stdout: 'c0ffee1\n' }
        if (verb === 'status') return { exitCode: 0, stdout: this.porcelain }
        if (verb === 'diff') return { exitCode: 0, stdout: ' 2 files changed, 40 insertions(+), 3 deletions(-)\n' }
        if (verb === 'log') return { exitCode: 0, stdout: 'abc1234 Add level 2\ndef5678 Physics step\n' }
        if (verb === 'stash' && rest[0] === 'create') return { exitCode: 0, stdout: 'feedface00112233\n' }
        return { exitCode: 0, stdout: '' }
      },
      fork: async () => {
        this.forkCalls += 1
        return this.forkReply
      },
      sendToAgent: async (agentId, text) => {
        this.sent.push({ agentId, text })
      },
      noteToModel: async text => {
        if (this.appendBehaviour === 'fail' && text.startsWith('# Context rollover continuation')) throw new Error('append refused')
        this.notes.push(text)
        this.modelSaw.push(text)
      },
      clear: async () => {
        this.clears += 1
        if (this.clearBehaviour === 'hang') return new Promise<void>(() => undefined)
        if (this.clearBehaviour === 'fail' && this.clearFailuresLeft > 0) {
          this.clearFailuresLeft -= 1
          throw new Error('command clear refused')
        }
        if (this.clearBehaviour === 'noop') return
        this.newSession()
      },
      submit: async text => {
        if (this.submitBehaviour === 'fail') throw new Error('prompt refused')
        this.submitted.push(text)
        this.modelSaw.push(text)
      },
      launchTerminal: async command => {
        this.launches.push(command)
        return this.canLaunch
      },
      exit: async () => {
        this.exits += 1
      },
      abortTurn: async turnId => {
        this.aborted.push(turnId)
      },
      fillPrompt: async text => {
        this.filled.push(text)
      },
      toast: text => {
        this.toasts.push(text)
      },
      log: (level, text) => {
        this.logs.push({ level, text })
      },
    }
  }

  /** A lifecycle on this world, with configuration over the defaults. */
  rollover(overrides: Partial<Record<keyof Config, unknown>> = {}): Rollover {
    const { config, warnings } = mergeConfig({ retryDelayMs: 1000, agentDrainTimeoutMs: 30000, ...overrides })

    return new Rollover(this.port(), config, warnings)
  }

  /** The snapshot files on disk, by name. */
  snapshotNames(): string[] {
    return [...this.files.keys()].filter(one => one.includes('/snapshots/') && one.endsWith('.json')).map(one => one.split('/').at(-1) ?? '')
  }

  /** Git calls that would change the working tree, the index or a branch. */
  destructiveGitCalls(): string[][] {
    const bad = new Set(['reset', 'clean', 'checkout', 'restore', 'switch', 'rebase', 'merge', 'pull', 'rm', 'mv', 'apply'])
    return this.gitCalls.filter(([verb, sub]) => (verb !== undefined && bad.has(verb)) || (verb === 'stash' && sub !== 'create'))
  }
}

/** A conversation like the one that grew to 688k: a request, a plan, five agents, edits, an error. */
export const conversation = (): MessageSeen[] => [
  { role: 'user', text: 'Build a robotics lab game. Use five agents: physics, levels, audio, UI, QA.', toolUses: [] },
  {
    role: 'assistant',
    text: 'Planning.',
    toolUses: [
      {
        tool: 'TodoWrite',
        input: {
          todos: [
            { content: 'Physics engine', status: 'completed', activeForm: '' },
            { content: 'Level 3', status: 'in_progress', activeForm: '' },
            { content: 'Scoring UI', status: 'pending', activeForm: '' },
          ],
        },
      },
      { tool: 'Agent', input: { description: 'physics', prompt: 'Own src/engine: deterministic physics at 60 Hz.', name: 'physics' }, agentId: 'ag-physics' },
      { tool: 'Agent', input: { description: 'levels', prompt: 'Own src/levels: build levels 1-5.', name: 'levels' }, agentId: 'ag-levels' },
      { tool: 'Agent', input: { description: 'audio', prompt: 'Own assets/audio.', name: 'audio' }, agentId: 'ag-audio' },
      { tool: 'Agent', input: { description: 'ui', prompt: 'Own src/ui: HUD and scoring.', name: 'ui' }, agentId: 'ag-ui' },
      { tool: 'Agent', input: { description: 'qa', prompt: 'Write and run tests for everything.', name: 'qa' }, agentId: 'ag-qa' },
      { tool: 'Edit', input: { file_path: 'src/engine/physics.ts' } },
      { tool: 'Bash', input: { command: 'npm test' }, isError: true, text: 'FAIL physics.test.ts\n tunnelling' },
    ],
  },
  { role: 'user', text: 'Prioritise level 3 over audio polish.', toolUses: [] },
]

export const fiveAgents = (): AgentSeen[] => [
  { id: 'ag-physics', status: 'completed', description: 'physics', type: 'general-purpose', name: 'physics' },
  { id: 'ag-levels', status: 'running', description: 'levels', type: 'general-purpose', name: 'levels' },
  { id: 'ag-audio', status: 'running', description: 'audio', type: 'general-purpose', name: 'audio' },
  { id: 'ag-ui', status: 'idle', description: 'ui', type: 'teammate', name: 'ui', teammateId: 'ui@game' },
  { id: 'ag-qa', status: 'pending', description: 'qa', type: 'general-purpose', name: 'qa' },
]
