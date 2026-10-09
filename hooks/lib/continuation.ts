/**
 * The continuation: what a fresh session needs to carry on, and nothing it can read
 * from the repository itself. Built from structured state (git, the task list, the
 * agents, the transcript's own tool calls), with the session's model asked only for
 * the part no structure holds. Pure: the data in, the markdown out.
 *
 * Shaped after the handoff skill's rules: settled artifacts (specs, plans, commits,
 * diffs) are referenced by path, never copied; secrets are redacted; a claim nobody
 * verified is listed as unverified, because the next session treats this as a contract.
 */

import type { AgentRecord } from './agents'
import type { GitState } from './git'
import type { Summary } from './summary'
import type { Thresholds } from './thresholds'

export type TaskItem = {
  id?: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  owner?: string
  blockedBy?: readonly string[]
}

export type TaskList = { source: 'TaskList' | 'TodoWrite'; items: readonly TaskItem[] }

export type ContinuationData = {
  rolloverId: string
  generation: number
  previousRolloverId: string | null
  fromSessionId: string
  createdAt: number
  project: string
  finalTokens: number | null
  thresholds: Thresholds
  /** The objective as the chain first stated it, carried from generation to generation. */
  objective: string | null
  /** Decisions carried from earlier generations, oldest first. */
  carriedDecisions: readonly string[]
  /** The person's own recent requests, verbatim (cut): nothing else records them. */
  userRequests: readonly string[]
  summary: Summary | null
  /** Why there is no summary, when there is none. */
  summaryNote: string | null
  tasks: TaskList | null
  agents: readonly AgentRecord[]
  git: GitState | null
  files: readonly string[]
  errors: readonly string[]
}

/** Characters per token used to bound the artifact's size; generous, so the bound holds. */
export const CHARS_PER_TOKEN = 3.5

export const approxTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)["']?[^\s"']{6,}/gi,
]

/** Known credential shapes replaced, so a continuation never carries a key forward. */
export const redact = (text: string): string =>
  SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' && prefix !== match ? `${prefix}[REDACTED]` : '[REDACTED]')),
    text,
  )

export const cut = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, ' ').trim()

  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`
}

type Section = {
  title: string
  /** Lower is kept longer. */
  priority: number
  lines: string[]
  /** Never trimmed below this many lines. */
  keep: number
}

const STATUS_MARK: Record<TaskItem['status'], string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }

const taskLine = (task: TaskItem): string => {
  const owner = task.owner === undefined || task.owner === '' ? '' : ` — owner: ${task.owner}`
  const blocked = task.blockedBy !== undefined && task.blockedBy.length > 0 ? ` — blocked by ${task.blockedBy.join(', ')}` : ''
  const id = task.id === undefined ? '' : `#${task.id} `

  return `- ${STATUS_MARK[task.status]} ${id}${cut(task.subject, 160)}${owner}${blocked}`
}

const agentLines = (agent: AgentRecord): string[] => {
  const who = agent.name ?? agent.description
  const lines = [`- **${cut(who, 60)}** (${agent.type}, ${agent.status}, id \`${agent.id}\`) → ${agent.action}`]
  if (agent.responsibility !== null) lines.push(`  - responsibility: ${cut(agent.responsibility, 400)}`)
  if (agent.lastOutput !== null) lines.push(`  - last output: ${cut(agent.lastOutput, 500)}`)

  return lines
}

const ACTION_ORDER: Record<AgentRecord['action'], number> = { 're-dispatch': 0, 'review-output': 1, none: 2 }

