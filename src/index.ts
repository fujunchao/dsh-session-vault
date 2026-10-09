import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  API_PREFIX,
  type BatchAction,
  type BatchResult,
  type PurgedTombstone,
  type SessionVaultRow,
  type SessionVaultSnapshot,
  type TrashEntry,
} from './contract.js'
import {
  assertUniqueTrashPaths,
  formatFailure,
  isPathInside,
  isLoopbackHost,
  isLoopbackRemoteAddress,
  ensureDirectoryAbsent,
  isSessionId,
  locateSessionArtifact,
  normalizeIds,
  purgedTombstonesOf,
  retainedSessionIds,
  selectExpiredTombstones,
  selectOrphanedIds,
  sessionDirectoryFromArtifact,
  upsertPurgedTombstone,
} from './core.js'

export const name = 'dsh-session-vault'
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'workspaceRegistry', 'agents', 'storageDomain']

const MAX_BODY_BYTES = 256 * 1024
/** 清除墓碑的保留期：覆盖 idle checkpoint / teardown drain 等迟到写回的观察窗口。 */
const TOMBSTONE_RETAIN_MS = 7 * 24 * 60 * 60 * 1000

const trashEntrySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().optional(),
  originalPath: z.string(),
  trashPath: z.string(),
  deletedAt: z.number(),
  sizeBytes: z.number(),
  wasArchived: z.boolean(),
})

const purgedTombstoneSchema = z.object({
  sessionId: z.string(),
  originalPath: z.string(),
  purgedAt: z.number(),
})

const vaultDomainSpec = defineDomain({
  name: 'dsh_session_vault',
  version: 1,
  global: {
    // purged 为可选字段：v0.1.7 及之前的状态文件没有它，域版本不变即可兼容读取。
    schema: z.object({ entries: z.array(trashEntrySchema), purged: z.array(purgedTombstoneSchema).optional() }),
    initial: { entries: [], purged: [] },
  },
  tables: {},
})

interface WorkspaceState {
  initialized: boolean
  workspaceIds: string[]
  archivedSessionIds: string[]
  pendingMutation?: unknown
}

interface ProjectionCacheRecord {
  identity?: { createdAt?: number; cwd?: string }
  rows?: {
    title?: { val?: unknown }
    sessionStats?: { val?: unknown }
  }
}

interface ProjectionCacheDomain {
  table(name: string): {
    get(key: string): ProjectionCacheRecord | undefined
    delete(key: string): Promise<boolean>
    keys(): IterableIterator<string>
  }
}

interface InternalWorkspaceRegistry {
  requireState(): WorkspaceState
  setState(state: WorkspaceState): Promise<void>
}

/** SessionStore 中单个存活会话的内部条目（dsh-session 的 SessionStore.enter 所安装）。 */
interface LiveSessionStoreEntry {
  id: string
  appending?: boolean
  announcing?: boolean
  detachRequested?: boolean
  detach?(): void
}

/** 进程内会话内存 store（ctx.sessions，服务名 "sessions"）上本插件用到的公开面。 */
interface LiveSessionStore {
  get(id: string): unknown
  liveEntryFor(session: unknown): LiveSessionStoreEntry
}

function sessionsRoot(): string {
  return dshHomePath('sessions')
}

function trashRoot(): string {
  return join(dshHomePath('session-vault'), 'trash')
}

function purgingRoot(): string {
  return join(dshHomePath('session-vault'), 'purging')
}

function trashPathFor(sessionId: string): string {
  return join(trashRoot(), sessionId)
}

function purgingPathFor(sessionId: string): string {
  return join(purgingRoot(), sessionId)
}

function workspaceInternals(ctx: Context): InternalWorkspaceRegistry {
  const registry = ctx.workspaceRegistry as unknown as Partial<InternalWorkspaceRegistry>
  if (typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
    throw Object.assign(new Error('当前 DSH 版本未暴露取消归档所需的状态原语'), {
      code: 'unarchive-unsupported',
      status: 501,
    })
  }
  return registry as InternalWorkspaceRegistry
}

function liveSessionStore(ctx: Context): LiveSessionStore | undefined {
  const store = (ctx as unknown as { sessions?: Partial<LiveSessionStore> }).sessions
  if (store === undefined || typeof store.get !== 'function' || typeof store.liveEntryFor !== 'function') {
    return undefined
  }
  return store as LiveSessionStore
}

