/**
 * The one targeted question put to the session's own model before a rollover: only
 * what no structured source holds (intent, decisions and their reasons, what is
 * next). It is asked through `$.model.fork`, which re-sends the transcript as the
 * main thread last sent it, so the prompt cache serves almost all of it. Pure: the
 * prompt and the parse.
 */

export type Summary = {
  objective?: string
  status?: string
  decisions: string[]
  blockers: string[]
  unfinished: string[]
  nextActions: string[]
  unverified: string[]
  skills: string[]
  notes?: string
}

export const SUMMARY_PROMPT = [
  'The conversation is about to roll over into a fresh session with no access to this transcript.',
  'The repository, its git state, the task list and the agents list are captured separately and automatically — do NOT restate them, do not copy code, diffs, specs or plans; reference files by path.',
  'Answer with ONE JSON object and nothing else, at most about 1200 words in all, with these keys:',
  '- "objective": the overall goal the person is pursuing, one or two sentences;',
  '- "status": where the work stands right now, a short paragraph;',
  '- "decisions": array of important architectural or product decisions made in this conversation, each with its reason (only ones the repository does not already document);',
  '- "blockers": array of known bugs, blockers, open questions;',
  '- "unfinished": array of unfinished work items, highest priority first;',
  '- "nextActions": array of the exact next steps a fresh session should take, in order;',
  '- "unverified": array of things believed but not verified in this conversation (so the next session checks them);',
  '- "skills": array of skills (by name) the next session should reach for, possibly empty;',
  '- "notes": anything else the next session cannot reconstruct from the repository, or "".',
  'Never include secrets, tokens or passwords.',
].join('\n')

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((one): one is string => typeof one === 'string' && one.trim() !== '')
        .map(one => one.trim())
        .slice(0, max)
    : []

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** The first balanced `{…}` in a reply, so prose or a code fence around it is ignored. */
const firstObject = (reply: string): string | null => {
  const start = reply.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < reply.length; i += 1) {
    const ch = reply[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return reply.slice(start, i + 1)
    }
  }

  return null
}

/** The reply as a Summary, or null when it holds no usable object. */
export const parseSummary = (reply: string): Summary | null => {
  const raw = firstObject(reply)
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const summary: Summary = {
    objective: text(v.objective),
    status: text(v.status),
    decisions: strings(v.decisions, 20),
    blockers: strings(v.blockers, 15),
    unfinished: strings(v.unfinished, 20),
    nextActions: strings(v.nextActions, 10),
    unverified: strings(v.unverified, 15),
    skills: strings(v.skills, 8),
    notes: text(v.notes),
  }
  const isEmpty =
    summary.objective === undefined &&
    summary.status === undefined &&
    summary.nextActions.length === 0 &&
    summary.unfinished.length === 0 &&
    summary.decisions.length === 0

  return isEmpty ? null : summary
}