/** Every section, in the order it is read, with its trimming priority. */
const sectionsOf = (d: ContinuationData, snapshotPath: string): Section[] => {
  const s = d.summary
  const unfinishedTasks = d.tasks?.items.filter(one => one.status !== 'completed') ?? []
  const doneTasks = d.tasks?.items.filter(one => one.status === 'completed') ?? []
  const decisions = [...d.carriedDecisions, ...(s?.decisions ?? [])]
  const uniqueDecisions = decisions.filter((one, index) => decisions.indexOf(one) === index)
  const git = d.git
  const sections: Section[] = []

  sections.push({
    title: 'Objective',
    priority: 0,
    keep: 1,
    lines: [cut(s?.objective ?? d.objective ?? 'Not recorded — infer it from the tasks and the recent requests below.', 1200)],
  })

  if (s?.status !== undefined && s.status !== '') {
    sections.push({ title: 'Where it stands', priority: 1, keep: 1, lines: [cut(s.status, 1500)] })
  } else if (d.summaryNote !== null) {
    sections.push({ title: 'Where it stands', priority: 1, keep: 1, lines: [`No model summary: ${d.summaryNote}. Rely on the structured state below.`] })
  }

  if (s !== null && s.nextActions.length > 0) {
    sections.push({ title: 'Next actions (in order)', priority: 0, keep: 3, lines: s.nextActions.map((one, i) => `${i + 1}. ${cut(one, 300)}`) })
  }

  if (s !== null && s.unfinished.length > 0) {
    sections.push({ title: 'Unfinished work (priority order)', priority: 1, keep: 3, lines: s.unfinished.map(one => `- ${cut(one, 300)}`) })
  }

  if (d.tasks !== null) {
    sections.push({
      title: `Tasks (${d.tasks.source}: ${unfinishedTasks.length} open, ${doneTasks.length} done)`,
      priority: 1,
      keep: Math.min(8, unfinishedTasks.length),
      lines: [...unfinishedTasks.map(taskLine), ...doneTasks.map(taskLine)],
    })
  }

  if (d.agents.length > 0) {
    const ordered = [...d.agents].sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action])
    sections.push({
      title: `Agents (${d.agents.length})`,
      priority: 1,
      keep: 2,
      lines: [
        'The agents below do not survive the rollover. Re-dispatch the ones marked re-dispatch with their responsibility; read the output of the ones marked review-output and incorporate it if it is not in the repository yet.',
        ...ordered.flatMap(agentLines),
      ],
    })
  }

  if (uniqueDecisions.length > 0) {
    sections.push({ title: 'Decisions', priority: 2, keep: 4, lines: uniqueDecisions.map(one => `- ${cut(one, 300)}`) })
  }

  const blockers = s?.blockers ?? []
  if (blockers.length > 0) sections.push({ title: 'Blockers and known bugs', priority: 1, keep: 2, lines: blockers.map(one => `- ${cut(one, 300)}`) })

  if (d.errors.length > 0) sections.push({ title: 'Recent tool errors', priority: 4, keep: 0, lines: d.errors.map(one => `- ${cut(one, 240)}`) })

  if (git !== null) {
    const lines = [
      `- root: \`${git.root ?? '?'}\` · branch: \`${git.branch ?? 'detached'}\` · HEAD: \`${git.head ?? '?'}\`${git.ahead > 0 ? ` · ahead ${git.ahead}` : ''}${git.behind > 0 ? ` · behind ${git.behind}` : ''}`,
    ]
    if (git.inProgress !== null) lines.push(`- **${git.inProgress} in progress** — finish or abort it deliberately`)
    if (git.conflicted.length > 0) lines.push(`- conflicts: ${git.conflicted.join(', ')}`)
    lines.push(`- uncommitted: ${git.changes.length} changed, ${git.untracked.length} untracked${git.diffStat === '' ? '' : ` (${git.diffStat})`}`)
    if (git.safetyRef !== null) lines.push(`- safety ref of the working tree: \`${git.safetyRef}\` (\`git stash apply ${git.safetyRef}\` restores tracked changes if they are ever lost)`)
    if (git.commit !== null) lines.push(`- checkpoint commit made for this rollover: \`${git.commit}\``)
    if (git.note !== null) lines.push(`- note: ${git.note}`)
    lines.push(...git.changes.map(one => `  - ${one.status} ${one.path}`))
    lines.push(...git.untracked.map(one => `  - ? ${one}`))
    if (git.recentCommits.length > 0) lines.push('- recent commits:', ...git.recentCommits.map(one => `  - ${cut(one, 120)}`))
    sections.push({ title: 'Repository state at rollover', priority: 2, keep: 4, lines })
  }

  if (d.files.length > 0) sections.push({ title: 'Files this session wrote', priority: 3, keep: 5, lines: d.files.map(one => `- ${one}`) })

  if (d.userRequests.length > 0) {
    sections.push({ title: 'Recent requests from the person (verbatim, cut)', priority: 2, keep: 1, lines: d.userRequests.map(one => `- “${cut(one, 600)}”`) })
  }

  const unverified = s?.unverified ?? []
  if (unverified.length > 0) sections.push({ title: 'Unverified — check before relying on these', priority: 2, keep: 2, lines: unverified.map(one => `- ${cut(one, 240)}`) })

  const skills = s?.skills ?? []
  if (skills.length > 0) sections.push({ title: 'Suggested skills', priority: 4, keep: 0, lines: skills.map(one => `- ${cut(one, 120)}`) })

  if (s?.notes !== undefined && s.notes !== '') sections.push({ title: 'Other notes', priority: 3, keep: 0, lines: [cut(s.notes, 1500)] })

  sections.push({
    title: 'Resume protocol',
    priority: 0,
    keep: 99,
    lines: [
      '1. This session is fresh: the previous conversation is gone. Treat this file as a lead, not as truth — the repository is the source of truth.',
      '2. Verify first: run `git status` and `git log -3 --oneline`, compare them with “Repository state” above, and look at any file you are about to change before changing it.',
      '3. Recreate the open tasks above (TaskCreate, or TodoWrite) so the plan is visible again; keep owners.',
      '4. Re-dispatch agents marked re-dispatch, each with its recorded responsibility; incorporate outputs marked review-output if the repository does not already hold them.',
      '5. Continue with the first of “Next actions” (else the highest-priority unfinished task). Do not redo work the repository shows as done.',
      `6. This continuation is already in your context. Its full record is \`${snapshotPath}\` (large JSON) — do not read it unless something here is missing; a readable copy of this text is beside it as \`.md\`.`,
    ],
  })

  return sections
}