function assertPurgeIdle(ctx: Context, sessionId: string): void {
  if (ctx.agents.get(sessionId as SessionId)?.status === 'running') {
    throw Object.assign(new Error('会话正在运行，请先停止该会话后再永久清除'), {
      code: 'session-busy', status: 409,
    })
  }
}

/**
 * 把仍存活于宿主进程内存中的会话从 SessionStore 里驱逐。
 *
 * 背景：0.1.5 的会话列表（sessionQuery.listSessions）以 live 会话优先于持久化记录合并，
 * 而本插件的「清除」只删除磁盘工件并解除工作区关联，进程内的会话对象（只要 Web UI
 * 打开过该会话就会存在）并不会随之消失。此时该会话既无归档遮蔽、也无工作区归属，
 * 恰好命中 UI「未分组」分组的全部特征——于是刚被清除的会话立刻全部回到侧边栏。
 *
 * DSH 没有公开的按 id 删除会话 API，这里通过 `get` / `liveEntryFor` 取得
 * store 条目，再调用条目自带的 `detach` 闭包（移除 store 记录、解除 attachments
 * 映射、发出 session/disposed）。对正在发布事件的会话采用与内部 detach 闭包一致的
 * 延迟语义（置 detachRequested，由发布流程结束时自行落钩）。释放未完成时必须抛错，
 * 由清除事务保留归档遮蔽和待重试目录，不能当成成功继续解除隐藏。
 *
 * @returns 是否驱逐了一个存活会话；会话本就不在内存中时返回 false（正常路径，
 * 例如启动对账清理的会话从未被 UI 打开过）。
 */
function evictLiveSession(ctx: Context, sessionId: string): boolean {
  assertPurgeIdle(ctx, sessionId)
  const session = ctx.sessions.get(sessionId as SessionId)
  if (session === undefined) return false
  const store = liveSessionStore(ctx)
  if (store === undefined) {
    throw Object.assign(new Error('当前 DSH 版本不支持释放已加载的会话'), {
      code: 'session-release-unsupported', status: 501,
    })
  }
  const entry = store.liveEntryFor(session)
  if (typeof entry.detach !== 'function') {
    throw Object.assign(new Error('当前会话缺少释放方法'), { code: 'session-release-unsupported', status: 501 })
  }
  if (entry.appending === true || entry.announcing === true) entry.detachRequested = true
  else entry.detach()
  if (store.get(sessionId) !== undefined) {
    throw Object.assign(new Error('会话尚未完成释放，保留隐藏状态等待重试'), { code: 'session-release-pending', status: 409 })
  }
  ctx.logger.info(`[dsh-session-vault] 已从内存中释放被清除的会话 ${sessionId}`)
  return true
}

function projectionCache(ctx: Context): ProjectionCacheDomain | undefined {
  return ctx.storageDomain.get('session_projcache') as unknown as ProjectionCacheDomain | undefined
}

/**
 * 把持久化层的全部打开写入句柄当场冲刷落盘（尽力而为）。
 *
 * DSH 0.2 的 jsonl 写入器按 header（cwd+id）推导落盘路径：批量窗口、
 * `session/flush`（idle checkpoint / teardown drain）以及句柄关闭
 * （session/disposed → writer.close()，异步且不被任何调用方等待）都会
 * `mkdir + 写`把目录重新 materialize 回原位——即使它已被移入回收站或清除。
 * 其中「materialized=false 的句柄在之后任意一次 flush 时写回」没有时限，
 * 任何清除后的限时轮询守卫都等不到它。
 *
 * 在移动/驱逐**之前**调用 flushAll，可以把该会话的在途事件与未落盘头
 * 当场冲到原位并置 materialized=true；随后的 rename/删除把这份落盘结果
 * 一并带走，之后所有 flush 直接短路，写回源头被确定性消除。flushAll 失败
 * 只降级为旧的守卫+墓碑兜底，绝不阻断事务。
 */
async function flushPersistence(ctx: Context): Promise<void> {
  const service = ctx.sessionPersistence as unknown as { flushAll?: () => Promise<void> }
  if (typeof service.flushAll !== 'function') return
  try {
    await service.flushAll()
  } catch (error) {
    ctx.logger.warn('[dsh-session-vault] 清除前的持久化冲刷未完成，降级为守卫+墓碑兜底', error)
  }
}

interface VaultDomain {
  global: {
    get(): unknown
    set(value: unknown): Promise<void>
  }
}

