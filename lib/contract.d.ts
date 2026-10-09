export declare const API_PREFIX = "/dsh-session-vault/api";
export interface SessionVaultRow {
    sessionId: string;
    title: string;
    cwd?: string;
    createdAt?: number;
    updatedAt?: number;
    archived: boolean;
    running: boolean;
    sizeBytes: number;
    workspaceTitle?: string;
}
export interface TrashEntry {
    sessionId: string;
    title: string;
    cwd?: string;
    originalPath: string;
    trashPath: string;
    deletedAt: number;
    sizeBytes: number;
    wasArchived: boolean;
}
/** 永久清除的墓碑：清除提交后仍需观察原位一段时间，迟到的写入器副本由巡检清除。 */
export interface PurgedTombstone {
    sessionId: string;
    originalPath: string;
    purgedAt: number;
}
export interface SessionVaultSnapshot {
    sessions: SessionVaultRow[];
    trash: TrashEntry[];
    counts: {
        active: number;
        archived: number;
        trash: number;
    };
}
export interface ApiSuccess<T> {
    ok: true;
    value: T;
}
export interface ApiFailure {
    ok: false;
    error: {
        code: string;
        message: string;
    };
}
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
export type BatchAction = 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge';
export interface BatchResult {
    succeeded: string[];
    failed: Array<{
        sessionId: string;
        code: string;
        message: string;
    }>;
}
//# sourceMappingURL=contract.d.ts.map