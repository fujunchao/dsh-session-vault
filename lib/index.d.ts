import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-session-vault";
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map