function entriesOf(domain: { global: { get(): unknown } }): TrashEntry[] {
  const value = domain.global.get() as { entries?: TrashEntry[] }
  return Array.isArray(value.entries) ? value.entries : []
}

function purgedOf(domain: { global: { get(): unknown } }): PurgedTombstone[] {
  return purgedTombstonesOf(domain.global.get())
}

async function saveDomainState(domain: VaultDomain, entries: TrashEntry[], purged: PurgedTombstone[]): Promise<void> {
  assertUniqueTrashPaths(entries)
  await domain.global.set({ entries, purged })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type']
  if (typeof contentType === 'string' && !/^application\/json\b/i.test(contentType)) {
    throw Object.assign(new Error('请求必须使用 application/json'), { code: 'unsupported-media-type', status: 415 })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('请求体过大'), { code: 'body-too-large', status: 413 })
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('请求体不是有效 JSON'), { code: 'bad-json', status: 400 })
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function writeOk<T>(res: ServerResponse, value: T): void {
  writeJson(res, 200, { ok: true, value })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

function trustedRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return false
  const host = header(req, 'host')
  if (host === undefined) return false
  let authority: URL
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(authority.hostname)) return false
  if (header(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  const stack = [path]
  while (stack.length > 0) {
    const current = stack.pop()!
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      const full = join(current, child.name)
      if (child.isDirectory()) stack.push(full)
      else if (child.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // 目录扫描期间文件可能被另一个进程移除。
        }
      }
    }
  }
  return total
}

function titleFromCache(record: ProjectionCacheRecord | undefined, sessionId: string): string {
  const value = record?.rows?.title?.val
  return typeof value === 'string' && value.trim() !== '' ? value : sessionId
}

function workspaceTitle(ctx: Context, sessionId: string): string | undefined {
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (workspace.sessionIds.includes(sessionId as SessionId)) return workspace.title
  }
  return undefined
}

/**
 * 兼容 dsh 0.1.1 与 0.1.5 的 sessionPersistence.list() 返回结构：
 * 0.1.5 起 list() 返回 { header, revision, sizeBytes? } 快照数组，
 * 0.1.1 直接返回 header 数组。统一展开成 header 列表。
 */
function persistenceHeaders(snapshots: readonly unknown[]): SessionHeader[] {
  return (Array.isArray(snapshots) ? snapshots : []).map((entry) =>
    entry !== null && typeof entry === 'object' && 'header' in entry
      ? (entry as { header: SessionHeader }).header
      : (entry as SessionHeader),
  )
}

async function listSnapshot(ctx: Context, domain: VaultDomain): Promise<SessionVaultSnapshot> {
  const headers = persistenceHeaders(await ctx.sessionPersistence.list())
  const known = new Set<string>(headers.map((header) => String(header.id)))

  // 会话可能在本进程运行期间被外部删除（手动删目录、其它工具等），只在启动时对账
  // 会让这些孤儿一直残留到下次重启，表现为「归档」计数为 0、归档标记却还剩一堆。
  // 这里复用刚刚成功取得的会话列举顺带自愈；对账失败不影响快照本身。
  try {
    await reconcileOrphanedState(ctx, known, domain)
  } catch (error) {
    ctx.logger.warn('[dsh-session-vault] 读取快照时的孤儿对账未完成', error)
  }

  // 每次快照顺带巡检清除墓碑：迟到的写入器复活副本在用户打开保险库时即被
  // 清理并重新遮蔽，而不是以「未分组」会话的身份留在侧边栏里。
  try {
    await sweepPurgedTombstones(ctx, domain)
  } catch (error) {
    ctx.logger.warn('[dsh-session-vault] 读取快照时的清除墓碑巡检未完成', error)
  }

  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String))
  const cache = projectionCache(ctx)?.table('sessions')
  const rows: SessionVaultRow[] = []

  for (const header of headers) {
    const sessionId = String(header.id)
    const record = cache?.get(sessionId)
    const artifact = locateSessionArtifact(sessionsRoot(), sessionId)
    let sizeBytes = 0
    let updatedAt = record?.identity?.createdAt ?? header.createdAt
    if (artifact !== undefined) {
      try {
        const info = await stat(artifact)
        sizeBytes = info.size
        updatedAt = info.mtimeMs
      } catch {
        // 列表仍保留条目，便于用户发现损坏或缺失的记录。
      }
    }
    rows.push({
      sessionId,
      title: titleFromCache(record, sessionId),
      cwd: header.cwd,
      createdAt: header.createdAt,
      updatedAt,
      archived: archived.has(sessionId),
      running: ctx.agents.get(header.id)?.status === 'running',
      sizeBytes,
      workspaceTitle: workspaceTitle(ctx, sessionId),
    })
  }

  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.sessionId.localeCompare(b.sessionId))
  const trash = [...entriesOf(domain)].sort((a, b) => b.deletedAt - a.deletedAt)
  return {
    sessions: rows,
    trash,
    counts: {
      active: rows.filter((row) => !row.archived).length,
      archived: rows.filter((row) => row.archived).length,
      trash: trash.length,
    },
  }
}

