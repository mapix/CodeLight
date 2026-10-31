import type { BridgeRpcReply } from './noninvasiveRpcJournal';
type Selection = { commandId: string; machineId: string; sourceKey: string; selectionClient: string; selectionSeq: number };
type Saved = { client: string; sequence: number; pending: Selection[] };
/** Explicit selections each own an ID; a lost reply never blocks a later user selection or causes replay. */
export class CodeLightSelectionJournal {
    private writes = Promise.resolve();
    constructor(private store: { get(): Promise<string | null>; set(value: string): Promise<void> },
        private rpc: (machineId: string, params: Selection) => Promise<BridgeRpcReply>, private id: () => string) {}
    private mutate<T>(change: (saved: Saved) => T): Promise<T> {
        const operation = this.writes.catch(() => {}).then(async () => {
            const text = await this.store.get();
            const saved = text ? JSON.parse(text) as Saved : { client: this.id(), sequence: 0, pending: [] };
            if (!Array.isArray(saved.pending) || !Number.isSafeInteger(saved.sequence) || typeof saved.client !== 'string') throw Error('Selection journal unavailable');
            const result = change(saved); await this.store.set(JSON.stringify(saved)); return result;
        });
        this.writes = operation.then(() => {}, () => {}); return operation;
    }
    async select(machineId: string, sourceKey: string) {
        const selection = await this.mutate(saved => {
            if (saved.pending.length >= 2048) throw Error('Selection receipt capacity reached');
            const value = { commandId: this.id(), machineId, sourceKey, selectionClient: saved.client, selectionSeq: ++saved.sequence };
            saved.pending.push(value); return value;
        });
        const reply = await this.rpc(machineId, selection);
        if (reply.receipt?.id !== selection.commandId || !['complete', 'failed'].includes(reply.receipt.status)) throw Error('Desktop selection not confirmed');
        await this.mutate(saved => { saved.pending = saved.pending.filter(p => p.commandId !== selection.commandId); });
        if (reply.receipt.status === 'failed' && reply.receipt.error !== 'selection-superseded') throw Error(reply.receipt.error || 'Desktop selection failed');
        return reply.receipt.result;
    }
}
