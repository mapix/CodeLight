export type BridgeReceipt = { id: string; status: 'complete' | 'failed' | 'unknown' | 'running'; result?: unknown; error?: string; target?: string };
export type BridgeRpcReply = { receipt: BridgeReceipt | null };
export type BridgeRpcContext = { serverUrl: string; sessionId: string; method: string; target?: string };
export type PendingBridgeRpc = BridgeRpcContext & { commandId: string; digest: string; createdAt: number };
export type BridgeRpcStorage = { get(): Promise<string | null>; set(value: string): Promise<void>; remove(): Promise<void> };
const UNKNOWN_MESSAGE = 'The computer did not respond';
export class BridgeRpcUnconfirmedError extends Error {
    constructor(readonly commandId: string) { super('The reply result is not confirmed'); this.name = 'BridgeRpcUnconfirmedError'; }
}
export type BridgeRpcTrace = { stage: 'dispatch' | 'transport-error' | 'receipt-query' | 'unconfirmed' | 'confirmed' | 'not-sent'; commandId: string; at: number; status?: string; step?: string };

/** One persistent original command identity; reconnects query it rather than replay it. */
export class NoninvasiveRpcJournal {
    private flight: Promise<unknown> | null = null;
    private flightKey: string | null = null;
    constructor(
        private readonly store: BridgeRpcStorage,
        private readonly rpc: (sessionId: string, method: string, params: unknown) => Promise<BridgeRpcReply>,
        private readonly id: () => string,
        private readonly digest: (payload: string) => Promise<string>,
        private readonly trace?: (event: BridgeRpcTrace) => Promise<void>,
    ) {}

    execute(context: BridgeRpcContext, params: Record<string, unknown>): Promise<unknown> {
        const key = JSON.stringify([context, params]);
        if (this.flight && this.flightKey === 'receipt-recovery') return this.flight.then(async value => {
            const recovery = value as { confirmed: boolean; pending?: PendingBridgeRpc; result?: unknown };
            const previous = recovery.pending;
            if (previous && previous.sessionId === context.sessionId && previous.method === context.method
                && (context.target && previous.target === context.target || previous.digest === await this.digest(JSON.stringify(params)))) {
                if (!recovery.confirmed) throw new BridgeRpcUnconfirmedError(previous.commandId);
                return recovery.result;
            }
            return this.execute(context, params);
        });
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
        const operation = (async () => {
            const text = await this.store.get(); if (!text) return { confirmed: true };
            const pending = JSON.parse(text) as PendingBridgeRpc;
            if (pending.serverUrl !== context.serverUrl || pending.sessionId !== context.sessionId || pending.method !== context.method) return { confirmed: false };
            await this.record('receipt-query', pending.commandId);
            const reply = await this.rpc(pending.sessionId, 'bridge-receipt', { commandId: pending.commandId });
            if (reply?.receipt?.id !== pending.commandId || !['complete', 'failed'].includes(reply.receipt.status)) return { confirmed: false, pending };
            const result = await this.confirm(reply, pending.commandId); return { confirmed: true, pending, result };
        })().finally(() => { if (this.flight === operation) { this.flight = null; this.flightKey = null; } });
        // 恢复查询与提交共享 owner，不能在旧回执查询期间删除新操作的记录。
        this.flight = operation; this.flightKey = 'receipt-recovery'; return (await operation).confirmed;
    }

    private async run(context: BridgeRpcContext, params: Record<string, unknown>): Promise<unknown> {
        const digest = await this.digest(JSON.stringify(params));
        const saved = await this.store.get();
        if (saved) {
            const pending = JSON.parse(saved) as PendingBridgeRpc;
            if (!pending || typeof pending.commandId !== 'string' || typeof pending.digest !== 'string'
                || typeof pending.sessionId !== 'string' || pending.serverUrl !== context.serverUrl) throw new Error(UNKNOWN_MESSAGE);
            // 已接收结果可能丢在网络中；恢复只查询原 id，不能生成第二个 native 副作用。
            let recovered: BridgeRpcReply;
            await this.record('receipt-query', pending.commandId);
            try { recovered = await this.rpc(pending.sessionId, 'bridge-receipt', { commandId: pending.commandId }); }
            catch { throw new BridgeRpcUnconfirmedError(pending.commandId); }
            const sameAction = pending.sessionId === context.sessionId && pending.method === context.method && pending.digest === digest;
            const result = await this.confirm(recovered, pending.commandId);
            // 同一问题旧答案已完成时只结束恢复；重新打开表单的改选不能变成第二次回答。
            const sameTarget = pending.sessionId === context.sessionId && pending.method === context.method && !!context.target && pending.target === context.target;
            if (sameAction || sameTarget) return result;
        }
        const pending: PendingBridgeRpc = { ...context, commandId: this.id(), digest, createdAt: Date.now() };
        // 落盘失败就不派发；只保存身份与摘要，不保存问题答案或权限响应的明文。
        await this.store.set(JSON.stringify(pending));
        await this.record('dispatch', pending.commandId);
        let reply: BridgeRpcReply, queried = false;
        try { reply = await this.rpc(context.sessionId, context.method, { ...params, commandId: pending.commandId }); }
        catch (error) {
            if ((error as { effectMayHaveOccurred?: boolean })?.effectMayHaveOccurred === false) {
                await this.store.remove(); await this.record('not-sent', pending.commandId); throw error;
            }
            await this.record('transport-error', pending.commandId, undefined, (error as { rpcStep?: string })?.rpcStep);
            // ACK 丢失只查询原操作；不能把传输失败当作 native 拒绝，更不能自动重发。
            await this.record('receipt-query', pending.commandId);
            queried = true;
            try { reply = await this.rpc(context.sessionId, 'bridge-receipt', { commandId: pending.commandId }); }
            catch { await this.record('unconfirmed', pending.commandId); throw new BridgeRpcUnconfirmedError(pending.commandId); }
        }
        if (!queried && reply?.receipt?.id !== pending.commandId) {
            await this.record('unconfirmed', pending.commandId);
            await this.record('receipt-query', pending.commandId);
            try { reply = await this.rpc(context.sessionId, 'bridge-receipt', { commandId: pending.commandId }); }
            catch { throw new BridgeRpcUnconfirmedError(pending.commandId); }
        }
        return await this.confirm(reply, pending.commandId);
    }

    private async confirm(reply: BridgeRpcReply, commandId: string): Promise<unknown> {
        if (reply?.receipt?.id !== commandId || reply.receipt.status !== 'complete' && reply.receipt.status !== 'failed') {
            await this.record('unconfirmed', commandId, reply?.receipt?.status); throw new BridgeRpcUnconfirmedError(commandId);
        }
        await this.store.remove();
        await this.record('confirmed', commandId, reply.receipt.status);
        if (reply.receipt.status === 'failed') throw new Error(reply.receipt.error || 'RPC call failed');
        return reply.receipt.result;
    }

    private async record(stage: BridgeRpcTrace['stage'], commandId: string, status?: string, step?: string) {
        const safeStep = step && ['encrypting the request', 'sending the request', 'reading the answer'].includes(step) ? step : undefined;
        try { await this.trace?.({ stage, commandId, at: Date.now(), ...(status ? { status } : {}), ...(safeStep ? { step: safeStep } : {}) }); } catch { /* 诊断失败不改变操作结果。 */ }
    }
}