async function headerById(ctx: Context, sessionId: string): Promise<SessionHeader> {
  const header = persistenceHeaders(await ctx.sessionPersistence.list()).find((candidate) => String(candidate.id) === sessionId)
  if (header === undefined) {
    throw Object.assign(new Error('找不到该会话记录'), { code: 'session-not-found', status: 404 })
  }
  return header
}

let mutationTail: Promise<void> = Promise.resolve()
function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation)
  mutationTail = result.then(() => undefined, () => undefined)
  return result
}

async function setArchived(ctx: Context, sessionId: string, archived: boolean): Promise<void> {
  if (archived) {
    await ctx.workspaceRegistry.archiveSession(sessionId as SessionId)
    return
  }
  const registry = workspaceInternals(ctx)
  const state = registry.requireState()
  if (!state.archivedSessionIds.includes(sessionId)) return
  await registry.setState({
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
  })
}

/**
 * 巡检清除墓碑：清掉迟到的写入器复活副本，并让过期墓碑退役。
 *
 * 永久清除解除归档遮蔽后，任何迟到写回原位的副本都会以「未分组」形式出现在
 * 侧边栏（宿主列表 = 磁盘扫描 ∪ 内存 live 会话）。前置冲刷消除了已知写回源，
 * 但冲刷失败、宿主行为变化等残余风险仍在——墓碑让这些副本在启动时和每次
 * 读取快照时被发现：物理删除、重新遮蔽（隐藏幽灵）、刷新观察期。原位连续
 * 7 天无复活的墓碑才允许退役。
 */
async function sweepPurgedTombstones(ctx: Context, domain: VaultDomain): Promise<void> {
  const purged = purgedOf(domain)
  if (purged.length === 0) return
  const now = Date.now()
  const resurrected = new Set<string>()

  for (const tombstone of purged) {
    if (!isPathInside(sessionsRoot(), tombstone.originalPath)) continue
    if (!existsSync(tombstone.originalPath)) continue
    resurrected.add(tombstone.sessionId)
    try {
      await rm(tombstone.originalPath, { recursive: true, force: true, maxRetries: 3 })
      await setArchived(ctx, tombstone.sessionId, true)
      const cache = projectionCache(ctx)
      if (cache !== undefined) await cache.table('sessions').delete(tombstone.sessionId)
      ctx.logger.warn(`[dsh-session-vault] 已清除迟到的写入器复活副本并重新遮蔽：${tombstone.sessionId}`)
    } catch (error) {
      ctx.logger.warn(`[dsh-session-vault] 清除复活副本失败，保留墓碑继续观察：${tombstone.sessionId}`, error)
    }
  }

  let next = purged
  if (resurrected.size > 0) {
    next = next.map((tombstone) => resurrected.has(tombstone.sessionId) ? { ...tombstone, purgedAt: now } : tombstone)
  }
  const expired = new Set(selectExpiredTombstones(next, resurrected, now, TOMBSTONE_RETAIN_MS))
  if (expired.size > 0) {
    next = next.filter((tombstone) => !expired.has(tombstone.sessionId))
  }
  if (next !== purged) await saveDomainState(domain, entriesOf(domain), next)
}

