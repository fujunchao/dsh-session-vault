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
//# sourceMappingURL=core.d.ts.map