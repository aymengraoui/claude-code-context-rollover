/**
 * The repository's state as git reports it, and the one decision this mod ever makes
 * about committing. Pure: parsing and policy; the commands run in the orchestrator,
 * and none of them resets, cleans, checks out or otherwise rewrites the working tree.
 */

export type GitChange = { path: string; status: string }

export type GitState = {
  root: string | null
  branch: string | null
  head: string | null
  ahead: number
  behind: number
  changes: GitChange[]
  untracked: string[]
  conflicted: string[]
  /** `git diff --shortstat HEAD`, trimmed. */
  diffStat: string
  recentCommits: string[]
  /** A merge, rebase, cherry-pick or revert under way, by name. */
  inProgress: string | null
  /** `refs/context-rollover/<id>`, pointing at a `git stash create` commit of the tree. */
  safetyRef: string | null
  /** The checkpoint commit autoCommit made, when it made one. */
  commit: string | null
  note: string | null
}

/** Status letters as the porcelain gives them: `.M` → `M`, `A.` → `A`. */
const letterOf = (xy: string): string => {
  const [x = '.', y = '.'] = xy
  if (x !== '.' && y !== '.' && x !== y) return `${x}${y}`

  return x !== '.' ? x : y
}

/** `git status --porcelain=v2 --branch`, read; unknown lines are skipped. */
export const parsePorcelain = (out: string): Pick<GitState, 'branch' | 'head' | 'ahead' | 'behind' | 'changes' | 'untracked' | 'conflicted'> => {
  const state = { branch: null as string | null, head: null as string | null, ahead: 0, behind: 0, changes: [] as GitChange[], untracked: [] as string[], conflicted: [] as string[] }

  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      state.head = oid === '(initial)' ? null : oid.slice(0, 12)
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      state.branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      state.ahead = Number(match?.[1] ?? 0)
      state.behind = Number(match?.[2] ?? 0)
    } else if (line.startsWith('1 ')) {
      const parts = line.split(' ')
      const path = parts.slice(8).join(' ')
      if (path !== '') state.changes.push({ path, status: letterOf(parts[1] ?? '') })
    } else if (line.startsWith('2 ')) {
      const parts = line.split(' ')
      const paths = parts.slice(9).join(' ').split('\t')
      if (paths[0] !== undefined && paths[0] !== '') state.changes.push({ path: `${paths[1] ?? '?'} → ${paths[0]}`, status: 'R' })
    } else if (line.startsWith('u ')) {
      const path = line.split(' ').slice(10).join(' ')
      if (path !== '') state.conflicted.push(path)
    } else if (line.startsWith('? ')) {
      state.untracked.push(line.slice(2))
    }
  }

  return state
}

export type CommitDecision = { shouldCommit: true } | { shouldCommit: false; reason: string }

/**
 * Whether autoCommit may commit now. It is off by default, and even on it never
 * commits onto a protected or detached branch, over conflicts, or in the middle of a
 * merge or rebase — those are the person's to finish.
 */
export const commitDecision = (
  git: Pick<GitState, 'branch' | 'changes' | 'untracked' | 'conflicted' | 'inProgress'>,
  isEnabled: boolean,
  protectedBranches: readonly string[],
): CommitDecision => {
  if (!isEnabled) return { shouldCommit: false, reason: 'autoCommit is off' }
  if (git.branch === null) return { shouldCommit: false, reason: 'HEAD is detached' }
  if (protectedBranches.includes(git.branch)) return { shouldCommit: false, reason: `${git.branch} is protected` }
  if (git.inProgress !== null) return { shouldCommit: false, reason: `a ${git.inProgress} is in progress` }
  if (git.conflicted.length > 0) return { shouldCommit: false, reason: 'there are conflicts' }
  if (git.changes.length === 0 && git.untracked.length === 0) return { shouldCommit: false, reason: 'nothing to commit' }

  return { shouldCommit: true }
}

/** The markers `git rev-parse --git-path <name>` resolves, and what each means. */
export const IN_PROGRESS_MARKERS: readonly (readonly [string, string])[] = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
]

export const safetyRefName = (rolloverId: string): string => `refs/context-rollover/${rolloverId.replace(/[^A-Za-z0-9._-]/g, '-')}`
