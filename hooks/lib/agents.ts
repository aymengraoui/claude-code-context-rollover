/**
 * Agents and teammates: counting them for the sidebar, and recording each one so a
 * fresh session can reconstruct the team. Pure.
 *
 * What survives a rollover is the record, not the agent: a subagent's or an
 * in-process teammate's loop belongs to the session that started it, and nothing in
 * Claude Code re-attaches a running loop to a new conversation. So each agent is
 * written down with its identity, its responsibility (the prompt it was given) and
 * its last output, and the fresh session re-dispatches what was unfinished.
 */

import type { AgentCounts } from '../../types'

export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/** What `$.agent.list()` gives, as far as this module reads it. */
export type AgentSeen = {
  id: string
  status: AgentStatus
  description: string
  type: string
  name?: string
  teammateId?: string
  parentId?: string
}

/** What the main transcript says the Agent call that started it asked. */
export type AgentCall = { agentId: string | null; description: string; prompt: string; subagentType: string | null; name: string | null }

export type AgentRecord = {
  id: string
  name: string | null
  type: string
  description: string
  status: AgentStatus
  teammateId: string | null
  /** The prompt it was dispatched with, cut. */
  responsibility: string | null
  /** Its last answer, cut. */
  lastOutput: string | null
  /** What the fresh session should do about it. */
  action: 're-dispatch' | 'review-output' | 'none'
}

export const ACTIVE: ReadonlySet<AgentStatus> = new Set(['running', 'waiting'])

export const countAgents = (agents: readonly Pick<AgentSeen, 'status'>[]): AgentCounts => {
  const counts: AgentCounts = { active: 0, idle: 0, pending: 0, completed: 0, failed: 0, total: agents.length }
  for (const one of agents) {
    if (ACTIVE.has(one.status)) counts.active += 1
    else if (one.status === 'idle') counts.idle += 1
    else if (one.status === 'pending') counts.pending += 1
    else if (one.status === 'completed') counts.completed += 1
    else counts.failed += 1
  }

  return counts
}

/** Agents still doing work the rollover would cut off. */
export const stillWorking = (agents: readonly Pick<AgentSeen, 'status'>[]): number =>
  agents.filter(one => ACTIVE.has(one.status) || one.status === 'pending').length

/**
 * The action for an agent as the rollover finds it. Interrupted or never-started work
 * is re-dispatched; finished work is reviewed (its output may not be in the repository
 * yet); an idle teammate is re-dispatched too, since its standing role ends with the loop.
 */
export const actionFor = (status: AgentStatus, hasOutput: boolean, isTeammate: boolean): AgentRecord['action'] => {
  if (status === 'running' || status === 'waiting' || status === 'pending' || status === 'failed' || status === 'killed') return 're-dispatch'
  if (status === 'idle') return isTeammate ? 're-dispatch' : hasOutput ? 'review-output' : 'none'

  return hasOutput ? 'review-output' : 'none'
}

/** Join the engine's list with the calls that started each agent and their outputs. */
export const recordAgents = (
  seen: readonly AgentSeen[],
  calls: readonly AgentCall[],
  outputs: Readonly<Record<string, string | null>>,
  limit = 12,
): AgentRecord[] =>
  seen.slice(-limit).map(agent => {
    const call = calls.find(one => one.agentId === agent.id) ?? calls.find(one => one.agentId === null && agent.name !== undefined && one.name === agent.name) ?? null
    const lastOutput = outputs[agent.id] ?? null
    const isTeammate = agent.teammateId !== undefined || agent.type === 'teammate'

    return {
      id: agent.id,
      name: agent.name ?? call?.name ?? null,
      type: call?.subagentType ?? agent.type,
      description: agent.description || call?.description || agent.type,
      status: agent.status,
      teammateId: agent.teammateId ?? null,
      responsibility: call?.prompt ?? null,
      lastOutput,
      action: actionFor(agent.status, lastOutput !== null && lastOutput !== '', isTeammate),
    }
  })

/** What a running agent is told when the drain starts. */
export const WRAP_UP_MESSAGE =
  'The lead session is rolling over to a fresh context shortly. Finish the step you are on, leave the files consistent, report what you completed and what remains in your final answer, and do not start new subtasks.'
