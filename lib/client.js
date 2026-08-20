window.__ModuleLoader__.load({
  id: "dsh-session-vault",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
Object.defineProperties(exports, {
	__esModule: { value: true },
	[Symbol.toStringTag]: { value: "Module" }
});
let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/contract.ts
const API_PREFIX = "/dsh-session-vault/api";
//#endregion
//#region src/client.tsx
const name = "dsh-session-vault/client";
const inject = [
	"slots",
	"locale",
	"sessions",
	"workspaces"
];
const NS = "dsh-session-vault";
const STYLE_ID = "dsh-session-vault-style";
const zh = { nav: "会话保险库" };
const en = { nav: "Session Vault" };
const STYLE = `
.dsv-root { display:flex; flex-direction:column; gap:16px; min-width:0; color:var(--dsw-alias-label-primary,#111827); }
.dsv-hero { position:relative; overflow:hidden; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:18px; padding:20px; border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16)); border-radius:16px; background:linear-gradient(135deg,rgba(49,91,255,.10),rgba(45,212,191,.07) 58%,transparent); }
.dsv-hero::after { content:""; position:absolute; width:170px; height:170px; right:-66px; top:-78px; border:22px solid rgba(49,91,255,.08); border-radius:50%; pointer-events:none; }
.dsv-kicker { color:var(--dsw-alias-label-secondary,#667085); font-size:11px; font-weight:700; letter-spacing:.13em; text-transform:uppercase; }
.dsv-title { margin:4px 0 5px; font-size:22px; line-height:1.2; font-weight:720; letter-spacing:-.025em; }
.dsv-subtitle { max-width:650px; color:var(--dsw-alias-label-secondary,#667085); font-size:12px; line-height:1.6; }
.dsv-stats { z-index:1; display:flex; align-items:stretch; gap:8px; }
.dsv-stat { min-width:78px; padding:10px 12px; border:1px solid rgba(127,127,127,.13); border-radius:12px; background:var(--dsw-alias-bg-base,rgba(255,255,255,.72)); backdrop-filter:blur(9px); }
.dsv-stat strong { display:block; font-size:20px; line-height:1; font-variant-numeric:tabular-nums; }
.dsv-stat span { display:block; margin-top:6px; color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; }
.dsv-controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsv-tabs { display:flex; gap:5px; padding:4px; border-radius:12px; background:var(--dsw-alias-bg-sunken,rgba(127,127,127,.08)); }
.dsv-search { flex:1 1 220px; min-width:180px; }
.dsv-selected { color:var(--dsw-alias-label-secondary,#667085); font-size:12px; margin-left:auto; }
.dsv-notice { padding:9px 11px; border-radius:10px; font-size:12px; line-height:1.5; }
.dsv-notice--ok { background:rgba(18,183,106,.10); color:var(--dsw-alias-label-primary,#111827); }
.dsv-notice--bad { background:rgba(240,68,56,.10); color:var(--dsw-alias-label-primary,#111827); }
.dsv-list { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16)); border-radius:14px; overflow:hidden; }
.dsv-row { display:grid; grid-template-columns:30px minmax(0,1fr) auto; gap:10px; align-items:center; min-height:64px; padding:10px 12px; border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.12)); background:var(--dsw-alias-bg-base,transparent); }
.dsv-row:last-child { border-bottom:0; }
.dsv-row:hover { background:var(--dsw-alias-bg-hover,rgba(127,127,127,.055)); }
.dsv-check { width:16px; height:16px; accent-color:#315bff; }
.dsv-row-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:620; }
.dsv-row-meta { display:flex; gap:7px; flex-wrap:wrap; margin-top:5px; color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; }
.dsv-row-meta code { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:inherit; }
.dsv-row-side { display:flex; align-items:center; gap:8px; color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:11px; white-space:nowrap; }
.dsv-badge { padding:3px 7px; border-radius:999px; background:rgba(49,91,255,.09); color:#315bff; font-size:10px; font-weight:650; }
.dsv-badge--busy { background:rgba(240,68,56,.10); color:#d92d20; }
.dsv-empty { padding:40px 20px; text-align:center; color:var(--dsw-alias-label-tertiary,#98a2b3); font-size:12px; }
.dsv-footer { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsv-spacer { flex:1; }
@media (max-width:760px) { .dsv-hero { grid-template-columns:1fr; } .dsv-stats { justify-content:stretch; } .dsv-stat { flex:1; min-width:0; } .dsv-row { grid-template-columns:26px minmax(0,1fr); } .dsv-row-side { grid-column:2; justify-content:flex-start; } }
@media (prefers-reduced-motion:reduce) { .dsv-root * { scroll-behavior:auto!important; transition:none!important; } }
`;
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = [
		"B",
		"KB",
		"MB",
		"GB"
	];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
function formatTime(value) {
	if (value === void 0) return "—";
	return new Intl.DateTimeFormat("zh-CN", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit"
	}).format(value);
}
async function api(method, init) {
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), 15e3);
	try {
		const body = await (await fetch(`${API_PREFIX}/${method}`, {
			...init,
			signal: controller.signal
		})).json();
		if (!body.ok) throw new Error(body.error.message);
		return body.value;
	} finally {
		window.clearTimeout(timer);
	}
}
async function batch(action, sessionIds) {
	return api("batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			action,
			sessionIds
		})
	});
}
function useSnapshotStore(store) {
	const subscribe = (0, react.useCallback)((listener) => store.subscribe(listener), [store]);
	const getSnapshot = (0, react.useCallback)(() => store.getSnapshot(), [store]);
	return (0, react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
}
function SessionVault({ sessions, workspaces }) {
	const sessionState = useSnapshotStore(sessions.list);
	const workspaceState = useSnapshotStore(workspaces.list);
	const [snapshot, setSnapshot] = (0, react.useState)(null);
	const [tab, setTab] = (0, react.useState)("archived");
	const [query, setQuery] = (0, react.useState)("");
	const [selected, setSelected] = (0, react.useState)(/* @__PURE__ */ new Set());
	const [loading, setLoading] = (0, react.useState)(false);
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)(null);
	const [confirmAction, setConfirmAction] = (0, react.useState)(null);
	const [acknowledged, setAcknowledged] = (0, react.useState)(false);
	const refresh = (0, react.useCallback)(async () => {
		setLoading(true);
		try {
			setSnapshot(await api("snapshot"));
			setNotice(null);
		} catch (error) {
			setNotice({
				ok: false,
				text: error instanceof Error ? error.message : String(error)
			});
		} finally {
			setLoading(false);
		}
	}, []);
	(0, react.useEffect)(() => {
		refresh();
	}, [
		refresh,
		sessionState.ids,
		workspaceState.archivedSessionIds
	]);
	(0, react.useEffect)(() => {
		setSelected(/* @__PURE__ */ new Set());
	}, [tab]);
	const rows = (0, react.useMemo)(() => {
		if (snapshot === null) return [];
		const source = tab === "trash" ? snapshot.trash : snapshot.sessions.filter((row) => tab === "archived" ? row.archived : !row.archived);
		const keyword = query.trim().toLocaleLowerCase();
		if (keyword === "") return source;
		return source.filter((row) => `${row.title} ${row.sessionId} ${row.cwd ?? ""}`.toLocaleLowerCase().includes(keyword));
	}, [
		query,
		snapshot,
		tab
	]);
	const selectableIds = (0, react.useMemo)(() => rows.filter((row) => tab === "trash" || !row.running).map((row) => row.sessionId), [rows, tab]);
	const toggle = (sessionId) => {
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(sessionId)) next.delete(sessionId);
			else next.add(sessionId);
			return next;
		});
	};
	const toggleAll = () => {
		setSelected((previous) => previous.size === selectableIds.length ? /* @__PURE__ */ new Set() : new Set(selectableIds));
	};
	const execute = async (action) => {
		setBusy(true);
		setNotice(null);
		try {
			const result = await batch(action, [...selected]);
			const text = result.failed.length === 0 ? `已完成 ${result.succeeded.length} 个会话` : `成功 ${result.succeeded.length} 个，失败 ${result.failed.length} 个：${result.failed[0]?.message ?? ""}`;
			setNotice({
				ok: result.failed.length === 0,
				text
			});
			setSelected(/* @__PURE__ */ new Set());
			await refresh();
		} catch (error) {
			setNotice({
				ok: false,
				text: error instanceof Error ? error.message : String(error)
			});
		} finally {
			setBusy(false);
			setConfirmAction(null);
			setAcknowledged(false);
		}
	};
	const requestAction = (action) => {
		if (selected.size === 0) return;
		if (action === "purge") {
			setAcknowledged(false);
			setConfirmAction(action);
		} else execute(action);
	};
	const isTrash = (row) => "deletedAt" in row;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsv-root",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dsv-hero",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsv-kicker",
						children: "DSH rc.7 · local session records"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "dsv-title",
						children: "会话保险库"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsv-subtitle",
						children: "归档用于隐藏，会话回收站用于可恢复删除。永久清除只处理 DSH 会话记录，不触碰工作区源码与产出文件。"
					})
				] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsv-stats",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsv-stat",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: snapshot?.counts.active ?? "—" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "活动" })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsv-stat",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: snapshot?.counts.archived ?? "—" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "归档" })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsv-stat",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: snapshot?.counts.trash ?? "—" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "回收站" })]
						})
					]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsv-controls",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsv-tabs",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: tab === "active",
								onClick: () => setTab("active"),
								children: "活动"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: tab === "archived",
								onClick: () => setTab("archived"),
								children: "归档"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
								active: tab === "trash",
								onClick: () => setTab("trash"),
								children: "回收站"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						className: "dsv-search",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, {}),
						value: query,
						onChange: (event) => setQuery(event.target.value),
						placeholder: "搜索标题、会话 ID 或路径"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {}),
						onClick: () => void refresh(),
						disabled: loading || busy,
						children: loading ? "刷新中" : "刷新"
					})
				]
			}),
			notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: `dsv-notice ${notice.ok ? "dsv-notice--ok" : "dsv-notice--bad"}`,
				children: notice.text
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsv-list",
				children: rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsv-empty",
					children: loading ? "正在读取会话记录…" : "这里暂时没有会话"
				}) : rows.map((row) => {
					const trash = isTrash(row);
					const disabled = !trash && row.running;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "dsv-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "dsv-check",
								type: "checkbox",
								checked: selected.has(row.sessionId),
								disabled: disabled || busy,
								onChange: () => toggle(row.sessionId)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsv-row-title",
								title: row.title,
								children: row.title
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsv-row-meta",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									title: row.sessionId,
									children: row.sessionId
								}), row.cwd !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									title: row.cwd,
									children: row.cwd
								})]
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsv-row-side",
								children: [
									!trash && row.running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsv-badge dsv-badge--busy",
										children: "运行中"
									}),
									!trash && row.workspaceTitle !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsv-badge",
										children: row.workspaceTitle
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatBytes(row.sizeBytes) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatTime(trash ? row.deletedAt : row.updatedAt) })
								]
							})
						]
					}, row.sessionId);
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsv-footer",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: "dsv-check",
						type: "checkbox",
						checked: selectableIds.length > 0 && selected.size === selectableIds.length,
						onChange: toggleAll
					}), " 全选当前结果"] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dsv-selected",
						children: [
							"已选 ",
							selected.size,
							" 项"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsv-spacer" }),
					tab === "active" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutline20, { size: 16 }),
						disabled: selected.size === 0 || busy,
						onClick: () => requestAction("archive"),
						children: "归档"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
						disabled: selected.size === 0 || busy,
						onClick: () => requestAction("trash"),
						children: "移入回收站"
					})] }),
					tab === "archived" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						disabled: selected.size === 0 || busy,
						onClick: () => requestAction("unarchive"),
						children: "移出归档"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
						disabled: selected.size === 0 || busy,
						onClick: () => requestAction("trash"),
						children: "移入回收站"
					})] }),
					tab === "trash" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						disabled: selected.size === 0 || busy,
						onClick: () => requestAction("restore"),
						children: "恢复"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						variant: "outline",
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {}),
						disabled: selected.size === 0 || busy,
						onClick: () => requestAction("purge"),
						children: "永久清除"
					})] })
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.RiskConfirmation, {
				open: confirmAction === "purge",
				title: `永久清除 ${selected.size} 个会话？`,
				description: "这些 DSH 会话记录将从回收站中物理删除，且无法恢复。工作区源码与产出文件不会被删除。",
				acknowledgeLabel: "我确认只清除已列出的 DSH 会话记录",
				cancelLabel: "取消",
				confirmLabel: busy ? "清除中…" : "永久清除",
				acknowledged,
				disabled: busy,
				onAcknowledgedChange: setAcknowledged,
				onCancel: () => {
					setConfirmAction(null);
					setAcknowledged(false);
				},
				onConfirm: () => void execute("purge")
			})
		]
	});
}
function apply(ctx) {
	document.getElementById(STYLE_ID)?.remove();
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = STYLE;
	document.head.append(style);
	ctx.effect(() => () => style.remove(), "dsh-session-vault: style");
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "dsh-session-vault: locale");
	const t = ctx.locale.bind(NS);
	const sessions = ctx.sessions;
	const workspaces = ctx.workspaces;
	ctx.slots.inject("settings.section", () => {
		return ctx.slots.register({
			name: "settings.section",
			id: "dsh-session-vault",
			order: 62,
			label: () => t("nav"),
			locale: NS,
			inject: () => ({
				sessions,
				workspaces
			})
		}, SessionVault);
	});
}
var client_default = {
	name,
	inject,
	apply
};
//#endregion
exports.apply = apply;
exports.default = client_default;
exports.inject = inject;
exports.name = name;


    return module.exports;
  }
});
//# sourceMappingURL=client.js.map