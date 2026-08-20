import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client';
import type { ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client';
export declare const name = "dsh-session-vault/client";
export declare const inject: string[];
declare const NS = "dsh-session-vault";
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        [NS]: 'nav';
    }
}
interface ClientContext {
    slots: SlotRegistry;
    effect(effect: () => void | (() => void), label?: string): void;
    sessions: ISessions;
    workspaces: IWorkspaces;
    locale: {
        getLocale(): {
            active: string;
        };
        subscribe(listener: () => void): () => void;
        register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void;
        bind(namespace: string): (key: 'nav') => string;
    };
}
export declare function apply(ctx: ClientContext): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=client.d.ts.map