import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { existsSync } from "node:fs";
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
//#endregion
//#region src/index.ts
const name = "dsh-session-vault";
const inject = [
	"webServer",
	"sessionPersistence",
	"workspaceRegistry",
	"agents",
	"storageDomain"
];
const MAX_BODY_BYTES = 262144;
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
const vaultDomainSpec = defineDomain({
	name: "dsh_session_vault",
	version: 1,
	global: {
		schema: z.object({ entries: z.array(trashEntrySchema) }),
		initial: { entries: [] }
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
function projectionCache(ctx) {
	return ctx.storageDomain.get("session_projcache");
}
function entriesOf(domain) {
	const value = domain.global.get();
	return Array.isArray(value.entries) ? value.entries : [];
}
async function saveEntries(domain, entries) {
	assertUniqueTrashPaths(entries);
	await domain.global.set({ entries });
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
async function listSnapshot(ctx, domain) {
	const headers = await ctx.sessionPersistence.list();
	const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String));
	const cache = projectionCache(ctx)?.table("sessions");
	const rows = [];
	for (const header of headers) {
		const sessionId = String(header.id);
		const record = cache?.get(sessionId);
		const location = ctx.sessionPersistence.locate(header);
		let sizeBytes = 0;
		let updatedAt = record?.identity?.createdAt ?? header.createdAt;
		if (location?.path !== void 0) try {
			const info = await stat(location.path);
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
	const header = (await ctx.sessionPersistence.list()).find((candidate) => String(candidate.id) === sessionId);
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
async function finalizeCommittedPurge(ctx, sessionId, stagedPath) {
	if (!isPathInside(purgingRoot(), stagedPath)) throw Object.assign(/* @__PURE__ */ new Error("待清除目录未通过安全校验"), {
		code: "unsafe-purging-path",
		status: 500
	});
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
			await finalizeCommittedPurge(ctx, child.name, stagedPath);
		} catch (error) {
			ctx.logger.warn(`[dsh-session-vault] 完成已提交的清除操作失败，将在下次启动重试：${child.name}`, error);
		}
	}
}
async function moveToTrash(ctx, domain, sessionId) {
	const existing = entriesOf(domain);
	if (existing.some((entry) => entry.sessionId === sessionId)) return;
	const header = await headerById(ctx, sessionId);
	const agent = ctx.agents.get(header.id);
	if (agent !== void 0) throw Object.assign(/* @__PURE__ */ new Error(agent.status === "running" ? "会话正在运行，无法移入回收站" : "会话仍在当前 DSH 进程中打开，请重启服务后再删除"), {
		code: agent.status === "running" ? "session-busy" : "session-live",
		status: 409
	});
	const location = ctx.sessionPersistence.locate(header);
	if (location === void 0) throw Object.assign(/* @__PURE__ */ new Error("当前持久化后端没有独立会话记录，无法安全移动"), {
		code: "artifact-unavailable",
		status: 501
	});
	const originalPath = sessionDirectoryFromArtifact(sessionsRoot(), location.path);
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
	let moved = false;
	let archiveChanged = false;
	try {
		await setArchived(ctx, sessionId, true);
		archiveChanged = !wasArchived;
		await rename(originalPath, trashPath);
		moved = true;
		await saveEntries(domain, [...existing, entry]);
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
		await saveEntries(domain, entries.filter((candidate) => candidate.sessionId !== sessionId));
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
		await saveEntries(domain, entries.filter((candidate) => candidate.sessionId !== sessionId));
	} catch (error) {
		if (staged && existsSync(stagedPath) && !existsSync(entry.trashPath)) await rename(stagedPath, entry.trashPath).catch(() => {});
		throw error;
	}
	try {
		await finalizeCommittedPurge(ctx, sessionId, stagedPath);
	} catch (error) {
		ctx.logger.warn(`[dsh-session-vault] 会话已从回收站提交清除，但物理清理尚未完成，将在下次启动重试：${sessionId}`, error);
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
				if (req.method === "GET" && method === "snapshot") return writeOk(res, await listSnapshot(ctx, domain));
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