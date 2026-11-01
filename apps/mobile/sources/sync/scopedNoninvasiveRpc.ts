import { NoninvasiveRpcJournal, type BridgeRpcReply, type BridgeRpcStorage } from './noninvasiveRpcJournal';
import { rpcTarget } from '@slopus/happy-wire/codelight';

type KeyedStorage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    getAllKeys?(): Promise<readonly string[]>;
};
type Options = {
    storage: KeyedStorage;
    legacyKey?: string;
    keyPrefix: string;
    legacyScopedPrefix?: string;
    serverUrl(): string;
    identity?(): string;
    digest(value: string): Promise<string>;
    id(): string;
    rpc(entityId: string, method: string, params: unknown, serverUrl: string): Promise<BridgeRpcReply>;
};

/** Each authenticated connection/entity owns its operation journal. */
export class ScopedNoninvasiveRpc {
    private journals = new Map<string, Promise<NoninvasiveRpcJournal>>();
    constructor(private readonly options: Options) {}

    private journal(authority: string, entityId: string, target: string) {
        const scope = JSON.stringify([authority, entityId, target]);
        let existing = this.journals.get(scope);
        if (!existing) {
            const create = this.options.digest(scope).then(async key => {
                const storageKey = this.options.keyPrefix + key;
                let legacyRead: { key: string; value: string } | null = null;
                let legacyReply: { id: string; reply: BridgeRpcReply } | null = null;
                const store: BridgeRpcStorage = {
                    get: async () => {
                        const current = await this.options.storage.getItem(storageKey);
                        if (current !== null) { legacyRead = null; legacyReply = null; return current; }
                        const origin = this.options.serverUrl();
                        const oldKeys = this.options.legacyKey ? [this.options.legacyKey] : [];
                        if (this.options.legacyScopedPrefix) oldKeys.push(this.options.legacyScopedPrefix + await this.options.digest(JSON.stringify([origin, entityId])));
                        legacyRead = null;
                        for (const oldKey of oldKeys) {
                            const raw = await this.options.storage.getItem(oldKey); if (raw === null) continue;
                            const pending = JSON.parse(raw);
                            if (pending.sessionId !== entityId || pending.serverUrl !== origin) continue;
                            // 旧记录缺少问题/turn 身份时，只读原 Mac 回执来判断目标；不能猜测或重发。
                            const receipt = await this.options.rpc(entityId, 'bridge-receipt', { commandId: pending.commandId }, origin);
                            const savedReceipt = receipt.receipt;
                            if (savedReceipt && savedReceipt.id === pending.commandId && savedReceipt.target && savedReceipt.target !== target) continue;
                            legacyRead = { key: oldKey, value: raw };
                            legacyReply = { id: pending.commandId, reply: receipt };
                            return JSON.stringify({ ...pending, serverUrl: authority });
                        }
                        return null;
                    },
                    set: value => this.options.storage.setItem(storageKey, value),
                    remove: async () => {
                        await this.options.storage.removeItem(storageKey);
                        if (legacyRead !== null && await this.options.storage.getItem(legacyRead.key) === legacyRead.value) {
                            await this.options.storage.removeItem(legacyRead.key);
                            legacyRead = null;
                        }
                    },
                };
                return new NoninvasiveRpcJournal(store, (id, method, params) => {
                    if ((this.options.identity?.() ?? this.options.serverUrl()) !== authority) throw Object.assign(Error('RPC connection changed'), { effectMayHaveOccurred: false });
                    if (method === 'bridge-receipt' && legacyReply && (params as { commandId?: string }).commandId === legacyReply.id) {
                        const reply = legacyReply.reply; legacyReply = null; return Promise.resolve(reply);
                    }
                    return this.options.rpc(id, method, params, this.options.serverUrl());
                }, this.options.id, this.options.digest, async event => {
                    const key = storageKey + ':diagnostics';
                    const prior = JSON.parse(await this.options.storage.getItem(key) ?? '[]');
                    await this.options.storage.setItem(key, JSON.stringify([...(Array.isArray(prior) ? prior : []), event].slice(-32)));
                });
            });
            this.journals.set(scope, create);
            void create.catch(() => { if (this.journals.get(scope) === create) this.journals.delete(scope); });
            existing = create;
        }
        return existing;
    }

    async execute(entityId: string, method: string, params: Record<string, unknown>) {
        const authority = this.options.identity?.() ?? this.options.serverUrl();
        const target = rpcTarget(method, params);
        return (await this.journal(authority, entityId, target)).execute({ serverUrl: authority, sessionId: entityId, method, target }, params);
    }

    async recover(entityId: string, method: string, params: Record<string, unknown> = {}) {
        const authority = this.options.identity?.() ?? this.options.serverUrl();
        const targets = new Set<string>();
        if (Object.keys(params).length) targets.add(rpcTarget(method, params));
        else {
            for (const key of this.journals.keys()) {
                const [owner, entity, target] = JSON.parse(key);
                if (owner === authority && entity === entityId && JSON.parse(target)[0] === method) targets.add(target);
            }
            for (const key of await this.options.storage.getAllKeys?.() ?? []) {
                if (!key.startsWith(this.options.keyPrefix)) continue;
                const raw = await this.options.storage.getItem(key); if (raw === null) continue;
                const pending = JSON.parse(raw);
                if (pending.serverUrl === authority && pending.sessionId === entityId && pending.method === method && typeof pending.target === 'string') targets.add(pending.target);
            }
        }
        if (!targets.size) targets.add(rpcTarget(method, params));
        let confirmed = true;
        for (const target of targets) if (!await (await this.journal(authority, entityId, target)).recover({ serverUrl: authority, sessionId: entityId, method, target })) confirmed = false;
        return confirmed;
    }

    async recoverPending() {
        const authority = this.options.identity?.() ?? this.options.serverUrl();
        const pending = new Map<string, { sessionId: string; method: string }>();
        for (const key of await this.options.storage.getAllKeys?.() ?? []) {
            if (!key.startsWith(this.options.keyPrefix) || key.endsWith(':diagnostics')) continue;
            try {
                const value = JSON.parse(await this.options.storage.getItem(key) ?? 'null');
                if (value?.serverUrl === authority && typeof value.sessionId === 'string' && typeof value.method === 'string') pending.set(JSON.stringify([value.sessionId, value.method]), value);
            } catch { /* 不能读出的旧记录保留，不能猜测为完成。 */ }
        }
        for (const value of pending.values()) { try { await this.recover(value.sessionId, value.method); } catch { /* 下次连接或显式检查继续查询原 id。 */ } }
    }
}