async function finalizeCommittedPurge(ctx: Context, sessionId: string, stagedPath: string, originalDir: string | undefined): Promise<void> {
  if (!isPathInside(purgingRoot(), stagedPath)) {
    throw Object.assign(new Error('待清除目录未通过安全校验'), { code: 'unsafe-purging-path', status: 500 })
  }

  // 磁盘记录与内存实例都消失后才能解除归档遮蔽，否则宿主合并会话列表时
  // 仍会把已移出工作区的 live 会话显示到「未分组」。释放失败不得继续清理。
  // 保留空的隔离目录作为重试标记，直到文件、工作区和缓存全部处理完成。
  await mkdir(stagedPath, { recursive: true })
  // 必须在驱逐之前冲刷：session/disposed 触发的 writer.close() 是异步且不被
  // 等待的 drain+flush，先冲刷可让句柄缓冲清空、materialized 置位，驱逐后的
  // 关闭不再有任何内容可写回原位。
  await flushPersistence(ctx)
  evictLiveSession(ctx, sessionId)
  for (const child of await readdir(stagedPath)) {
    await rm(join(stagedPath, child), { recursive: true, force: true, maxRetries: 3 })
  }

  // 会话写入器按 header（cwd+id）推导路径且关闭时补落盘：前置冲刷后这里的
  // 轮询删除的是「已经落地」的副本（确定性），窗口仅兜底吸收残余竞态；
  // 重试耗尽仍存在时抛错，由调用方保留归档遮蔽走重试路径。
  if (originalDir !== undefined && isPathInside(sessionsRoot(), originalDir)) {
    await ensureDirectoryAbsent(originalDir)
  }

  for (const workspace of ctx.workspaceRegistry.list()) {
    if (workspace.sessionIds.map(String).includes(sessionId)) {
      await workspace.detachSession(sessionId as SessionId)
    }
  }
  await setArchived(ctx, sessionId, false)
  const cache = projectionCache(ctx)
  if (cache !== undefined) await cache.table('sessions').delete(sessionId)
  await rm(stagedPath, { recursive: true, force: true, maxRetries: 3 })
}

async function reconcilePendingPurges(
  ctx: Context,
  domain: { global: { get(): unknown } },
): Promise<void> {
  await mkdir(purgingRoot(), { recursive: true })
  const entries = entriesOf(domain)
  const bySessionId = new Map(entries.map((entry) => [entry.sessionId, entry]))
  const children = await readdir(purgingRoot(), { withFileTypes: true })

  for (const child of children) {
    if (!child.isDirectory() || !isSessionId(child.name)) {
      ctx.logger.warn(`[dsh-session-vault] 忽略无法识别的待清除项：${child.name}`)
      continue
    }

    const stagedPath = purgingPathFor(child.name)
    const entry = bySessionId.get(child.name)
    if (entry !== undefined) {
      if (!isPathInside(trashRoot(), entry.trashPath)) {
        ctx.logger.warn(`[dsh-session-vault] 无法恢复未提交的清除操作，路径不安全：${entry.trashPath}`)
        continue
      }
      if (existsSync(entry.trashPath)) {
        ctx.logger.warn(`[dsh-session-vault] 回收站与待清除区同时存在会话：${child.name}`)
        continue
      }
      try {
        await mkdir(dirname(entry.trashPath), { recursive: true })
        await rename(stagedPath, entry.trashPath)
      } catch (error) {
        ctx.logger.warn(`[dsh-session-vault] 恢复未提交的清除操作失败：${child.name}`, error)
      }
      continue
    }

    try {
      // 重试时回收站条目已删除，改为按会话 ID 重新扫描原位（含写入器重建的副本）。
      const resurrected = locateSessionArtifact(sessionsRoot(), child.name)
      await finalizeCommittedPurge(
        ctx,
        child.name,
        stagedPath,
        resurrected === undefined ? undefined : sessionDirectoryFromArtifact(sessionsRoot(), resurrected),
      )
    } catch (error) {
      ctx.logger.warn(`[dsh-session-vault] 完成已提交的清除操作失败，将在下次启动重试：${child.name}`, error)
    }
  }
}

/**
 * 对账进程外被删除的会话留下的孤儿状态。
 *
 * 归档标记与投影缓存都以 sessionId 为键长期保存，而列表逻辑只正向遍历现存会话，
 * 因此会话若不经由本插件删除（手动删除目录、外部工具等），这些键会静默堆积，
 * 并且在界面上完全不可见——最典型的症状是「归档」计数为 0，归档标记却还剩一堆。
 *
 * 安全约束：`existing` 必须来自一次**成功**的会话列举，由调用方负责。列举失败时调用方
 * 应直接放弃本轮对账，而不是传入空集合——否则一次存储故障就会被误判为会话全部不
 * 存在，进而清空用户的归档状态。
 *
 * 回收站中的会话已被移出 sessions 目录、不在列举结果内，但由本插件托管且可恢复，
 * 因此在这里并入保留集合。宿主内存中仍存活的会话也必须保留：列举磁盘文件无法
 * 证明它们已经消失，尤其是释放失败、等待重试的清除操作不能被对账提前解除隐藏。
 *
 * @param existing 现存会话 id 集合，来自一次成功的 `sessionPersistence.list()`。
 * @param domain 回收站元数据域，用于取得当前待恢复的会话。
 * @returns 本次清理掉的条目数；为 0 时不发生任何写入。
 */
