/**
 * The durable record: versioned, checksummed snapshots, one claim per restored
 * rollover, and a journal per session. Everything goes through a small file port so
 * the logic is testable without a disk.
 *
 * The engine's file API writes whole files and has no rename or exclusive create, so
 * atomicity comes from never overwriting anything that matters: each snapshot is a new
 * file whose checksum covers its content, a torn or corrupted one fails the check and
 * the next newest valid one is used instead, and nothing here ever deletes. The
 * journal is overwritten, but it only says where a rollover stood; losing it costs a
 * status line, never state.
 */

import type { ContinuationData } from './continuation'

export type FilePort = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<readonly { name: string; kind: string }[]>
  exists: (path: string) => Promise<boolean>
}

export const SNAPSHOT_FORMAT = 'context-rollover/snapshot@1'

export type SnapshotKind = 'draft' | 'final'

export type Snapshot = {
  format: typeof SNAPSHOT_FORMAT
  rolloverId: string
  kind: SnapshotKind
  generation: number
  createdAt: number
  fromSessionId: string
  project: string
  markdown: string
  data: ContinuationData
  checksum: string
}

export type Claim = { rolloverId: string; claimedBy: string; at: number }

/** Where a session's rollover stands, for recovery after a crash. */
export type Journal = {
  sessionId: string
  phase: string
  rolloverId: string | null
  generation: number
  /** Set once the restart was issued: the session the continuation was meant for. */
  toSessionId: string | null
  error: string | null
  updatedAt: number
}

/** FNV-1a over UTF-16 code units, as 8 hex digits: enough to catch a torn write. */
export const checksum = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(16).padStart(8, '0')
}

const sealOf = (s: Omit<Snapshot, 'checksum'>): string =>
  checksum(`${s.format}|${s.rolloverId}|${s.kind}|${s.generation}|${s.createdAt}|${s.fromSessionId}|${s.markdown}|${JSON.stringify(s.data)}`)

export const seal = (s: Omit<Snapshot, 'checksum' | 'format'>): Snapshot => {
  const unsealed = { format: SNAPSHOT_FORMAT, ...s } as const

  return { ...unsealed, checksum: sealOf(unsealed) }
}

/** A snapshot read back, or null when it is not one, or its checksum does not hold. */
export const parseSnapshot = (text: string): Snapshot | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const s = value as Snapshot
  if (s.format !== SNAPSHOT_FORMAT || typeof s.markdown !== 'string' || typeof s.rolloverId !== 'string') return null
  if (typeof s.data !== 'object' || s.data === null || typeof s.createdAt !== 'number') return null
  const { checksum: stated, ...rest } = s

  return sealOf(rest) === stated ? s : null
}

export const snapshotName = (s: Pick<Snapshot, 'createdAt' | 'rolloverId' | 'kind'>): string =>
  `${String(s.createdAt).padStart(14, '0')}-${s.rolloverId}-${s.kind}.json`

export const dirs = (root: string) => ({
  snapshots: `${root}/snapshots`,
  claims: `${root}/claims`,
  sessions: `${root}/sessions`,
})

/**
 * Write a snapshot as a new file and read it back: resolves the path once the bytes
 * on disk verify, rejects otherwise (the caller retries; the previous file stands).
 */
export const writeSnapshot = async (fs: FilePort, root: string, snapshot: Snapshot): Promise<string> => {
  const path = `${dirs(root).snapshots}/${snapshotName(snapshot)}`
  const text = JSON.stringify(snapshot, null, 1)
  await fs.write(path, text)
  const back = parseSnapshot(await fs.read(path))
  if (back === null || back.checksum !== snapshot.checksum) throw new Error(`snapshot ${path} did not verify after writing`)
  // A readable copy beside it, for a person or a fresh session's Read; the JSON is the record.
  await fs.write(path.replace(/\.json$/, '.md'), snapshot.markdown).catch(() => undefined)

  return path
}

const listNames = async (fs: FilePort, dir: string): Promise<string[]> => {
  try {
    return (await fs.list(dir)).filter(one => one.kind === 'file').map(one => one.name)
  } catch {
    return []
  }
}

