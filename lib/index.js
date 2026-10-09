import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
//#region src/contract.ts
const API_PREFIX = "/dsh-session-vault/api";
//#endregion
//#region src/core.ts
const SESSION_ID_RE = /^(?:session-)?[0-9a-fA-F-]{1,200}$/;
function isLoopbackIpv4(value) {
	const parts = value.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isLoopbackHost(value) {
	let normalized = value.trim().toLocaleLowerCase();
	if (normalized === "localhost") return true;
	if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
	if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
	if (normalized.startsWith("::ffff:")) normalized = normalized.slice(7);
	return isLoopbackIpv4(normalized);
}
function isLoopbackRemoteAddress(value) {
	if (value === void 0) return false;
	const normalized = value.includes("%") ? value.slice(0, value.indexOf("%")) : value;
	return isLoopbackHost(normalized) && normalized.toLocaleLowerCase() !== "localhost";
}
function isSessionId(value) {
	return typeof value === "string" && SESSION_ID_RE.test(value);
}
function isPathInside(root, candidate) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
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
async function ensureDirectoryAbsent(path, { attempts = 6, intervalMs = 350 } = {}) {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	await sleep(intervalMs);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (!existsSync(path)) {
			await sleep(intervalMs);
			if (!existsSync(path)) return;
			continue;
		}
		await rm(path, {
			recursive: true,
			force: true,
			maxRetries: 3
		});
		await sleep(intervalMs);
	}
	if (existsSync(path)) throw Object.assign(/* @__PURE__ */ new Error(`目录在清除后仍被重建：${path}`), { code: "artifact-resurrected" });
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
function locateSessionArtifact(sessionsRoot, sessionId) {
	if (!isSessionId(sessionId)) return void 0;
	let workdirs;
	try {
		workdirs = readdirSync(sessionsRoot, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of workdirs) {
		if (!entry.isDirectory()) continue;
		const sessionDir = join(sessionsRoot, entry.name, sessionId);
		if (!existsSync(sessionDir)) continue;
		let files;
		try {
			files = readdirSync(sessionDir);
		} catch {
			continue;
		}
		const artifact = files.find((file) => file.startsWith("session.") && !file.endsWith(".lock"));
		if (artifact !== void 0) return join(sessionDir, artifact);
	}
}
function sessionDirectoryFromArtifact(sessionsRoot, artifactPath) {
	const directory = dirname(resolve(artifactPath));
	if (!isPathInside(sessionsRoot, directory)) throw Object.assign(/* @__PURE__ */ new Error("会话记录路径不在 DSH sessions 目录内"), {
		code: "unsafe-session-path",
		status: 500
	});
	return directory;
}
function normalizeIds(value) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(isSessionId))];
}
function formatFailure(error) {
	if (error instanceof Error) {
		const detail = error;
		return {
			code: typeof detail.code === "string" ? detail.code : "internal",
			message: detail.message || "操作失败",
			status: typeof detail.status === "number" ? detail.status : 500
		};
	}
	return {
		code: "internal",
		message: String(error),
		status: 500
	};
}
function assertUniqueTrashPaths(entries) {
	const ids = /* @__PURE__ */ new Set();
	const paths = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (ids.has(entry.sessionId)) throw new Error(`回收站重复会话：${entry.sessionId}`);
		if (paths.has(entry.trashPath)) throw new Error(`回收站重复路径：${entry.trashPath}`);
		ids.add(entry.sessionId);
		paths.add(entry.trashPath);
	}
}
/**
* 从长期保存的标识中挑出已无对应会话的孤儿。
*
* `known` 必须来自一次**成功**的会话列举。调用方绝不能在列举失败时传入空集合，
* 否则这里会把全部标识判为孤儿——存储故障将因此被放大成状态清空。
*/
function selectOrphanedIds(stored, known) {
	return stored.filter((id) => !known.has(id));
}
/**
* 计算仍受插件管辖、因而不得当作孤儿清理的会话标识。
*
* 回收站中的会话已被移出 DSH 的 sessions 目录，不会出现在会话列举结果里，但它们
* 由本插件托管且可随时恢复，并不是孤儿。移入回收站时插件会把会话标记为归档以遮蔽
* 它；若对账把这些标识判为孤儿清掉，该遮蔽立即失效，会话会重新冒到侧边栏中。
*/
function retainedSessionIds(existing, trashed) {
	const retained = new Set(existing);
	for (const id of trashed) retained.add(id);
	return retained;
}
/**
* 从域全局状态中读出清除墓碑列表（容忍旧版本数据缺 purged 字段）。
*/
function purgedTombstonesOf(value) {
	if (value === null || typeof value !== "object") return [];
	const purged = value.purged;
	return Array.isArray(purged) ? purged.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.sessionId === "string" && typeof entry.originalPath === "string" && typeof entry.purgedAt === "number") : [];
}
/**
* 插入或刷新一枚清除墓碑（同一会话只保留最新一枚）。
*/
function upsertPurgedTombstone(purged, tombstone) {
	return [...purged.filter((entry) => entry.sessionId !== tombstone.sessionId), tombstone];
}
/**
* 挑出可以过期移除的墓碑：原位已无副本且距上次清除超过保留期。
*
* `resurrected` 之外且未过期的墓碑必须保留——写入器（idle checkpoint、
* teardown drain）可能在清除完成后很久才把工件写回原位，墓碑是唯一的
* 事后清理与重新遮蔽依据。
*/
function selectExpiredTombstones(purged, resurrected, now, retainMs) {
	return purged.filter((entry) => !resurrected.has(entry.sessionId) && now - entry.purgedAt > retainMs).map((entry) => entry.sessionId);
}
//#endregion
//#region src/index.ts
const name = "dsh-session-vault";
const inject = [
	"webServer",
	"sessionPersistence",
	"sessions",
	"workspaceRegistry",
	"agents",
	"storageDomain"
];
const MAX_BODY_BYTES = 262144;
/** 清除墓碑的保留期：覆盖 idle checkpoint / teardown drain 等迟到写回的观察窗口。 */
const TOMBSTONE_RETAIN_MS = 6048e5;
const trashEntrySchema = z.object({
	sessionId: z.string(),
	title: z.string(),
	cwd: z.string().optional(),
	originalPath: z.string(),
	trashPath: z.string(),
	deletedAt: z.number(),
	sizeBytes: z.number(),
	wasArchived: z.boolean()
});
const purgedTombstoneSchema = z.object({
	sessionId: z.string(),
	originalPath: z.string(),
	purgedAt: z.number()
});
const vaultDomainSpec = defineDomain({
	name: "dsh_session_vault",
	version: 1,
	global: {
		schema: z.object({
			entries: z.array(trashEntrySchema),
			purged: z.array(purgedTombstoneSchema).optional()
		}),
		initial: {
			entries: [],
			purged: []
		}
	},
	tables: {}
});
function sessionsRoot() {
	return dshHomePath("sessions");
}
function trashRoot() {
	return join(dshHomePath("session-vault"), "trash");
}
function purgingRoot() {
	return join(dshHomePath("session-vault"), "purging");
}
function trashPathFor(sessionId) {
	return join(trashRoot(), sessionId);
}
function purgingPathFor(sessionId) {
	return join(purgingRoot(), sessionId);
}
function workspaceInternals(ctx) {
	const registry = ctx.workspaceRegistry;
	if (typeof registry.requireState !== "function" || typeof registry.setState !== "function") throw Object.assign(/* @__PURE__ */ new Error("当前 DSH 版本未暴露取消归档所需的状态原语"), {
		code: "unarchive-unsupported",
		status: 501
	});
	return registry;
}
function liveSessionStore(ctx) {
	const store = ctx.sessions;
	if (store === void 0 || typeof store.get !== "function" || typeof store.liveEntryFor !== "function") return;
	return store;
}
function assertPurgeIdle(ctx, sessionId) {
	if (ctx.agents.get(sessionId)?.status === "running") throw Object.assign(/* @__PURE__ */ new Error("会话正在运行，请先停止该会话后再永久清除"), {
		code: "session-busy",
		status: 409
	});
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
function evictLiveSession(ctx, sessionId) {
	assertPurgeIdle(ctx, sessionId);
	const session = ctx.sessions.get(sessionId);
	if (session === void 0) return false;
	const store = liveSessionStore(ctx);
	if (store === void 0) throw Object.assign(/* @__PURE__ */ new Error("当前 DSH 版本不支持释放已加载的会话"), {
		code: "session-release-unsupported",
		status: 501
	});
	const entry = store.liveEntryFor(session);
	if (typeof entry.detach !== "function") throw Object.assign(/* @__PURE__ */ new Error("当前会话缺少释放方法"), {
		code: "session-release-unsupported",
		status: 501
	});
	if (entry.appending === true || entry.announcing === true) entry.detachRequested = true;
	else entry.detach();
	if (store.get(sessionId) !== void 0) throw Object.assign(/* @__PURE__ */ new Error("会话尚未完成释放，保留隐藏状态等待重试"), {
		code: "session-release-pending",
		status: 409
	});
	ctx.logger.info(`[dsh-session-vault] 已从内存中释放被清除的会话 ${sessionId}`);
	return true;
}
function projectionCache(ctx) {
	return ctx.storageDomain.get("session_projcache");
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
async function flushPersistence(ctx) {
	const service = ctx.sessionPersistence;
	if (typeof service.flushAll !== "function") return;
	try {
		await service.flushAll();
	} catch (error) {
		ctx.logger.warn("[dsh-session-vault] 清除前的持久化冲刷未完成，降级为守卫+墓碑兜底", error);
	}
}
function entriesOf(domain) {
	const value = domain.global.get();
	return Array.isArray(value.entries) ? value.entries : [];
}
function purgedOf(domain) {
	return purgedTombstonesOf(domain.global.get());
}
async function saveDomainState(domain, entries, purged) {
	assertUniqueTrashPaths(entries);
	await domain.global.set({
		entries,
		purged
	});
}
async function readJson(req) {
	const contentType = req.headers["content-type"];
	if (typeof contentType === "string" && !/^application\/json\b/i.test(contentType)) throw Object.assign(/* @__PURE__ */ new Error("请求必须使用 application/json"), {
		code: "unsupported-media-type",
		status: 415
	});
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw Object.assign(/* @__PURE__ */ new Error("请求体过大"), {
			code: "body-too-large",
			status: 413
		});
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (raw === "") return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw Object.assign(/* @__PURE__ */ new Error("请求体不是有效 JSON"), {
			code: "bad-json",
			status: 400
		});
	}
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
function writeOk(res, value) {
	writeJson(res, 200, {
		ok: true,
		value
	});
}
function header(req, name) {
	const value = req.headers[name];
	return typeof value === "string" ? value : Array.isArray(value) ? value[0] : void 0;
}
function trustedRequest(req) {
	if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return false;
	const host = header(req, "host");
	if (host === void 0) return false;
	let authority;
	try {
		authority = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHost(authority.hostname)) return false;
	if (header(req, "sec-fetch-site") === "cross-site") return false;
	const origin = header(req, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === authority.host;
	} catch {
		return false;
	}
}
async function directorySize(path) {
	let total = 0;
	const stack = [path];
	while (stack.length > 0) {
		const current = stack.pop();
		let children;
		try {
			children = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of children) {
			const full = join(current, child.name);
			if (child.isDirectory()) stack.push(full);
			else if (child.isFile()) try {
				total += (await stat(full)).size;
			} catch {}
		}
	}
	return total;
}
function titleFromCache(record, sessionId) {
	const value = record?.rows?.title?.val;
	return typeof value === "string" && value.trim() !== "" ? value : sessionId;
}
function workspaceTitle(ctx, sessionId) {
	for (const workspace of ctx.workspaceRegistry.list()) if (workspace.sessionIds.includes(sessionId)) return workspace.title;
}
/**
* 兼容 dsh 0.1.1 与 0.1.5 的 sessionPersistence.list() 返回结构：
* 0.1.5 起 list() 返回 { header, revision, sizeBytes? } 快照数组，
* 0.1.1 直接返回 header 数组。统一展开成 header 列表。
*/
function persistenceHeaders(snapshots) {
	return (Array.isArray(snapshots) ? snapshots : []).map((entry) => entry !== null && typeof entry === "object" && "header" in entry ? entry.header : entry);
}
async function listSnapshot(ctx, domain) {
	const headers = persistenceHeaders(await ctx.sessionPersistence.list());
	const known = new Set(headers.map((header) => String(header.id)));
	try {
		await reconcileOrphanedState(ctx, known, domain);
	} catch (error) {
		ctx.logger.warn("[dsh-session-vault] 读取快照时的孤儿对账未完成", error);
	}
	try {
		await sweepPurgedTombstones(ctx, domain);
	} catch (error) {
		ctx.logger.warn("[dsh-session-vault] 读取快照时的清除墓碑巡检未完成", error);
	}
	const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String));
	const cache = projectionCache(ctx)?.table("sessions");
	const rows = [];
	for (const header of headers) {
		const sessionId = String(header.id);
		const record = cache?.get(sessionId);
		const artifact = locateSessionArtifact(sessionsRoot(), sessionId);
		let sizeBytes = 0;
		let updatedAt = record?.identity?.createdAt ?? header.createdAt;
		if (artifact !== void 0) try {
			const info = await stat(artifact);
			sizeBytes = info.size;
			updatedAt = info.mtimeMs;
		} catch {}
		rows.push({
			sessionId,
			title: titleFromCache(record, sessionId),
			cwd: header.cwd,
			createdAt: header.createdAt,
			updatedAt,
			archived: archived.has(sessionId),
			running: ctx.agents.get(header.id)?.status === "running",
			sizeBytes,
			workspaceTitle: workspaceTitle(ctx, sessionId)
		});
	}
	rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
	const trash = [...entriesOf(domain)].sort((a, b) => b.deletedAt - a.deletedAt);
	return {
		sessions: rows,
		trash,
		counts: {
			active: rows.filter((row) => !row.archived).length,
			archived: rows.filter((row) => row.archived).length,
			trash: trash.length
		}
	};
}
async function headerById(ctx, sessionId) {
	const header = persistenceHeaders(await ctx.sessionPersistence.list()).find((candidate) => String(candidate.id) === sessionId);
	if (header === void 0) throw Object.assign(/* @__PURE__ */ new Error("找不到该会话记录"), {
		code: "session-not-found",
		status: 404
	});
	return header;
}
let mutationTail = Promise.resolve();
function mutate(operation) {
	const result = mutationTail.then(operation, operation);
	mutationTail = result.then(() => void 0, () => void 0);
	return result;
}
async function setArchived(ctx, sessionId, archived) {
	if (archived) {
		await ctx.workspaceRegistry.archiveSession(sessionId);
		return;
	}
	const registry = workspaceInternals(ctx);
	const state = registry.requireState();
	if (!state.archivedSessionIds.includes(sessionId)) return;
	await registry.setState({
		...state,
		archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
	});
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
async function sweepPurgedTombstones(ctx, domain) {
	const purged = purgedOf(domain);
	if (purged.length === 0) return;
	const now = Date.now();
	const resurrected = /* @__PURE__ */ new Set();
	for (const tombstone of purged) {
		if (!isPathInside(sessionsRoot(), tombstone.originalPath)) continue;
		if (!existsSync(tombstone.originalPath)) continue;
		resurrected.add(tombstone.sessionId);
		try {
			await rm(tombstone.originalPath, {
				recursive: true,
				force: true,
				maxRetries: 3
			});
			await setArchived(ctx, tombstone.sessionId, true);
			const cache = projectionCache(ctx);
			if (cache !== void 0) await cache.table("sessions").delete(tombstone.sessionId);
			ctx.logger.warn(`[dsh-session-vault] 已清除迟到的写入器复活副本并重新遮蔽：${tombstone.sessionId}`);
		} catch (error) {
			ctx.logger.warn(`[dsh-session-vault] 清除复活副本失败，保留墓碑继续观察：${tombstone.sessionId}`, error);
		}
	}
	let next = purged;
	if (resurrected.size > 0) next = next.map((tombstone) => resurrected.has(tombstone.sessionId) ? {
		...tombstone,
		purgedAt: now
	} : tombstone);
	const expired = new Set(selectExpiredTombstones(next, resurrected, now, TOMBSTONE_RETAIN_MS));
	if (expired.size > 0) next = next.filter((tombstone) => !expired.has(tombstone.sessionId));
	if (next !== purged) await saveDomainState(domain, entriesOf(domain), next);
}
async function finalizeCommittedPurge(ctx, sessionId, stagedPath, originalDir) {
	if (!isPathInside(purgingRoot(), stagedPath)) throw Object.assign(/* @__PURE__ */ new Error("待清除目录未通过安全校验"), {
		code: "unsafe-purging-path",
		status: 500
	});
	await mkdir(stagedPath, { recursive: true });
	await flushPersistence(ctx);
	evictLiveSession(ctx, sessionId);
	for (const child of await readdir(stagedPath)) await rm(join(stagedPath, child), {
		recursive: true,
		force: true,
		maxRetries: 3
	});
	if (originalDir !== void 0 && isPathInside(sessionsRoot(), originalDir)) await ensureDirectoryAbsent(originalDir);
	for (const workspace of ctx.workspaceRegistry.list()) if (workspace.sessionIds.map(String).includes(sessionId)) await workspace.detachSession(sessionId);
	await setArchived(ctx, sessionId, false);
	const cache = projectionCache(ctx);
	if (cache !== void 0) await cache.table("sessions").delete(sessionId);
	await rm(stagedPath, {
		recursive: true,
		force: true,
		maxRetries: 3
	});
}
async function reconcilePendingPurges(ctx, domain) {
	await mkdir(purgingRoot(), { recursive: true });
	const entries = entriesOf(domain);
	const bySessionId = new Map(entries.map((entry) => [entry.sessionId, entry]));
	const children = await readdir(purgingRoot(), { withFileTypes: true });
	for (const child of children) {
		if (!child.isDirectory() || !isSessionId(child.name)) {
			ctx.logger.warn(`[dsh-session-vault] 忽略无法识别的待清除项：${child.name}`);
			continue;
		}
		const stagedPath = purgingPathFor(child.name);
		const entry = bySessionId.get(child.name);
		if (entry !== void 0) {
			if (!isPathInside(trashRoot(), entry.trashPath)) {
				ctx.logger.warn(`[dsh-session-vault] 无法恢复未提交的清除操作，路径不安全：${entry.trashPath}`);
				continue;
			}
			if (existsSync(entry.trashPath)) {
				ctx.logger.warn(`[dsh-session-vault] 回收站与待清除区同时存在会话：${child.name}`);
				continue;
			}
			try {
				await mkdir(dirname(entry.trashPath), { recursive: true });
				await rename(stagedPath, entry.trashPath);
			} catch (error) {
				ctx.logger.warn(`[dsh-session-vault] 恢复未提交的清除操作失败：${child.name}`, error);
			}
			continue;
		}
		try {
			const resurrected = locateSessionArtifact(sessionsRoot(), child.name);
			await finalizeCommittedPurge(ctx, child.name, stagedPath, resurrected === void 0 ? void 0 : sessionDirectoryFromArtifact(sessionsRoot(), resurrected));
		} catch (error) {
			ctx.logger.warn(`[dsh-session-vault] 完成已提交的清除操作失败，将在下次启动重试：${child.name}`, error);
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
async function reconcileOrphanedState(ctx, existing, domain) {
	const known = retainedSessionIds(existing, [...entriesOf(domain).map((entry) => entry.sessionId), ...ctx.sessions.list().map((session) => String(session.id))]);
	let removed = 0;
	const registry = workspaceInternals(ctx);
	const state = registry.requireState();
	const orphaned = selectOrphanedIds(state.archivedSessionIds, known);
	if (orphaned.length > 0) {
		const orphanedSet = new Set(orphaned);
		await registry.setState({
			...state,
			archivedSessionIds: state.archivedSessionIds.filter((id) => !orphanedSet.has(id))
		});
		removed += orphaned.length;
		ctx.logger.info(`[dsh-session-vault] 已清理 ${orphaned.length} 个指向已删除会话的归档标记`);
	}
	const cache = projectionCache(ctx)?.table("sessions");
	if (cache === void 0) return removed;
	const stale = selectOrphanedIds([...cache.keys()], known);
	for (const key of stale) await cache.delete(key);
	if (stale.length > 0) ctx.logger.info(`[dsh-session-vault] 已清理 ${stale.length} 条指向已删除会话的投影缓存`);
	return removed + stale.length;
}
async function moveToTrash(ctx, domain, sessionId) {
	const existing = entriesOf(domain);
	if (existing.some((entry) => entry.sessionId === sessionId)) return;
	const header = await headerById(ctx, sessionId);
	const agent = ctx.agents.get(header.id);
	if (agent?.status === "running") throw Object.assign(/* @__PURE__ */ new Error("会话正在运行，请先停止该会话后再移入回收站"), {
		code: "session-busy",
		status: 409
	});
	if (agent !== void 0) ctx.logger.info(`[dsh-session-vault] 会话 ${sessionId} 仍在当前进程中打开但处于空闲状态，继续移入回收站`);
	const artifact = locateSessionArtifact(sessionsRoot(), sessionId);
	if (artifact === void 0) throw Object.assign(/* @__PURE__ */ new Error("当前持久化后端没有独立会话记录，无法安全移动"), {
		code: "artifact-unavailable",
		status: 501
	});
	const originalPath = sessionDirectoryFromArtifact(sessionsRoot(), artifact);
	if (!existsSync(originalPath)) throw Object.assign(/* @__PURE__ */ new Error("会话记录目录不存在"), {
		code: "artifact-not-found",
		status: 404
	});
	const cache = projectionCache(ctx)?.table("sessions");
	const title = titleFromCache(cache?.get(sessionId), sessionId);
	const wasArchived = ctx.workspaceRegistry.archivedSessionIds.map(String).includes(sessionId);
	const trashPath = trashPathFor(sessionId);
	const entry = {
		sessionId,
		title,
		cwd: header.cwd,
		originalPath,
		trashPath,
		deletedAt: Date.now(),
		sizeBytes: await directorySize(originalPath),
		wasArchived
	};
	await mkdir(trashRoot(), { recursive: true });
	if (existsSync(trashPath)) throw Object.assign(/* @__PURE__ */ new Error("回收站中已存在同名目录，请先检查数据"), {
		code: "trash-collision",
		status: 409
	});
	await flushPersistence(ctx);
	let moved = false;
	let archiveChanged = false;
	try {
		await setArchived(ctx, sessionId, true);
		archiveChanged = !wasArchived;
		await rename(originalPath, trashPath);
		moved = true;
		await saveDomainState(domain, [...existing, entry], purgedOf(domain).filter((tombstone) => tombstone.sessionId !== sessionId));
		try {
			await ensureDirectoryAbsent(originalPath, {
				attempts: 3,
				intervalMs: 250
			});
		} catch (resurrected) {
			ctx.logger.warn(`[dsh-session-vault] 会话 ${sessionId} 移入回收站后原位出现写入器重建副本，将在永久清除时一并处理`, resurrected);
		}
	} catch (error) {
		if (moved && existsSync(trashPath) && !existsSync(originalPath)) {
			await mkdir(dirname(originalPath), { recursive: true }).catch(() => {});
			await rename(trashPath, originalPath).catch(() => {});
		}
		if (archiveChanged) await setArchived(ctx, sessionId, false).catch(() => {});
		throw error;
	}
}
async function restoreTrash(ctx, domain, sessionId) {
	const entries = entriesOf(domain);
	const entry = entries.find((candidate) => candidate.sessionId === sessionId);
	if (entry === void 0) throw Object.assign(/* @__PURE__ */ new Error("回收站中没有该会话"), {
		code: "trash-not-found",
		status: 404
	});
	if (!isPathInside(trashRoot(), entry.trashPath) || !isPathInside(sessionsRoot(), entry.originalPath)) throw Object.assign(/* @__PURE__ */ new Error("回收站记录路径未通过安全校验"), {
		code: "unsafe-trash-path",
		status: 500
	});
	if (!existsSync(entry.trashPath)) throw Object.assign(/* @__PURE__ */ new Error("回收站记录目录已丢失"), {
		code: "trash-artifact-not-found",
		status: 404
	});
	if (existsSync(entry.originalPath)) throw Object.assign(/* @__PURE__ */ new Error("原位置已有同名会话记录，未覆盖现有数据"), {
		code: "restore-collision",
		status: 409
	});
	await mkdir(dirname(entry.originalPath), { recursive: true });
	await rename(entry.trashPath, entry.originalPath);
	try {
		await setArchived(ctx, sessionId, entry.wasArchived);
		await saveDomainState(domain, entries.filter((candidate) => candidate.sessionId !== sessionId), purgedOf(domain).filter((tombstone) => tombstone.sessionId !== sessionId));
	} catch (error) {
		await rename(entry.originalPath, entry.trashPath).catch(() => {});
		await setArchived(ctx, sessionId, true).catch(() => {});
		throw error;
	}
}
async function purgeTrash(ctx, domain, sessionId) {
	const entries = entriesOf(domain);
	const entry = entries.find((candidate) => candidate.sessionId === sessionId);
	if (entry === void 0) throw Object.assign(/* @__PURE__ */ new Error("回收站中没有该会话"), {
		code: "trash-not-found",
		status: 404
	});
	assertPurgeIdle(ctx, sessionId);
	if (!isPathInside(trashRoot(), entry.trashPath)) throw Object.assign(/* @__PURE__ */ new Error("回收站记录路径未通过安全校验"), {
		code: "unsafe-trash-path",
		status: 500
	});
	await mkdir(purgingRoot(), { recursive: true });
	const stagedPath = purgingPathFor(sessionId);
	if (existsSync(stagedPath)) throw Object.assign(/* @__PURE__ */ new Error("待清除区中已存在同名目录，请重启 DSH 让插件自动恢复"), {
		code: "purging-collision",
		status: 409
	});
	let staged = false;
	if (existsSync(entry.trashPath)) {
		await rename(entry.trashPath, stagedPath);
		staged = true;
	}
	try {
		const purgedNext = upsertPurgedTombstone(purgedOf(domain), {
			sessionId,
			originalPath: entry.originalPath,
			purgedAt: Date.now()
		});
		await saveDomainState(domain, entries.filter((candidate) => candidate.sessionId !== sessionId), purgedNext);
	} catch (error) {
		if (staged && existsSync(stagedPath) && !existsSync(entry.trashPath)) await rename(stagedPath, entry.trashPath).catch(() => {});
		throw error;
	}
	try {
		await finalizeCommittedPurge(ctx, sessionId, stagedPath, entry.originalPath);
	} catch (error) {
		ctx.logger.warn(`[dsh-session-vault] 会话已从回收站提交清除，但物理清理尚未完成，将在下次启动重试：${sessionId}`, error);
		throw Object.assign(new Error("会话已提交清除，但剩余清理未完成；请重启 DSH 自动重试", { cause: error }), {
			code: "purge-pending",
			status: 503
		});
	}
}
async function perform(ctx, domain, action, ids) {
	const result = {
		succeeded: [],
		failed: []
	};
	for (const sessionId of ids) try {
		await mutate(async () => {
			if (action === "archive") await setArchived(ctx, sessionId, true);
			else if (action === "unarchive") await setArchived(ctx, sessionId, false);
			else if (action === "trash") await moveToTrash(ctx, domain, sessionId);
			else if (action === "restore") await restoreTrash(ctx, domain, sessionId);
			else await purgeTrash(ctx, domain, sessionId);
		});
		result.succeeded.push(sessionId);
	} catch (error) {
		const failure = formatFailure(error);
		result.failed.push({
			sessionId,
			code: failure.code,
			message: failure.message
		});
	}
	return result;
}
async function apply(ctx) {
	const domain = await ctx.storageDomain.open(vaultDomainSpec);
	await mkdir(trashRoot(), { recursive: true });
	await reconcilePendingPurges(ctx, domain);
	try {
		const headers = persistenceHeaders(await ctx.sessionPersistence.list());
		await reconcileOrphanedState(ctx, new Set(headers.map((header) => String(header.id))), domain);
	} catch (error) {
		ctx.logger.warn("[dsh-session-vault] 启动时的孤儿对账未完成，稍后重试", error);
	}
	try {
		await sweepPurgedTombstones(ctx, domain);
	} catch (error) {
		ctx.logger.warn("[dsh-session-vault] 启动时的清除墓碑巡检未完成，稍后重试", error);
	}
	const unregister = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!trustedRequest(req)) return writeJson(res, 403, {
				ok: false,
				error: {
					code: "forbidden",
					message: "仅允许本机同源请求"
				}
			});
			const pathname = new URL(req.url ?? "/", "http://dsh.local").pathname;
			const method = pathname.startsWith(`/dsh-session-vault/api/`) ? pathname.slice(23) : "";
			try {
				if (req.method === "GET" && method === "snapshot") return writeOk(res, await mutate(() => listSnapshot(ctx, domain)));
				if (req.method !== "POST") return writeJson(res, 405, {
					ok: false,
					error: {
						code: "method-not-allowed",
						message: "请求方法不受支持"
					}
				});
				if (method !== "batch") return writeJson(res, 404, {
					ok: false,
					error: {
						code: "not-found",
						message: "未知接口"
					}
				});
				const body = await readJson(req);
				const action = body.action;
				if (action !== "archive" && action !== "unarchive" && action !== "trash" && action !== "restore" && action !== "purge") throw Object.assign(/* @__PURE__ */ new Error("无效操作"), {
					code: "invalid-action",
					status: 400
				});
				const ids = normalizeIds(body.sessionIds);
				if (ids.length === 0) throw Object.assign(/* @__PURE__ */ new Error("没有有效的会话标识"), {
					code: "empty-selection",
					status: 400
				});
				if (ids.length > 200) throw Object.assign(/* @__PURE__ */ new Error("单次最多处理 200 个会话"), {
					code: "too-many-sessions",
					status: 400
				});
				writeOk(res, await perform(ctx, domain, action, ids));
			} catch (error) {
				const failure = formatFailure(error);
				ctx.logger.warn("[dsh-session-vault] request failed:", error);
				writeJson(res, failure.status, {
					ok: false,
					error: {
						code: failure.code,
						message: failure.message
					}
				});
			}
		}
	});
	return async () => {
		unregister();
		await domain.close();
	};
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { apply, src_default as default, inject, name };

//# sourceMappingURL=index.js.map