async function reconcileOrphanedState(
  ctx: Context,
  existing: ReadonlySet<string>,
  domain: { global: { get(): unknown } },
): Promise<number> {
  const known = retainedSessionIds(existing, [
    ...entriesOf(domain).map((entry) => entry.sessionId),
    ...ctx.sessions.list().map((session) => String(session.id)),
  ])
  let removed = 0

  const registry = workspaceInternals(ctx)
  const state = registry.requireState()
  const orphaned = selectOrphanedIds(state.archivedSessionIds, known)
  if (orphaned.length > 0) {
    const orphanedSet = new Set(orphaned)
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter((id) => !orphanedSet.has(id)),
    })
    removed += orphaned.length
    ctx.logger.info(`[dsh-session-vault] 已清理 ${orphaned.length} 个指向已删除会话的归档标记`)
  }

  const cache = projectionCache(ctx)?.table('sessions')
  if (cache === undefined) return removed
  const stale = selectOrphanedIds([...cache.keys()], known)
  for (const key of stale) {
    await cache.delete(key)
  }
  if (stale.length > 0) {
    ctx.logger.info(`[dsh-session-vault] 已清理 ${stale.length} 条指向已删除会话的投影缓存`)
  }
  return removed + stale.length
}

async function moveToTrash(ctx: Context, domain: { global: { get(): unknown; set(value: unknown): Promise<void> } }, sessionId: string): Promise<void> {
  const existing = entriesOf(domain)
  if (existing.some((entry) => entry.sessionId === sessionId)) return

  const header = await headerById(ctx, sessionId)
  const agent = ctx.agents.get(header.id)
  if (agent?.status === 'running') {
    throw Object.assign(new Error('会话正在运行，请先停止该会话后再移入回收站'), {
      code: 'session-busy',
      status: 409,
    })
  }
  if (agent !== undefined) {
    // 只要 Web UI 打开过该会话，进程内就会留下一个空闲 agent 实例，且 DSH 未提供
    // 单独关闭它的接口。仅凭实例存在就拒绝删除会让会话在正常使用下几乎无法清理，
    // 因此这里只拦截真正运行中的会话，空闲实例记录日志后放行。
    ctx.logger.info(`[dsh-session-vault] 会话 ${sessionId} 仍在当前进程中打开但处于空闲状态，继续移入回收站`)
  }

  const artifact = locateSessionArtifact(sessionsRoot(), sessionId)
  if (artifact === undefined) {
    throw Object.assign(new Error('当前持久化后端没有独立会话记录，无法安全移动'), {
      code: 'artifact-unavailable',
      status: 501,
    })
  }
  const originalPath = sessionDirectoryFromArtifact(sessionsRoot(), artifact)
  if (!existsSync(originalPath)) {
    throw Object.assign(new Error('会话记录目录不存在'), { code: 'artifact-not-found', status: 404 })
  }

  const cache = projectionCache(ctx)?.table('sessions')
  const title = titleFromCache(cache?.get(sessionId), sessionId)
  const wasArchived = ctx.workspaceRegistry.archivedSessionIds.map(String).includes(sessionId)
  const trashPath = trashPathFor(sessionId)
  const entry: TrashEntry = {
    sessionId,
    title,
    cwd: header.cwd,
    originalPath,
    trashPath,
    deletedAt: Date.now(),
    sizeBytes: await directorySize(originalPath),
    wasArchived,
  }

  await mkdir(trashRoot(), { recursive: true })
  if (existsSync(trashPath)) {
    throw Object.assign(new Error('回收站中已存在同名目录，请先检查数据'), { code: 'trash-collision', status: 409 })
  }

  // rename 前先冲刷：把写入器的在途事件与未落盘句柄当场冲到原位（随 rename
  // 一并进回收站）并置 materialized，杜绝回收站期间任意时刻的写回复活。
  await flushPersistence(ctx)

  let moved = false
  let archiveChanged = false
  try {
    await setArchived(ctx, sessionId, true)
    archiveChanged = !wasArchived
    await rename(originalPath, trashPath)
    moved = true
    // 会话重新进入插件托管，同名旧墓碑（若有）随之退役，避免巡检误删恢复数据。
    await saveDomainState(domain, [...existing, entry], purgedOf(domain).filter((tombstone) => tombstone.sessionId !== sessionId))
    // 写入器的 200ms 批量落盘窗口可能在 rename 后把记录写回原位；尽力清理，
    // 残留副本交由永久清除的原位守卫兜底（此处失败不影响回收站事务）。
    try {
      await ensureDirectoryAbsent(originalPath, { attempts: 3, intervalMs: 250 })
    } catch (resurrected) {
      ctx.logger.warn(`[dsh-session-vault] 会话 ${sessionId} 移入回收站后原位出现写入器重建副本，将在永久清除时一并处理`, resurrected)
    }
  } catch (error) {
    if (moved && existsSync(trashPath) && !existsSync(originalPath)) {
      await mkdir(dirname(originalPath), { recursive: true }).catch(() => {})
      await rename(trashPath, originalPath).catch(() => {})
    }
    if (archiveChanged) await setArchived(ctx, sessionId, false).catch(() => {})
    throw error
  }
}

