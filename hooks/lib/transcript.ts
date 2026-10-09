/**
 * Structured facts read off the session's own transcript (`$.session.messages()`):
 * the person's requests, the task list as last written, the files written, the
 * errors met and the Agent calls made. These are the tool calls' own payloads, not a
 * summary of the conversation. Pure.
 */

import type { AgentCall } from './agents'
import type { TaskItem, TaskList } from './continuation'

/** The fields of `SessionMessage` this module reads. */
export type MessageSeen = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly {
    tool: string
    input: Readonly<Record<string, unknown>>
    text?: string
    isError?: true
    agentId?: string
    result?: unknown
  }[]
}

const MARK = '[context-rollover]'

const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** A user row the person typed, not a tool result, a command record or a reminder. */
const isTyped = (m: MessageSeen): boolean => {
  if (m.role !== 'user') return false
  const t = m.text.trim()

  return t !== '' && !t.startsWith('<') && !t.includes(MARK)
}

/** The person's requests: the first one (the objective's origin) and the last few. */
export const userRequests = (messages: readonly MessageSeen[], recent = 5): { first: string | null; recent: string[] } => {
  const typed = messages.filter(isTyped).map(m => m.text.trim())

  return { first: typed[0] ?? null, recent: typed.slice(-recent) }
}

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

const asTask = (raw: unknown): TaskItem | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const subject = typeof r.subject === 'string' ? r.subject : typeof r.content === 'string' ? r.content : null
  if (subject === null || typeof r.status !== 'string' || !STATUSES.has(r.status)) return null

  return {
    ...(typeof r.id === 'string' ? { id: r.id } : {}),
    subject,
    status: r.status as TaskItem['status'],
    ...(typeof r.owner === 'string' && r.owner !== '' ? { owner: r.owner } : {}),
    ...(Array.isArray(r.blockedBy) ? { blockedBy: r.blockedBy.filter((one): one is string => typeof one === 'string') } : {}),
  }
}

/** The TodoWrite list as last written in this conversation; null when it never was. */
export const lastTodos = (messages: readonly MessageSeen[]): TaskList | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const uses = messages[i]?.toolUses ?? []
    for (let j = uses.length - 1; j >= 0; j -= 1) {
      const use = uses[j]
      if (use?.tool !== 'TodoWrite' || !Array.isArray(use.input.todos)) continue
      const items = use.input.todos.map(asTask).filter((one): one is TaskItem => one !== null)

      return { source: 'TodoWrite', items }
    }
  }

  return null
}

/** The TaskList tool's answer (`{ tasks }`, as its record or its text), read defensively. */
export const tasksFromTaskList = (result: unknown): TaskList | null => {
  let value = result
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const tasks = (value as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) return null

  return { source: 'TaskList', items: tasks.map(asTask).filter((one): one is TaskItem => one !== null) }
}

/** Files the session wrote, newest last, each once. */
export const filesWritten = (messages: readonly MessageSeen[], max = 40): string[] => {
  const seen: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (!WRITERS.has(use.tool)) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string' || path === '') continue
      const at = seen.indexOf(path)
      if (at >= 0) seen.splice(at, 1)
      seen.push(path)
    }
  }

  return seen.slice(-max)
}

/** The last few failed tool calls, by what failed and the first line of why. */
export const recentErrors = (messages: readonly MessageSeen[], max = 6): string[] => {
  const errors: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      if (use.isError !== true) continue
      const what = typeof use.input.command === 'string' ? use.input.command : typeof use.input.file_path === 'string' ? use.input.file_path : ''
      const why = (use.text ?? '').split(/\r?\n/).find(line => line.trim() !== '') ?? ''
      errors.push(`${use.tool}${what === '' ? '' : ` ${what}`}: ${why}`.slice(0, 300))
    }
  }

  return errors.slice(-max)
}

/** Every Agent call the main loop made, with the id the engine gave its agent. */
export const agentCalls = (messages: readonly MessageSeen[]): AgentCall[] =>
  messages.flatMap(m =>
    m.toolUses
      .filter(use => use.tool === 'Agent')
      .map(use => ({
        agentId: typeof use.agentId === 'string' ? use.agentId : null,
        description: typeof use.input.description === 'string' ? use.input.description : '',
        prompt: typeof use.input.prompt === 'string' ? use.input.prompt : '',
        subagentType: typeof use.input.subagent_type === 'string' ? use.input.subagent_type : null,
        name: typeof use.input.name === 'string' ? use.input.name : null,
      })),
  )

/** An agent's last answer, from its own transcript. */
export const lastAnswer = (messages: readonly MessageSeen[]): string | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'assistant' && m.text.trim() !== '') return m.text.trim()
  }

  return null
}
