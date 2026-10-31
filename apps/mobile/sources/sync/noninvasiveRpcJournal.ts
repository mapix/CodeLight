export type BridgeReceipt = { id: string; status: 'complete' | 'failed' | 'unknown' | 'running'; result?: unknown; error?: string };
export type BridgeRpcReply = { receipt: BridgeReceipt | null };
export type BridgeRpcContext = { serverUrl: string; sessionId: string; method: string };
export type PendingBridgeRpc = BridgeRpcContext & { commandId: string; digest: string; createdAt: number };
export type BridgeRpcStorage = { get(): Promise<string | null>; set(value: string): Promise<void>; remove(): Promise<void> };
const UNKNOWN_MESSAGE = 'The computer did not respond';

/** One persistent original command identity; reconnects query it rather than replay it. */
export class NoninvasiveRpcJournal {
    private flight: Promise<unknown> | null = null;
    private flightKey: string | null = null;
    constructor(
        private readonly store: BridgeRpcStorage,
        private readonly rpc: (sessionId: string, method: string, params: unknown) => Promise<BridgeRpcReply>,
        private readonly id: () => string,
        private readonly digest: (payload: string) => Promise<string>,
    ) {}

    execute(context: BridgeRpcContext, params: Record<string, unknown>): Promise<unknown> {
        const key = JSON.stringify([context, params]);
        if (this.flight) return key === this.flightKey ? this.flight : Promise.reject(new Error(UNKNOWN_MESSAGE));
        this.flightKey = key;
        const operation = this.run(context, params).finally(() => {
            if (this.flight === operation) { this.flight = null; this.flightKey = null; }
        });
        this.flight = operation;
        return operation;
    }

    /** Receipt-only recovery; never dispatches a new mutation or invents another ID. */
    async recover(context: BridgeRpcContext): Promise<boolean> {
        if (this.flight) return false;
        const text = await this.store.get(); if (!text) return true;
        const pending = JSON.parse(text) as PendingBridgeRpc;
        if (pending.serverUrl !== context.serverUrl || pending.sessionId !== context.sessionId || pending.method !== context.method) return false;
        const reply = await this.rpc(pending.sessionId, 'bridge-receipt', { commandId: pending.commandId });
        if (reply.receipt?.id !== pending.commandId || !['complete', 'failed'].includes(reply.receipt.status)) return false;
        await this.confirm(reply, pending.commandId); return true;
    }

    private async run(context: BridgeRpcContext, params: Record<string, unknown>): Promise<unknown> {
        const digest = await this.digest(JSON.stringify(params));
        const saved = await this.store.get();
        if (saved) {
            const pending = JSON.parse(saved) as PendingBridgeRpc;
            if (!pending || typeof pending.commandId !== 'string' || typeof pending.digest !== 'string'
                || typeof pending.sessionId !== 'string' || pending.serverUrl !== context.serverUrl) throw new Error(UNKNOWN_MESSAGE);
            // 已接收结果可能丢在网络中；恢复只查询原 id，不能生成第二个 native 副作用。
            const recovered = await this.rpc(pending.sessionId, 'bridge-receipt', { commandId: pending.commandId });
            const sameAction = pending.sessionId === context.sessionId && pending.method === context.method && pending.digest === digest;
            const result = await this.confirm(recovered, pending.commandId);
            if (sameAction) return result;
        }
        const pending: PendingBridgeRpc = { ...context, commandId: this.id(), digest, createdAt: Date.now() };
        // 落盘失败就不派发；只保存身份与摘要，不保存问题答案或权限响应的明文。
        await this.store.set(JSON.stringify(pending));
        const reply = await this.rpc(context.sessionId, context.method, { ...params, commandId: pending.commandId });
        return await this.confirm(reply, pending.commandId);
    }

    private async confirm(reply: BridgeRpcReply, commandId: string): Promise<unknown> {
        if (reply.receipt?.id !== commandId) throw new Error(UNKNOWN_MESSAGE);
        if (reply.receipt?.status !== 'complete' && reply.receipt?.status !== 'failed') throw new Error(UNKNOWN_MESSAGE);
        await this.store.remove();
        if (reply.receipt.status === 'failed') throw new Error(reply.receipt.error || 'RPC call failed');
        return reply.receipt.result;
    }
}
