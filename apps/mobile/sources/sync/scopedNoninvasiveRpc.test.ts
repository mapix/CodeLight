import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ScopedNoninvasiveRpc } from './scopedNoninvasiveRpc';
import type { BridgeRpcReply } from './noninvasiveRpcJournal';
import { rpcTarget } from '@slopus/happy-wire/codelight';

function fixture() {
    const values = new Map<string, string>();
    let origin = 'https://relay.example/r/fixture';
    let nextId = 0;
    const rpc = vi.fn(async (_entity: string, _method: string, params: any, _origin: string): Promise<BridgeRpcReply> => ({ receipt: { id: params.commandId, status: 'complete' } }));
    const id = vi.fn(() => `new-command-${++nextId}`);
    const client = new ScopedNoninvasiveRpc({
        storage: { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); }, getAllKeys: async () => [...values.keys()] },
        legacyKey: 'legacy', keyPrefix: 'v2:', serverUrl: () => origin, rpc, id,
        digest: async value => createHash('sha256').update(value).digest('hex'),
    });
    const pending = () => [...values].filter(([key]) => !key.endsWith(':diagnostics')).map(([, value]) => value);
    return { client, values, rpc, id, pending, setOrigin: (value: string) => { origin = value; } };
}
const legacy = { serverUrl: 'https://old-entry.example', sessionId: 'old-session', method: 'communication', commandId: 'old-original-id', digest: 'old-digest', createdAt: 1 };

describe('scoped native operation journals', () => {
    it('an unresolved old entry/session does not block a new answer or delete the old record', async () => {
        const f = fixture(), saved = JSON.stringify(legacy);
        f.values.set('legacy', saved);
        await f.client.execute('current-session', 'communication', { id: 'current-question' });
        expect(f.rpc).toHaveBeenCalledTimes(1);
        expect(f.rpc).toHaveBeenCalledWith('current-session', 'communication', { id: 'current-question', commandId: 'new-command-1' }, 'https://relay.example/r/fixture');
        expect(f.values.get('legacy')).toBe(saved);
    });
    it('an unresolved session does not lock other sessions on the same connection', async () => {
        const f = fixture();
        f.rpc.mockResolvedValueOnce({ receipt: null });
        f.rpc.mockResolvedValueOnce({ receipt: null });
        await expect(f.client.execute('first-session', 'abort', { turnId: 'first-turn' })).rejects.toMatchObject({ name: 'BridgeRpcUnconfirmedError' });
        const pending = [...f.values.values()][0];
        await f.client.execute('second-session', 'communication', { id: 'second-question' });
        expect(f.pending()).toEqual([pending]);
        expect(f.rpc).toHaveBeenCalledTimes(3);
    });
    it('the original legacy context only queries its original receipt before another action', async () => {
        const f = fixture(); f.values.set('legacy', JSON.stringify(legacy)); f.setOrigin(legacy.serverUrl);
        f.rpc.mockResolvedValueOnce({ receipt: { id: legacy.commandId, status: 'complete' } });
        await f.client.execute(legacy.sessionId, 'abort', { turnId: 'later-turn' });
        expect(f.rpc.mock.calls[0]).toEqual([legacy.sessionId, 'bridge-receipt', { commandId: legacy.commandId }, legacy.serverUrl]);
        expect(f.rpc.mock.calls[1][1]).toBe('abort');
        expect(f.values.has('legacy')).toBe(false);
    });
    it('unknown recovery in the original legacy context retains its ID and blocks redispatch', async () => {
        const f = fixture(), saved = JSON.stringify(legacy); f.values.set('legacy', saved); f.setOrigin(legacy.serverUrl);
        f.rpc.mockResolvedValue({ receipt: null });
        await expect(f.client.execute(legacy.sessionId, 'communication', {})).rejects.toThrow();
        expect(f.rpc).toHaveBeenCalledWith(legacy.sessionId, 'bridge-receipt', { commandId: legacy.commandId }, legacy.serverUrl);
        expect(f.id).not.toHaveBeenCalled(); expect(f.values.get('legacy')).toBe(saved);
    });
    it('concurrent gestures from one scope dispatch once while another scope can proceed', async () => {
        const f = fixture(); let finish!: (value: BridgeRpcReply) => void;
        f.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const first = f.client.execute('first-session', 'abort', { turnId: 'first-turn' });
        const same = f.client.execute('first-session', 'abort', { turnId: 'first-turn' });
        await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(1));
        await f.client.execute('second-session', 'communication', {});
        finish({ receipt: { id: 'new-command-1', status: 'complete' } });
        await Promise.all([first, same]); expect(f.rpc).toHaveBeenCalledTimes(2);
    });
    it('a lost scoped ACK is recovered read-only without a new mutation ID', async () => {
        const f = fixture(); f.rpc.mockRejectedValueOnce(Error('lost ACK'));
        f.rpc.mockRejectedValueOnce(Error('receipt still unavailable'));
        await expect(f.client.execute('current-session', 'communication', { id: 'question' })).rejects.toThrow();
        f.rpc.mockResolvedValueOnce({ receipt: { id: 'new-command-1', status: 'complete' } });
        expect(await f.client.recover('current-session', 'communication')).toBe(true);
        expect(f.rpc).toHaveBeenLastCalledWith('current-session', 'bridge-receipt', { commandId: 'new-command-1' }, 'https://relay.example/r/fixture');
        expect(f.id).toHaveBeenCalledTimes(1);
    });
    it('an unresolved older question on the same session cannot block a new question', async () => {
        const f = fixture();
        f.rpc.mockResolvedValueOnce({ receipt: null });
        f.rpc.mockResolvedValueOnce({ receipt: null });
        await expect(f.client.execute('current-session', 'communication', { id: 'old-question' })).rejects.toThrow();
        const saved = [...f.values.values()][0];
        await f.client.execute('current-session', 'communication', { id: 'new-question' });
        expect(f.pending()).toEqual([saved]); expect(f.id).toHaveBeenCalledTimes(2);
    });
    it('legacy target lookup permits a different question without replaying its unknown original ID', async () => {
        const f = fixture(); f.setOrigin(legacy.serverUrl); const saved = JSON.stringify(legacy); f.values.set('legacy', saved);
        f.rpc.mockResolvedValueOnce({ receipt: { id: legacy.commandId, status: 'unknown', target: rpcTarget('communication', { id: 'old-question' }) } });
        await f.client.execute(legacy.sessionId, 'communication', { id: 'new-question' });
        expect(f.rpc.mock.calls[0][1]).toBe('bridge-receipt');
        expect(f.rpc.mock.calls[1][1]).toBe('communication'); expect(f.values.get('legacy')).toBe(saved);
    });
});
