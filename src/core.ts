import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const SESSION_ID_RE = /^(?:session-)?[0-9a-fA-F-]{1,200}$/

function isLoopbackIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function isLoopbackHost(value: string): boolean {
  let normalized = value.trim().toLocaleLowerCase()
  if (normalized === 'localhost') return true
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length)
  return isLoopbackIpv4(normalized)
}

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.includes('%') ? value.slice(0, value.indexOf('%')) : value
  return isLoopbackHost(normalized) && normalized.toLocaleLowerCase() !== 'localhost'
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function sessionDirectoryFromArtifact(sessionsRoot: string, artifactPath: string): string {
  const directory = dirname(resolve(artifactPath))
  if (!isPathInside(sessionsRoot, directory)) {
    throw Object.assign(new Error('会话记录路径不在 DSH sessions 目录内'), {
      code: 'unsafe-session-path',
      status: 500,
    })
  }
  return directory
}

export function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isSessionId))]
}

export function formatFailure(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof Error) {
    const detail = error as Error & { code?: unknown; status?: unknown }
    return {
      code: typeof detail.code === 'string' ? detail.code : 'internal',
      message: detail.message || '操作失败',
      status: typeof detail.status === 'number' ? detail.status : 500,
    }
  }
  return { code: 'internal', message: String(error), status: 500 }
}

export function assertUniqueTrashPaths(entries: ReadonlyArray<{ sessionId: string; trashPath: string }>): void {
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.sessionId)) throw new Error(`回收站重复会话：${entry.sessionId}`)
    if (paths.has(entry.trashPath)) throw new Error(`回收站重复路径：${entry.trashPath}`)
    ids.add(entry.sessionId)
    paths.add(entry.trashPath)
  }
}
