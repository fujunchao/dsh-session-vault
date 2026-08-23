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
//# sourceMappingURL=core.d.ts.map