import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ISessions, IWorkspaces, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, Input, Pill, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconArchiveOutline20,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import {
  API_PREFIX,
  type ApiResponse,
  type BatchAction,
  type BatchResult,
  type SessionVaultRow,
  type SessionVaultSnapshot,
  type TrashEntry,
} from './contract.js'

export const name = 'dsh-session-vault/client'
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

const NS = 'dsh-session-vault'
const STYLE_ID = 'dsh-session-vault-style'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: 'nav'
  }
}

interface ClientContext {
  slots: SlotRegistry
  effect(effect: () => void | (() => void), label?: string): void
  sessions: ISessions
  workspaces: IWorkspaces
  locale: {
    getLocale(): { active: string }
    subscribe(listener: () => void): () => void
    register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
    bind(namespace: string): (key: 'nav') => string
  }
}

interface Injected {
  sessions: ISessions
  workspaces: IWorkspaces
}

type Tab = 'active' | 'archived' | 'trash'

const zh = { nav: '会话保险库' }
const en = { nav: 'Session Vault' }

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
`

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

function formatTime(value: number | undefined): string {
  if (value === undefined) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value)
}

async function api<T>(method: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${API_PREFIX}/${method}`, { ...init, signal: controller.signal })
    const body = await response.json() as ApiResponse<T>
    if (!body.ok) throw new Error(body.error.message)
    return body.value
  } finally {
    window.clearTimeout(timer)
  }
}

async function batch(action: BatchAction, sessionIds: string[]): Promise<BatchResult> {
  return api<BatchResult>('batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, sessionIds }),
  })
}

