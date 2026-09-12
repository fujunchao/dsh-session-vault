import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const pluginRoot = process.env.DSH_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
const requireHost = createRequire(join(process.env.DSH_TEST_HOST_ROOT ?? pluginRoot, 'package.json'))
const { Context } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href)
const { SessionStore } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session')).href)
// 指定宿主目录时额外使用真实会话查询，验证新版 DSH 的内存/持久化合并行为。
const SessionQueryEngine = process.env.DSH_TEST_HOST_ROOT
  ? (await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-query')).href)).SessionQueryEngine
  : undefined
const host = await import(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

/** 只模拟存储/工作区边界；真实加载兄弟插件，不能用根上下文绕过 inject 检查。 */
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vault-integration-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const requests = new EventEmitter()
  const logs = []
  const disposed = []
  let handler
  let vaultFiber
  let routeReady = deferred()
  const server = createServer((req, res) => {
    requests.emit(req.url)
    void handler(req, res)
  })
  t.after(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  ctx.logger.exporters.set('test', { levels: { default: 3 }, export: (message) => logs.push(message) })
  ctx.on('session/disposed', (session) => { disposed.push(session.id) })

  const ids = options.ids ?? ['session-a']
  const liveIds = options.liveIds ?? ids
  const startInTrash = options.startInTrash ?? true
  const workspacePath = join(home, 'workspace')
  await mkdir(workspacePath)
  const sourcePath = join(workspacePath, 'keep.txt')
  await writeFile(sourcePath, '工作区文件不得被会话清理修改\n')
  let state = {
    initialized: true,
    workspaceIds: ['workspace-a'],
    archivedSessionIds: startInTrash ? [...ids] : [],
  }
  let value = { entries: [] }
  const records = new Map()
  const cache = new Map()
  const visibilityWindows = []
  let store
  const workspace = {
    title: '测试工作区', sessionIds: [...ids],
    async detachSession(id) {
      workspace.sessionIds = workspace.sessionIds.filter((candidate) => candidate !== id)
      await options.afterDetach?.(id)
    },
  }
  const persistence = {
    async list() {
      if (options.failList?.()) throw new Error('模拟存储列举失败')
      return [...records.values()].filter((record) => existsSync(record.artifact)).map((record) =>
        options.listFormat === 'headers' ? record.header : { header: record.header, revision: 'fixture' })
    },
    locate(header) { return { path: records.get(header.id).artifact } },
  }
  const domain = {
    global: { get: () => value, async set(next) { value = next } },
    async close() {},
  }
  const servicesReady = deferred()
  ctx.plugin({
    name: 'fixture-host-services',
    apply(serviceCtx) {
      store = new SessionStore(serviceCtx)
      serviceCtx.provide('agents', { get: (id) => options.runningIds?.includes(id) ? { status: 'running' } : undefined })
      serviceCtx.provide('sessionPersistence', persistence)
      serviceCtx.provide('workspaceRegistry', {
        get archivedSessionIds() { return state.archivedSessionIds },
        list: () => [workspace],
        requireState: () => state,
        async setState(next) {
          state = next
          visibilityWindows.push(...store.list().map((session) => session.id).filter((id) =>
            !state.archivedSessionIds.includes(id) && !workspace.sessionIds.includes(id)))
        },
        async archiveSession(id) {
          state = { ...state, archivedSessionIds: [...new Set([...state.archivedSessionIds, id])] }
        },
      })
      serviceCtx.provide('storageDomain', {
        open: async () => domain,
        get: () => ({ table: () => ({
          keys: () => cache.keys(), get: (id) => cache.get(id), delete: async (id) => cache.delete(id),
        }) }),
      })
      serviceCtx.provide('webServer', {
        register(route) { handler = route.handler; routeReady.resolve(); return () => {} },
      })
      servicesReady.resolve()
    },
  })
  await servicesReady.promise
  for (const id of ids) {
    const session = liveIds.includes(id)
      ? store.create(id, { meta: { cwd: workspacePath } })
      : store.prepare(id, { meta: { cwd: workspacePath } })
    const originalPath = join(home, 'sessions/project', id)
    const trashPath = join(home, 'session-vault/trash', id)
    records.set(id, { header: session.header, artifact: join(originalPath, 'session.jsonl') })
    cache.set(id, { rows: { title: { val: `测试 ${id}` } } })
    const directory = startInTrash ? trashPath : originalPath
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.jsonl'), '{"fixture":true}\n')
    if (startInTrash) value.entries.push({
      sessionId: id, title: `测试 ${id}`, cwd: workspacePath, originalPath, trashPath,
      deletedAt: Date.now(), sizeBytes: 17, wasArchived: false,
    })
  }
  const query = SessionQueryEngine && options.listFormat !== 'headers' ? new SessionQueryEngine(ctx) : undefined
  async function loadVault() {
    routeReady = deferred()
    vaultFiber = ctx.plugin(host.default)
    await routeReady.promise
  }
  await loadVault()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/dsh-session-vault/api`
  async function request(method, body) {
    const response = await fetch(`${base}/${method}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  return {
    home, store, workspace, cache, sourcePath, logs, disposed, visibilityWindows,
    state: () => state,
    entries: () => value.entries,
    snapshot: () => request('snapshot'),
    batch: (action, sessionIds = ids) => request('batch', { action, sessionIds }),
    snapshotRequested: () => once(requests, '/dsh-session-vault/api/snapshot'),
    async ungrouped() {
      const sessionIds = query
        ? (await query.listSessions()).map((row) => row.header.id)
        : [...new Set([...store.list().map((session) => session.id),
          ...(await persistence.list()).map((row) => (row.header ?? row).id)])]
      return sessionIds.filter((id) => !state.archivedSessionIds.includes(id) && !workspace.sessionIds.includes(id))
    },
    async reload() { await vaultFiber.dispose(); await loadVault() },
  }
}

test('永久清除已加载会话并刷新后，不得出现未分组幽灵会话', { timeout: 5000 }, async (t) => {
  const app = await fixture(t)
  assert.deepEqual(await app.ungrouped(), [])
  assert.deepEqual(await app.batch('purge'), { succeeded: ['session-a'], failed: [] })
  assert.deepEqual((await app.snapshot()).counts, { active: 0, archived: 0, trash: 0 })
  assert.deepEqual(await app.ungrouped(), [])
  assert.equal(app.store.get('session-a'), undefined)
  assert.deepEqual(app.disposed, ['session-a'])
  assert.deepEqual(app.visibilityWindows, [], '解除隐藏时不得仍有无工作区的内存会话')
  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.equal(app.cache.has('session-a'), false)
  assert.equal(existsSync(join(app.home, 'session-vault/purging/session-a')), false)
  assert.equal(await readFile(app.sourcePath, 'utf8'), '工作区文件不得被会话清理修改\n')
  assert.deepEqual(app.logs.filter((log) => log.type === 'warn'), [])
})

test('批量清除同时处理已加载与未加载会话', { timeout: 5000 }, async (t) => {
  const app = await fixture(t, { ids: ['session-a', 'session-b', 'session-c'], liveIds: ['session-a', 'session-b'] })
  assert.deepEqual(await app.batch('purge'), { succeeded: ['session-a', 'session-b', 'session-c'], failed: [] })
  await app.snapshot()
  assert.deepEqual(await app.ungrouped(), [])
  assert.deepEqual(app.store.list(), [])
  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.equal(app.cache.size, 0)
})

for (const listFormat of ['headers', 'snapshots']) {
  test(`${listFormat} 列表兼容：移入回收站、恢复再清除，不影响其它会话`, { timeout: 5000 }, async (t) => {
    const app = await fixture(t, { startInTrash: false, ids: ['session-a', 'session-b'], listFormat })
    assert.equal((await app.snapshot()).counts.active, 2)
    assert.deepEqual(await app.batch('trash', ['session-a']), { succeeded: ['session-a'], failed: [] })
    assert.deepEqual((await app.snapshot()).counts, { active: 1, archived: 0, trash: 1 })
    assert.ok(app.state().archivedSessionIds.includes('session-a'), '回收站会话不能被当作孤儿解除隐藏')
    assert.ok(app.store.get('session-a'), '可恢复删除不驱逐会话')
    assert.deepEqual(await app.batch('restore', ['session-a']), { succeeded: ['session-a'], failed: [] })
    assert.equal((await app.snapshot()).counts.active, 2)
    await app.batch('trash', ['session-a'])
    assert.deepEqual(await app.batch('purge', ['session-a']), { succeeded: ['session-a'], failed: [] })
    const snapshot = await app.snapshot()
    assert.deepEqual(snapshot.sessions.map((row) => row.sessionId), ['session-b'])
    assert.deepEqual(await app.ungrouped(), [])
    assert.equal(app.store.get('session-a'), undefined)
    assert.ok(app.store.get('session-b'))
    assert.ok(app.cache.has('session-b'))
  })
}

test('清除与快照并发时，不得提前解除归档隐藏', { timeout: 5000 }, async (t) => {
  const reached = deferred()
  const release = deferred()
  const app = await fixture(t, { afterDetach: async () => { reached.resolve(); await release.promise } })
  const purge = app.batch('purge')
  await reached.promise
  const requested = app.snapshotRequested()
  const snapshot = app.snapshot()
  let snapshotCompleted = false
  snapshot.then(() => { snapshotCompleted = true })
  let hiddenDuringPurge
  let readCompletedDuringPurge
  try {
    await requested
    await setImmediate()
    hiddenDuringPurge = app.state().archivedSessionIds.includes('session-a')
    readCompletedDuringPurge = snapshotCompleted
  } finally {
    release.resolve()
    await Promise.all([purge, snapshot])
  }
  assert.equal(hiddenDuringPurge, true, '快照对账不能清掉正在执行清除事务的隐藏标记')
  assert.equal(readCompletedDuringPurge, false, '快照应等待清除事务提交完成')
  assert.deepEqual(await app.ungrouped(), [])
  assert.deepEqual(app.visibilityWindows, [])
})

test('内存清理失败时保持隐藏与重试目录，重载插件后完成清理', { timeout: 5000 }, async (t) => {
  const app = await fixture(t)
  const entry = app.store.liveEntryFor(app.store.get('session-a'))
  const detach = entry.detach
  entry.detach = () => { throw new Error('模拟内存会话释放失败') }
  const result = await app.batch('purge')
  assert.deepEqual(result.succeeded, [])
  assert.equal(result.failed[0]?.code, 'purge-pending')
  await app.snapshot()
  assert.deepEqual(await app.ungrouped(), [])
  assert.ok(app.state().archivedSessionIds.includes('session-a'))
  assert.ok(existsSync(join(app.home, 'session-vault/purging/session-a')))
  entry.detach = detach
  await app.reload()
  assert.equal(app.store.get('session-a'), undefined)
  assert.equal(existsSync(join(app.home, 'session-vault/purging/session-a')), false)
  assert.deepEqual(app.state().archivedSessionIds, [])
})

test('运行中会话禁止移入回收站', { timeout: 5000 }, async (t) => {
  const app = await fixture(t, { startInTrash: false, runningIds: ['session-a'] })
  const result = await app.batch('trash')
  assert.deepEqual(result.succeeded, [])
  assert.equal(result.failed.length, 1)
  assert.ok(app.store.get('session-a'))
  assert.equal((await app.snapshot()).counts.active, 1)
})

test('回收站中重新运行的会话不得被永久清除', { timeout: 5000 }, async (t) => {
  const app = await fixture(t, { runningIds: ['session-a'] })
  const result = await app.batch('purge')
  assert.deepEqual(result.succeeded, [])
  assert.equal(result.failed[0]?.code, 'session-busy')
  assert.equal(app.entries().length, 1)
  assert.ok(app.store.get('session-a'))
  assert.ok(existsSync(join(app.home, 'session-vault/trash/session-a/session.jsonl')))
})

test('持久化列举失败时保留归档状态', { timeout: 5000 }, async (t) => {
  const app = await fixture(t, { failList: () => true })
  assert.ok(app.state().archivedSessionIds.includes('session-a'))
  assert.ok(app.store.get('session-a'))
})
