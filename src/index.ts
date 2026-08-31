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
  isSessionId,
  normalizeIds,
  retainedSessionIds,
  selectOrphanedIds,
  sessionDirectoryFromArtifact,
} from './core.js'

export const name = 'dsh-session-vault'
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'agents', 'storageDomain']

const MAX_BODY_BYTES = 256 * 1024
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

const vaultDomainSpec = defineDomain({
  name: 'dsh_session_vault',
  version: 1,
  global: {
    schema: z.object({ entries: z.array(trashEntrySchema) }),
    initial: { entries: [] },
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

function projectionCache(ctx: Context): ProjectionCacheDomain | undefined {
  return ctx.storageDomain.get('session_projcache') as unknown as ProjectionCacheDomain | undefined
}

function entriesOf(domain: { global: { get(): unknown } }): TrashEntry[] {
  const value = domain.global.get() as { entries?: TrashEntry[] }
  return Array.isArray(value.entries) ? value.entries : []
}

async function saveEntries(domain: { global: { set(value: unknown): Promise<void> } }, entries: TrashEntry[]): Promise<void> {
  assertUniqueTrashPaths(entries)
  await domain.global.set({ entries })
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

async function listSnapshot(ctx: Context, domain: { global: { get(): unknown } }): Promise<SessionVaultSnapshot> {
  const headers = await ctx.sessionPersistence.list()
  const known = new Set<string>(headers.map((header) => String(header.id)))

  // 会话可能在本进程运行期间被外部删除（手动删目录、其它工具等），只在启动时对账
  // 会让这些孤儿一直残留到下次重启，表现为「归档」计数为 0、归档标记却还剩一堆。
  // 这里复用刚刚成功取得的会话列举顺带自愈；对账失败不影响快照本身。
  try {
    await reconcileOrphanedState(ctx, known, domain)
  } catch (error) {
    ctx.logger.warn('[dsh-session-vault] 读取快照时的孤儿对账未完成', error)
  }

  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String))
  const cache = projectionCache(ctx)?.table('sessions')
  const rows: SessionVaultRow[] = []

  for (const header of headers) {
    const sessionId = String(header.id)
    const record = cache?.get(sessionId)
    const location = ctx.sessionPersistence.locate(header)
    let sizeBytes = 0
    let updatedAt = record?.identity?.createdAt ?? header.createdAt
    if (location?.path !== undefined) {
      try {
        const info = await stat(location.path)
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
  const header = (await ctx.sessionPersistence.list()).find((candidate) => String(candidate.id) === sessionId)
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

async function finalizeCommittedPurge(ctx: Context, sessionId: string, stagedPath: string): Promise<void> {
  if (!isPathInside(purgingRoot(), stagedPath)) {
    throw Object.assign(new Error('待清除目录未通过安全校验'), { code: 'unsafe-purging-path', status: 500 })
  }

  // 顺序很重要：必须先物理删除，再解除归档遮蔽并清理索引。
  //
  // 反过来做会留下一个窗口——记录仍在磁盘上，却已经被移出工作区、也不再带归档标记，
  // 此时它恰好符合「未分组的普通会话」的全部特征，会重新出现在侧边栏中。
  //
  // 先删文件则不存在该窗口：若后续状态清理中断，最坏只剩下指向已删除会话的孤儿标记，
  // 而那正是 reconcileOrphanedState 每次读取快照时会自动收拾的东西。
  await rm(stagedPath, { recursive: true, force: true, maxRetries: 3 })

  for (const workspace of ctx.workspaceRegistry.list()) {
    if (workspace.sessionIds.map(String).includes(sessionId)) {
      await workspace.detachSession(sessionId as SessionId)
    }
  }
  await setArchived(ctx, sessionId, false)
  const cache = projectionCache(ctx)
  if (cache !== undefined) await cache.table('sessions').delete(sessionId)
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
      await finalizeCommittedPurge(ctx, child.name, stagedPath)
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
 * 因此在这里并入保留集合。漏掉它们会让「移入回收站」时设置的归档遮蔽被立刻清掉，
 * 会话随即重新出现在侧边栏。
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
  const known = retainedSessionIds(existing, entriesOf(domain).map((entry) => entry.sessionId))
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

  const location = ctx.sessionPersistence.locate(header)
  if (location === undefined) {
    throw Object.assign(new Error('当前持久化后端没有独立会话记录，无法安全移动'), {
      code: 'artifact-unavailable',
      status: 501,
    })
  }
  const originalPath = sessionDirectoryFromArtifact(sessionsRoot(), location.path)
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

  let moved = false
  let archiveChanged = false
  try {
    await setArchived(ctx, sessionId, true)
    archiveChanged = !wasArchived
    await rename(originalPath, trashPath)
    moved = true
    await saveEntries(domain, [...existing, entry])
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
    await saveEntries(domain, entries.filter((candidate) => candidate.sessionId !== sessionId))
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
    await saveEntries(domain, entries.filter((candidate) => candidate.sessionId !== sessionId))
  } catch (error) {
    if (staged && existsSync(stagedPath) && !existsSync(entry.trashPath)) {
      await rename(stagedPath, entry.trashPath).catch(() => {})
    }
    throw error
  }

  try {
    await finalizeCommittedPurge(ctx, sessionId, stagedPath)
  } catch (error) {
    ctx.logger.warn(`[dsh-session-vault] 会话已从回收站提交清除，但物理清理尚未完成，将在下次启动重试：${sessionId}`, error)
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
    const headers = await ctx.sessionPersistence.list()
    await reconcileOrphanedState(ctx, new Set<string>(headers.map((header) => String(header.id))), domain)
  } catch (error) {
    // 对账属于尽力而为的清理：读不到会话列表或当前 DSH 未暴露状态原语时保持原样，
    // 留待下次读取快照或下次启动时重试，绝不因此让插件加载失败。
    ctx.logger.warn('[dsh-session-vault] 启动时的孤儿对账未完成，稍后重试', error)
  }

  const unregister = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!trustedRequest(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '仅允许本机同源请求' } })
      const pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : ''
      try {
        if (req.method === 'GET' && method === 'snapshot') return writeOk(res, await listSnapshot(ctx, domain))
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