function useSnapshotStore<T>(store: { getSnapshot(): T; subscribe(listener: () => void): () => void }): T {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function SessionVault({ sessions, workspaces }: Injected): ReactElement {
  const sessionState = useSnapshotStore<SessionListState>(sessions.list)
  const workspaceState = useSnapshotStore<WorkspaceListState>(workspaces.list)
  const [snapshot, setSnapshot] = useState<SessionVaultSnapshot | null>(null)
  const [tab, setTab] = useState<Tab>('archived')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmAction, setConfirmAction] = useState<BatchAction | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await api<SessionVaultSnapshot>('snapshot'))
      setNotice(null)
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh, sessionState.ids, workspaceState.archivedSessionIds])
  useEffect(() => { setSelected(new Set()) }, [tab])

  const rows = useMemo(() => {
    if (snapshot === null) return [] as Array<SessionVaultRow | TrashEntry>
    const source: Array<SessionVaultRow | TrashEntry> = tab === 'trash'
      ? snapshot.trash
      : snapshot.sessions.filter((row) => tab === 'archived' ? row.archived : !row.archived)
    const keyword = query.trim().toLocaleLowerCase()
    if (keyword === '') return source
    return source.filter((row) => `${row.title} ${row.sessionId} ${row.cwd ?? ''}`.toLocaleLowerCase().includes(keyword))
  }, [query, snapshot, tab])

  const selectableIds = useMemo(() => rows
    .filter((row) => tab === 'trash' || !(row as SessionVaultRow).running)
    .map((row) => row.sessionId), [rows, tab])

  const toggle = (sessionId: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected((previous) => previous.size === selectableIds.length ? new Set() : new Set(selectableIds))
  }

  const execute = async (action: BatchAction): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await batch(action, [...selected])
      const text = result.failed.length === 0
        ? `已完成 ${result.succeeded.length} 个会话`
        : `成功 ${result.succeeded.length} 个，失败 ${result.failed.length} 个：${result.failed[0]?.message ?? ''}`
      setNotice({ ok: result.failed.length === 0, text })
      setSelected(new Set())
      await refresh()
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
      setConfirmAction(null)
      setAcknowledged(false)
    }
  }

  const requestAction = (action: BatchAction): void => {
    if (selected.size === 0) return
    if (action === 'purge') {
      setAcknowledged(false)
      setConfirmAction(action)
    } else {
      void execute(action)
    }
  }

  const isTrash = (row: SessionVaultRow | TrashEntry): row is TrashEntry => 'deletedAt' in row

  return <div className="dsv-root">
    <section className="dsv-hero">
      <div>
        <div className="dsv-kicker">DSH rc.7 · local session records</div>
        <h2 className="dsv-title">会话保险库</h2>
        <div className="dsv-subtitle">归档用于隐藏，会话回收站用于可恢复删除。永久清除只处理 DSH 会话记录，不触碰工作区源码与产出文件。</div>
      </div>
      <div className="dsv-stats">
        <div className="dsv-stat"><strong>{snapshot?.counts.active ?? '—'}</strong><span>活动</span></div>
        <div className="dsv-stat"><strong>{snapshot?.counts.archived ?? '—'}</strong><span>归档</span></div>
        <div className="dsv-stat"><strong>{snapshot?.counts.trash ?? '—'}</strong><span>回收站</span></div>
      </div>
    </section>

    <div className="dsv-controls">
      <div className="dsv-tabs">
        <Pill active={tab === 'active'} onClick={() => setTab('active')}>活动</Pill>
        <Pill active={tab === 'archived'} onClick={() => setTab('archived')}>归档</Pill>
        <Pill active={tab === 'trash'} onClick={() => setTab('trash')}>回收站</Pill>
      </div>
      <Input className="dsv-search" icon={<IconSearchOutline16 />} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、会话 ID 或路径" />
      <Button size="sm" variant="outline" icon={<IconRefreshOutline16 />} onClick={() => void refresh()} disabled={loading || busy}>{loading ? '刷新中' : '刷新'}</Button>
    </div>

    {notice !== null && <div className={`dsv-notice ${notice.ok ? 'dsv-notice--ok' : 'dsv-notice--bad'}`}>{notice.text}</div>}

    <div className="dsv-list">
      {rows.length === 0
        ? <div className="dsv-empty">{loading ? '正在读取会话记录…' : '这里暂时没有会话'}</div>
        : rows.map((row) => {
          const trash = isTrash(row)
          const disabled = !trash && row.running
          return <label className="dsv-row" key={row.sessionId}>
            <input className="dsv-check" type="checkbox" checked={selected.has(row.sessionId)} disabled={disabled || busy} onChange={() => toggle(row.sessionId)} />
            <div>
              <div className="dsv-row-title" title={row.title}>{row.title}</div>
              <div className="dsv-row-meta">
                <code title={row.sessionId}>{row.sessionId}</code>
                {row.cwd !== undefined && <span title={row.cwd}>{row.cwd}</span>}
              </div>
            </div>
            <div className="dsv-row-side">
              {!trash && row.running && <span className="dsv-badge dsv-badge--busy">运行中</span>}
              {!trash && row.workspaceTitle !== undefined && <span className="dsv-badge">{row.workspaceTitle}</span>}
              <span>{formatBytes(row.sizeBytes)}</span>
              <span>{formatTime(trash ? row.deletedAt : row.updatedAt)}</span>
            </div>
          </label>
        })}
    </div>

    <div className="dsv-footer">
      <label><input className="dsv-check" type="checkbox" checked={selectableIds.length > 0 && selected.size === selectableIds.length} onChange={toggleAll} /> 全选当前结果</label>
      <span className="dsv-selected">已选 {selected.size} 项</span>
      <span className="dsv-spacer" />
      {tab === 'active' && <>
        <Button size="sm" variant="outline" icon={<IconArchiveOutline20 size={16} />} disabled={selected.size === 0 || busy} onClick={() => requestAction('archive')}>归档</Button>
        <Button size="sm" variant="outline" icon={<IconTrashOutline16 />} disabled={selected.size === 0 || busy} onClick={() => requestAction('trash')}>移入回收站</Button>
      </>}
      {tab === 'archived' && <>
        <Button size="sm" variant="outline" disabled={selected.size === 0 || busy} onClick={() => requestAction('unarchive')}>移出归档</Button>
        <Button size="sm" variant="outline" icon={<IconTrashOutline16 />} disabled={selected.size === 0 || busy} onClick={() => requestAction('trash')}>移入回收站</Button>
      </>}
      {tab === 'trash' && <>
        <Button size="sm" variant="outline" disabled={selected.size === 0 || busy} onClick={() => requestAction('restore')}>恢复</Button>
        <Button size="sm" variant="outline" icon={<IconTrashOutline16 />} disabled={selected.size === 0 || busy} onClick={() => requestAction('purge')}>永久清除</Button>
      </>}
    </div>

    <RiskConfirmation
      open={confirmAction === 'purge'}
      title={`永久清除 ${selected.size} 个会话？`}
      description="这些 DSH 会话记录将从回收站中物理删除，且无法恢复。工作区源码与产出文件不会被删除。"
      acknowledgeLabel="我确认只清除已列出的 DSH 会话记录"
      cancelLabel="取消"
      confirmLabel={busy ? '清除中…' : '永久清除'}
      acknowledged={acknowledged}
      disabled={busy}
      onAcknowledgedChange={setAcknowledged}
      onCancel={() => { setConfirmAction(null); setAcknowledged(false) }}
      onConfirm={() => void execute('purge')}
    />
  </div>
}

export function apply(ctx: ClientContext): void {
  const oldStyle = document.getElementById(STYLE_ID)
  oldStyle?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.append(style)
  ctx.effect(() => () => style.remove(), 'dsh-session-vault: style')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-vault: locale')
  const t = ctx.locale.bind(NS)
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces

  ctx.slots.inject('settings.section', () => {
    const dispose = ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-session-vault',
      order: 62,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ sessions, workspaces }),
    }, SessionVault)
    return dispose
  })
}

export default { name, inject, apply }