async function restoreTrash(ctx: Context, domain: { global: { get(): unknown; set(value: unknown): Promise<void> } }, sessionId: string): Promise<void> {
  const entries = entriesOf(domain)
  const entry = entries.find((candidate) => candidate.sessionId === sessionId)
  if (entry === undefined) {
    throw Object.assign(new Error('回收站中没有该会话'), { code: 'trash-not-found', status: 404 })
  }
  if (!isPathInside(trashRoot(), entry.trashPath) || !isPathInside(sessionsRoot(), entry.originalPath)) {
    throw Object.assign(new Error('回收站记录路径未通过安全校验'), { code: 'unsafe-trash-path', status: 500 })
  }
  if (!existsSync(entry.trashPath)) {
    throw Object.assign(new Error('回收站记录目录已丢失'), { code: 'trash-artifact-not-found', status: 404 })
  }
  if (existsSync(entry.originalPath)) {
    throw Object.assign(new Error('原位置已有同名会话记录，未覆盖现有数据'), { code: 'restore-collision', status: 409 })
  }

  await mkdir(dirname(entry.originalPath), { recursive: true })
  await rename(entry.trashPath, entry.originalPath)
  try {
    await setArchived(ctx, sessionId, entry.wasArchived)
    // 恢复成功的会话重新归用户所有，同名旧墓碑（若有）必须退役，否则巡检会把
    // 刚恢复的记录当复活副本删掉。
    await saveDomainState(domain, entries.filter((candidate) => candidate.sessionId !== sessionId), purgedOf(domain).filter((tombstone) => tombstone.sessionId !== sessionId))
  } catch (error) {
    await rename(entry.originalPath, entry.trashPath).catch(() => {})
    await setArchived(ctx, sessionId, true).catch(() => {})
    throw error
  }
}

async function purgeTrash(ctx: Context, domain: { global: { get(): unknown; set(value: unknown): Promise<void> } }, sessionId: string): Promise<void> {
  const entries = entriesOf(domain)
  const entry = entries.find((candidate) => candidate.sessionId === sessionId)
  if (entry === undefined) {
    throw Object.assign(new Error('回收站中没有该会话'), { code: 'trash-not-found', status: 404 })
  }
  assertPurgeIdle(ctx, sessionId)
  if (!isPathInside(trashRoot(), entry.trashPath)) {
    throw Object.assign(new Error('回收站记录路径未通过安全校验'), { code: 'unsafe-trash-path', status: 500 })
  }

  await mkdir(purgingRoot(), { recursive: true })
  const stagedPath = purgingPathFor(sessionId)
  if (existsSync(stagedPath)) {
    throw Object.assign(new Error('待清除区中已存在同名目录，请重启 DSH 让插件自动恢复'), {
      code: 'purging-collision',
      status: 409,
    })
  }

  let staged = false
  if (existsSync(entry.trashPath)) {
    await rename(entry.trashPath, stagedPath)
    staged = true
  }
  try {
    // 条目删除与墓碑登记放进同一次全局写入：状态要么同时落定、要么同时回滚。
    // 墓碑保证清除提交后原位再出现的任何副本都会被巡检删除并重新遮蔽。
    const purgedNext = upsertPurgedTombstone(purgedOf(domain), {
      sessionId,
      originalPath: entry.originalPath,
      purgedAt: Date.now(),
    })
    await saveDomainState(domain, entries.filter((candidate) => candidate.sessionId !== sessionId), purgedNext)
  } catch (error) {
    if (staged && existsSync(stagedPath) && !existsSync(entry.trashPath)) {
      await rename(stagedPath, entry.trashPath).catch(() => {})
    }
    throw error
  }

  try {
    await finalizeCommittedPurge(ctx, sessionId, stagedPath, entry.originalPath)
  } catch (error) {
    ctx.logger.warn(`[dsh-session-vault] 会话已从回收站提交清除，但物理清理尚未完成，将在下次启动重试：${sessionId}`, error)
    throw Object.assign(new Error('会话已提交清除，但剩余清理未完成；请重启 DSH 自动重试', { cause: error }), {
      code: 'purge-pending', status: 503,
    })
  }
}