export const readClaim = async (fs: FilePort, root: string, rolloverId: string): Promise<Claim | null> => {
  try {
    const value = JSON.parse(await fs.read(`${dirs(root).claims}/${rolloverId}.json`)) as Claim
    return typeof value.claimedBy === 'string' ? value : null
  } catch {
    return null
  }
}

/**
 * The newest final snapshot nobody has restored, younger than `maxAgeMs`, that
 * verifies. A corrupted newest file falls back to the one before it.
 */
export const findPending = async (fs: FilePort, root: string, now: number, maxAgeMs: number): Promise<{ snapshot: Snapshot; path: string } | null> => {
  const names = (await listNames(fs, dirs(root).snapshots)).filter(name => name.endsWith('-final.json')).sort().reverse()
  for (const name of names) {
    const createdAt = Number(name.slice(0, 14))
    if (Number.isFinite(createdAt) && now - createdAt > maxAgeMs) break
    const path = `${dirs(root).snapshots}/${name}`
    const snapshot = parseSnapshot(await fs.read(path).catch(() => ''))
    if (snapshot === null) continue
    if ((await readClaim(fs, root, snapshot.rolloverId)) !== null) continue

    return { snapshot, path }
  }

  return null
}

/** The newest valid snapshot of a rollover, final before draft. */
export const findSnapshot = async (fs: FilePort, root: string, rolloverId: string): Promise<{ snapshot: Snapshot; path: string } | null> => {
  const names = (await listNames(fs, dirs(root).snapshots))
    .filter(name => name.includes(`-${rolloverId}-`) && name.endsWith('.json'))
    .sort((a, b) => Number(b.endsWith('-final.json')) - Number(a.endsWith('-final.json')) || b.localeCompare(a))
  for (const name of names) {
    const path = `${dirs(root).snapshots}/${name}`
    const snapshot = parseSnapshot(await fs.read(path).catch(() => ''))
    if (snapshot !== null) return { snapshot, path }
  }

  return null
}

/**
 * Claim a rollover for restoring, once. A claim already held by another session
 * loses; otherwise the claim is written, the port waits a moment, and it is read
 * back: of two sessions racing, the one whose write landed last wins and the other
 * sees it and backs off. Best effort — the file API has no exclusive create.
 */
export const claim = async (
  fs: FilePort,
  root: string,
  rolloverId: string,
  sessionId: string,
  now: number,
  settle: () => Promise<void>,
): Promise<boolean> => {
  const held = await readClaim(fs, root, rolloverId)
  if (held !== null) return held.claimedBy === sessionId
  const mine: Claim = { rolloverId, claimedBy: sessionId, at: now }
  await fs.write(`${dirs(root).claims}/${rolloverId}.json`, JSON.stringify(mine))
  await settle()

  return (await readClaim(fs, root, rolloverId))?.claimedBy === sessionId
}

export const writeJournal = (fs: FilePort, root: string, journal: Journal): Promise<void> =>
  fs.write(`${dirs(root).sessions}/${journal.sessionId}.json`, JSON.stringify(journal))

export const readJournals = async (fs: FilePort, root: string): Promise<Journal[]> => {
  const names = await listNames(fs, dirs(root).sessions)
  const read = await Promise.all(
    names.map(async name => {
      try {
        const value = JSON.parse(await fs.read(`${dirs(root).sessions}/${name}`)) as Journal
        return typeof value.sessionId === 'string' && typeof value.phase === 'string' ? value : null
      } catch {
        return null
      }
    }),
  )

  return read.filter((one): one is Journal => one !== null).sort((a, b) => b.updatedAt - a.updatedAt)
}

/** A folder name for a project directory: the same shape Claude Code's own projects folder uses. */
export const projectKey = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '') || 'project'

/** Where this project's record lives. */
export const rootFor = (configured: string, cwd: string, home: string | null): string => {
  const posixCwd = cwd.replace(/\\/g, '/')
  if (configured !== '') {
    const c = configured.replace(/\\/g, '/').replace(/\/+$/, '')
    const isAbsolute = /^([A-Za-z]:)?\//.test(c)
    const base = isAbsolute ? c : `${posixCwd}/${c}`

    return `${base}/${projectKey(posixCwd)}`
  }
  const h = (home ?? posixCwd).replace(/\\/g, '/').replace(/\/+$/, '')

  return `${h}/.claude/context-rollover/${projectKey(posixCwd)}`
}
