import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

/** 等待并保证一个目录最终从磁盘上消失（有界重试）。 *
 * DSH 0.1.7 的会话写入器以 header（cwd+id）推导落盘路径，事件批量窗口约
 * 200ms，且句柄关闭（session/disposed / 进程 teardown）时还会补一次
 * drain+flush。把会话目录移出 sessions 根之后，任何在途写入都会按推导路径
 * 把目录重新 materialize 回原位——回收站里留着一份，原位又复活一份；随后
 * 永久清除会解除归档遮蔽，这份复活副本就会以「未分组」形式回到侧边栏。
 *
 * 本守卫在移动/删除之后轮询原位：先给在途 flush 一个落定的宽限期，若目录
 * 仍被重建则物理清除并继续观察，直到连续 attempts 次确认不存在为止。全部
 * 重试耗尽仍存在时抛错（code='artifact-resurrected'），调用方保留归档
 * 遮蔽并走既有重试路径，绝不能在原位仍有副本时解除隐藏。
 */
export async function ensureDirectoryAbsent(
  path: string,
  { attempts = 6, intervalMs = 350 }: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  // 初始宽限：先等一个批窗口，让驱逐/移动触发前的在途 flush 先落定，
  // 否则目录「此刻不存在」可能只是写入尚未到达，轮询会瞬间空转通过。
  await sleep(intervalMs)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!existsSync(path)) {
      // 消失后再复查一个窗口：吸收宽限期后一刻才落地的写入。
      await sleep(intervalMs)
      if (!existsSync(path)) return
      continue
    }
    await rm(path, { recursive: true, force: true, maxRetries: 3 })
    await sleep(intervalMs)
  }
  if (existsSync(path)) {
    throw Object.assign(new Error(`目录在清除后仍被重建：${path}`), { code: 'artifact-resurrected' })
  }
}

/**
 * 在 DSH sessions 根目录下按会话 ID 定位其记录文件。
 *
 * DSH 0.1.7 起 sessionPersistence 服务不再暴露 locate()/物理路径（快照只给
 * sizeBytes 等派生信息）。会话记录实际存放在
 * `<sessionsRoot>/<工作目录编码>/<sessionId>/session.*`，本插件需要物理
 * 移动文件（移入回收站/恢复/清除），因此这里自行扫描定位；找不到时返回
 * undefined，与旧 locate() 对内存型后端的语义一致。
 */
export function locateSessionArtifact(sessionsRoot: string, sessionId: string): string | undefined {
  if (!isSessionId(sessionId)) return undefined
  let workdirs
  try {
    workdirs = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of workdirs) {
    if (!entry.isDirectory()) continue
    const sessionDir = join(sessionsRoot, entry.name, sessionId)
    if (!existsSync(sessionDir)) continue
    let files
    try {
      files = readdirSync(sessionDir)
    } catch {
      continue
    }
    const artifact = files.find((file) => file.startsWith('session.') && !file.endsWith('.lock'))
    if (artifact !== undefined) return join(sessionDir, artifact)
  }
  return undefined
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

/**
 * 从域全局状态中读出清除墓碑列表（容忍旧版本数据缺 purged 字段）。
 */
export function purgedTombstonesOf(value: unknown): Array<{ sessionId: string; originalPath: string; purgedAt: number }> {
  if (value === null || typeof value !== 'object') return []
  const purged = (value as { purged?: unknown }).purged
  return Array.isArray(purged)
    ? purged.filter((entry): entry is { sessionId: string; originalPath: string; purgedAt: number } =>
        entry !== null && typeof entry === 'object'
          && typeof (entry as { sessionId?: unknown }).sessionId === 'string'
          && typeof (entry as { originalPath?: unknown }).originalPath === 'string'
          && typeof (entry as { purgedAt?: unknown }).purgedAt === 'number',
      )
    : []
}

/**
 * 插入或刷新一枚清除墓碑（同一会话只保留最新一枚）。
 */
export function upsertPurgedTombstone(
  purged: ReadonlyArray<{ sessionId: string; originalPath: string; purgedAt: number }>,
  tombstone: { sessionId: string; originalPath: string; purgedAt: number },
): Array<{ sessionId: string; originalPath: string; purgedAt: number }> {
  return [...purged.filter((entry) => entry.sessionId !== tombstone.sessionId), tombstone]
}

/**
 * 挑出可以过期移除的墓碑：原位已无副本且距上次清除超过保留期。
 *
 * `resurrected` 之外且未过期的墓碑必须保留——写入器（idle checkpoint、
 * teardown drain）可能在清除完成后很久才把工件写回原位，墓碑是唯一的
 * 事后清理与重新遮蔽依据。
 */
export function selectExpiredTombstones(
  purged: ReadonlyArray<{ sessionId: string; purgedAt: number }>,
  resurrected: ReadonlySet<string>,
  now: number,
  retainMs: number,
): string[] {
  return purged
    .filter((entry) => !resurrected.has(entry.sessionId) && now - entry.purgedAt > retainMs)
    .map((entry) => entry.sessionId)
}