async function perform(ctx: Context, domain: { global: { get(): unknown; set(value: unknown): Promise<void> } }, action: BatchAction, ids: string[]): Promise<BatchResult> {
  const result: BatchResult = { succeeded: [], failed: [] }
  for (const sessionId of ids) {
    try {
      await mutate(async () => {
        if (action === 'archive') await setArchived(ctx, sessionId, true)
        else if (action === 'unarchive') await setArchived(ctx, sessionId, false)
        else if (action === 'trash') await moveToTrash(ctx, domain, sessionId)
        else if (action === 'restore') await restoreTrash(ctx, domain, sessionId)
        else await purgeTrash(ctx, domain, sessionId)
      })
      result.succeeded.push(sessionId)
    } catch (error) {
      const failure = formatFailure(error)
      result.failed.push({ sessionId, code: failure.code, message: failure.message })
    }
  }
  return result
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const domain = await ctx.storageDomain.open(vaultDomainSpec)
  await mkdir(trashRoot(), { recursive: true })
  await reconcilePendingPurges(ctx, domain)
  try {
    const headers = persistenceHeaders(await ctx.sessionPersistence.list())
    await reconcileOrphanedState(ctx, new Set<string>(headers.map((header) => String(header.id))), domain)
  } catch (error) {
    // 对账属于尽力而为的清理：读不到会话列表或当前 DSH 未暴露状态原语时保持原样，
    // 留待下次读取快照或下次启动时重试，绝不因此让插件加载失败。
    ctx.logger.warn('[dsh-session-vault] 启动时的孤儿对账未完成，稍后重试', error)
  }
  try {
    // 上次运行退出（teardown drain）可能把已清除会话写回原位：必须在 web UI
    // 能列出会话之前清掉并重新遮蔽，否则用户一启动就会看到「未分组」幽灵。
    await sweepPurgedTombstones(ctx, domain)
  } catch (error) {
    ctx.logger.warn('[dsh-session-vault] 启动时的清除墓碑巡检未完成，稍后重试', error)
  }

  const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '仅允许本机同源请求' } })
      const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : ''
      try {
        // 快照包含会修改归档标记的对账，必须与清除共用队列，避免读取半完成事务。
        if (req.method === 'GET' && method === 'snapshot') return writeOk(res, await mutate(() => listSnapshot(ctx, domain)))
        if (req.method !== 'POST') {
          return writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '请求方法不受支持' } })
        }
        if (method !== 'batch') {
          return writeJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知接口' } })
        }
        const body = await readJson(req) as { action?: unknown; sessionIds?: unknown }
        const action = body.action
        if (action !== 'archive' && action !== 'unarchive' && action !== 'trash' && action !== 'restore' && action !== 'purge') {
          throw Object.assign(new Error('无效操作'), { code: 'invalid-action', status: 400 })
        }
        const ids = normalizeIds(body.sessionIds)
        if (ids.length === 0) throw Object.assign(new Error('没有有效的会话标识'), { code: 'empty-selection', status: 400 })
        if (ids.length > 200) throw Object.assign(new Error('单次最多处理 200 个会话'), { code: 'too-many-sessions', status: 400 })
        writeOk(res, await perform(ctx, domain, action, ids))
      } catch (error) {
        const failure = formatFailure(error)
        ctx.logger.warn('[dsh-session-vault] request failed:', error)
        writeJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
      }
    },
  })

  return async () => {
    unregister()
    await domain.close()
  }
}

export default { name, inject, apply }
