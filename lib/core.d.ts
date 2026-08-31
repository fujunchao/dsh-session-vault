export declare const SESSION_ID_RE: RegExp;
export declare function isLoopbackHost(value: string): boolean;
export declare function isLoopbackRemoteAddress(value: string | undefined): boolean;
export declare function isSessionId(value: unknown): value is string;
export declare function isPathInside(root: string, candidate: string): boolean;
export declare function sessionDirectoryFromArtifact(sessionsRoot: string, artifactPath: string): string;
export declare function normalizeIds(value: unknown): string[];
export declare function formatFailure(error: unknown): {
    code: string;
    message: string;
    status: number;
};
export declare function assertUniqueTrashPaths(entries: ReadonlyArray<{
    sessionId: string;
    trashPath: string;
}>): void;
/**
 * 从长期保存的标识中挑出已无对应会话的孤儿。
 *
 * `known` 必须来自一次**成功**的会话列举。调用方绝不能在列举失败时传入空集合，
 * 否则这里会把全部标识判为孤儿——存储故障将因此被放大成状态清空。
 */
export declare function selectOrphanedIds(stored: readonly string[], known: ReadonlySet<string>): string[];
/**
 * 计算仍受插件管辖、因而不得当作孤儿清理的会话标识。
 *
 * 回收站中的会话已被移出 DSH 的 sessions 目录，不会出现在会话列举结果里，但它们
 * 由本插件托管且可随时恢复，并不是孤儿。移入回收站时插件会把会话标记为归档以遮蔽
 * 它；若对账把这些标识判为孤儿清掉，该遮蔽立即失效，会话会重新冒到侧边栏中。
 */
export declare function retainedSessionIds(existing: Iterable<string>, trashed: Iterable<string>): Set<string>;
//# sourceMappingURL=core.d.ts.map