const render = (d: ContinuationData, sections: readonly Section[], omitted: number): string => {
  const head = [
    `# Context rollover continuation — ${d.rolloverId}`,
    '',
    `Generation ${d.generation}${d.previousRolloverId === null ? '' : ` (after ${d.previousRolloverId})`} · from session \`${d.fromSessionId}\` at ${new Date(d.createdAt).toISOString()} · project \`${d.project}\`${d.finalTokens === null ? '' : ` · rolled over at ${Math.round(d.finalTokens / 1000)}k / ${Math.round(d.thresholds.hard / 1000)}k tokens`}`,
    '',
    '> This restores the project’s state, not the conversation. It was written automatically by the context-rollover mod.',
  ]
  const body = sections.flatMap(one => (one.lines.length === 0 ? [] : ['', `## ${one.title}`, '', ...one.lines]))
  const tail = omitted > 0 ? ['', `_${omitted} lower-priority lines were left out to stay within the size limit; the full record is in the snapshot file._`] : []

  return redact([...head, ...body, ...tail, ''].join('\n'))
}

/**
 * The continuation as markdown, within `maxTokens` (by the character bound above).
 * Over budget, the lowest-priority section loses its last line first, down to the
 * lines it always keeps; the resume protocol and the objective are never cut.
 */
export const buildContinuation = (
  d: ContinuationData,
  snapshotPath: string,
  maxTokens: number,
): { markdown: string; approxTokens: number; omittedLines: number } => {
  const sections = sectionsOf(d, snapshotPath).map(one => ({ ...one, lines: [...one.lines] }))
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN)
  let omitted = 0
  let markdown = render(d, sections, omitted)

  while (markdown.length > maxChars) {
    const trimmable = sections
      .filter(one => one.lines.length > one.keep)
      .sort((a, b) => b.priority - a.priority || b.lines.length - a.lines.length)[0]
    if (trimmable === undefined) break
    // Cut in bigger steps while far over, single lines near the limit.
    const over = markdown.length - maxChars
    const step = Math.max(1, Math.min(trimmable.lines.length - trimmable.keep, Math.floor(over / 400)))
    trimmable.lines.splice(trimmable.lines.length - step, step)
    omitted += step
    markdown = render(d, sections, omitted)
  }

  return { markdown, approxTokens: approxTokens(markdown), omittedLines: omitted }
}

/** The short prompt the fresh session is started with; the continuation rides as context. */
export const resumePrompt = (rolloverId: string, generation: number, snapshotPath: string): string =>
  [
    `[context-rollover] Fresh session after rollover ${rolloverId} (generation ${generation}).`,
    'The continuation state is in the message just before this one. Follow its resume protocol: verify the project state, restore the task list and agents, then continue the highest-priority unfinished work.',
    `Readable copy, if ever needed: ${snapshotPath}`,
  ].join('\n')

/** The marker a resume prompt carries, so the prompt.submit hook can find its rollover. */
export const rolloverIdIn = (text: string): string | null => /\[context-rollover\] Fresh session after rollover (\S+) /.exec(text)?.[1] ?? null
