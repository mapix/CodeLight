import { describe, expect, it, vi } from 'vitest';
import { NoninvasiveRpcJournal, type BridgeRpcReply } from './noninvasiveRpcJournal';
const context = { serverUrl: 'http://127.0.0.1:57070', sessionId: 'happy-fixture', method: 'abort' };
function setup() {
    let saved: string | null = null;
    const store = { get: async () => saved, set: async(value: string) => { saved = value; }, remove: async() => { saved = null; } };
    const rpc = vi.fn<(_id: string, _method: string, _params: unknown) => Promise<BridgeRpcReply>>();
    const id = vi.fn(() => 'original-command-id');
    return { store, rpc, id, saved: () => saved, journal: new NoninvasiveRpcJournal(store, rpc, id, async value => `digest:${value.length}`) };
}
describe('non-invasive RPC persistent identities', () => {
    it('can recover a model receipt read-only without creating or dispatching another mutation', async () => {
        const f = setup(); const modelContext = { ...context, method: 'codex-controls-update' };
        f.rpc.mockRejectedValueOnce(Error('lost ACK')); await expect(f.journal.execute(modelContext, { model: 'fixture' })).rejects.toThrow();
        f.rpc.mockResolvedValueOnce({ receipt: { id: 'original-command-id', status: 'complete' } });
        expect(await f.journal.recover(modelContext)).toBe(true); expect(f.id).toHaveBeenCalledTimes(1);
        expect(f.rpc).toHaveBeenLastCalledWith('happy-fixture', 'bridge-receipt', { commandId: 'original-command-id' }); expect(f.saved()).toBeNull();
    });
    it('persists before dispatch and confirms only native receipt', async() => {
        const f = setup(); f.rpc.mockImplementation(async() => { expect(f.saved()).not.toBeNull(); return { receipt: { id: 'original-command-id', status: 'complete' } }; });
        await f.journal.execute(context, { turnId: 'native-turn' });
        expect(f.rpc).toHaveBeenCalledWith('happy-fixture', 'abort', { turnId: 'native-turn', commandId: 'original-command-id' });
        expect(f.saved()).toBeNull();
    });
    it('does not dispatch when storage fails', async() => {
        const f = setup(); f.store.set = async() => { throw Error('disk fixture'); };
        await expect(f.journal.execute(context, { turnId: 'native-turn' })).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
    });
    it('lost answer queries original receipt without replay or replacement id', async() => {
        const f = setup(); f.rpc.mockRejectedValueOnce(Error('lost ack'));
        await expect(f.journal.execute(context, { turnId: 'native-turn' })).rejects.toThrow();
        f.rpc.mockResolvedValueOnce({ receipt: { id: 'original-command-id', status: 'complete', result: { interrupted: true } } });
        await expect(f.journal.execute(context, { turnId: 'native-turn' })).resolves.toEqual({ interrupted: true });
        expect(f.rpc).toHaveBeenLastCalledWith('happy-fixture', 'bridge-receipt', { commandId: 'original-command-id' }); expect(f.id).toHaveBeenCalledTimes(1);
    });
    it('unknown receipt keeps the pending record and prevents another mutation', async() => {
        const f = setup(); f.rpc.mockResolvedValue({ receipt: null });
        await expect(f.journal.execute(context, { turnId: 'native-turn' })).rejects.toThrow();
        await expect(f.journal.execute({ ...context, method: 'communication' }, { id: 'other-question' })).rejects.toThrow();
        expect(f.rpc).toHaveBeenLastCalledWith('happy-fixture', 'bridge-receipt', { commandId: 'original-command-id' }); expect(f.id).toHaveBeenCalledTimes(1); expect(f.saved()).not.toBeNull();
    });
    it('same in-flight gesture shares one promise and command', async() => {
        const f = setup(); let resolve!: (value: BridgeRpcReply) => void; f.rpc.mockReturnValue(new Promise(value => { resolve = value; }));
        const one = f.journal.execute(context, { turnId: 'native-turn' }); const two = f.journal.execute(context, { turnId: 'native-turn' }); expect(one).toBe(two);
        await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(1)); resolve({ receipt: { id: 'original-command-id', status: 'complete' } }); await one; expect(f.id).toHaveBeenCalledTimes(1);
    });
});
