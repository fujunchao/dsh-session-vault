export declare const SESSION_ID_RE: RegExp;
export declare function isLoopbackHost(value: string): boolean;
export declare function isLoopbackRemoteAddress(value: string | undefined): boolean;
export declare function isSessionId(value: unknown): value is string;
export declare function isPathInside(root: string, candidate: string): boolean;
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
export declare function ensureDirectoryAbsent(path: string, { attempts, intervalMs }?: {
    attempts?: number;
    intervalMs?: number;
}): Promise<void>;
/**
 * 在 DSH sessions 根目录下按会话 ID 定位其记录文件。
 *
 * DSH 0.1.7 起 sessionPersistence 服务不再暴露 locate()/物理路径（快照只给
 * sizeBytes 等派生信息）。会话记录实际存放在
 * `<sessionsRoot>/<工作目录编码>/<sessionId>/session.*`，本插件需要物理
 * 移动文件（移入回收站/恢复/清除），因此这里自行扫描定位；找不到时返回
 * undefined，与旧 locate() 对内存型后端的语义一致。
 */
export declare function locateSessionArtifact(sessionsRoot: string, sessionId: string): string | undefined;
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