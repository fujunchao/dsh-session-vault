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

/**
 * 从长期保存的标识中挑出已无对应会话的孤儿。
 *
 * `known` 必须来自一次**成功**的会话列举。调用方绝不能在列举失败时传入空集合，
 * 否则这里会把全部标识判为孤儿——存储故障将因此被放大成状态清空。
 */
export function selectOrphanedIds(stored: readonly string[], known: ReadonlySet<string>): string[] {
  return stored.filter((id) => !known.has(id))
}

/**
 * 计算仍受插件管辖、因而不得当作孤儿清理的会话标识。
 *
 * 回收站中的会话已被移出 DSH 的 sessions 目录，不会出现在会话列举结果里，但它们
 * 由本插件托管且可随时恢复，并不是孤儿。移入回收站时插件会把会话标记为归档以遮蔽
 * 它；若对账把这些标识判为孤儿清掉，该遮蔽立即失效，会话会重新冒到侧边栏中。
 */
export function retainedSessionIds(existing: Iterable<string>, trashed: Iterable<string>): Set<string> {
  const retained = new Set<string>(existing)
  for (const id of trashed) retained.add(id)
  return retained
}
