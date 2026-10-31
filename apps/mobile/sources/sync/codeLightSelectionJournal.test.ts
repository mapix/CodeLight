import { expect, it } from 'vitest';
import { CodeLightSelectionJournal } from './codeLightSelectionJournal';
function fixture() {
    let saved: string | null = null, count = 0;
    const calls: { commandId: string; selectionSeq: number; sourceKey: string }[] = [];
    const store = { get: async () => saved, set: async (value: string) => { saved = value; } };
    const rpc = async (_machine: string, params: { commandId: string; selectionSeq: number; sourceKey: string }) => { calls.push(params); return { receipt: { id: params.commandId, status: 'complete' as const } }; };
    return { store, rpc, calls, saved: () => JSON.parse(saved!), id: () => `fixture-id-${++count}` };
}
it('each A-B-A user selection issues a fresh ordered navigation even after successful previous visits', async () => {
    const f = fixture(), journal = new CodeLightSelectionJournal(f.store, f.rpc, f.id);
    for (const source of ['A', 'B', 'A']) await journal.select('Mac', source);
    expect(f.calls.map(c => c.sourceKey)).toEqual(['A', 'B', 'A']); expect(f.calls.map(c => c.selectionSeq)).toEqual([1, 2, 3]);
    expect(new Set(f.calls.map(c => c.commandId)).size).toBe(3); expect(f.saved().pending).toHaveLength(0);
});
it('a lost reply retains its original ID while allowing a new explicit selection, with no replay', async () => {
    const f = fixture(); let first = true;
    const journal = new CodeLightSelectionJournal(f.store, async (machine, params) => {
        if (first) { first = false; f.calls.push(params); throw Error('lost ACK'); } return f.rpc(machine, params);
    }, f.id);
    await expect(journal.select('Mac', 'A')).rejects.toThrow('lost ACK'); const original = f.saved().pending[0].commandId;
    await journal.select('Mac', 'B'); expect(f.calls.map(c => c.sourceKey)).toEqual(['A', 'B']); expect(f.saved().pending[0].commandId).toBe(original);
});
it('persists ordering before dispatch and does not dispatch if persistence fails', async () => {
    const f = fixture(); f.store.set = async () => { throw Error('storage unavailable'); };
    await expect(new CodeLightSelectionJournal(f.store, f.rpc, f.id).select('Mac', 'A')).rejects.toThrow('storage unavailable'); expect(f.calls).toHaveLength(0);
});
