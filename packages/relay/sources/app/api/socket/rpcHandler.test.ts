import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
vi.mock('@/utils/log', () => ({ log: vi.fn() }));
import { rpcHandler } from './rpcHandler';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const caller = { id: 'caller', on: (name: string, handler: (...args: any[]) => Promise<void>) => handlers.set(name, handler), emit: vi.fn(), join: vi.fn(), leave: vi.fn() };
    const lookup = vi.fn().mockResolvedValue([]), room = { timeout: vi.fn(), fetchSockets: lookup }; room.timeout.mockReturnValue(room);
    const io = { in: () => room };
    rpcHandler('fixture-user', caller as unknown as Socket, io as unknown as Server);
    return { invoke: handlers.get('rpc-call')!, lookup };
}

it('no worker after the reconnect window is definitively rejected before any emit', async () => {
    const f = fixture(), callback = vi.fn();
    const call = f.invoke({ method: 'fixture-session:communication', params: 'ciphertext' }, callback);
    await vi.advanceTimersByTimeAsync(16000); await call;
    expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC method not available', effectMayHaveOccurred: false });
});

it('a self-call is definitively unsent', async () => {
    const f = fixture(), callback = vi.fn(), emit = vi.fn();
    f.lookup.mockResolvedValue([{ id: 'caller', emitWithAck: emit }]);
    await f.invoke({ method: 'fixture-session:communication', params: 'ciphertext' }, callback);
    expect(emit).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledWith(expect.objectContaining({ effectMayHaveOccurred: false }));
});

it('a target disappearing after emit remains uncertain', async () => {
    const f = fixture(), callback = vi.fn(), target = { id: 'worker', timeout: vi.fn(), emitWithAck: vi.fn(() => new Promise(() => {})) }; target.timeout.mockReturnValue(target);
    f.lookup.mockResolvedValueOnce([target]).mockResolvedValue([]);
    const call = f.invoke({ method: 'fixture-session:communication', params: 'ciphertext' }, callback);
    await vi.advanceTimersByTimeAsync(4500); await call;
    expect(target.emitWithAck).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ ok: false, error: 'RPC target disconnected' });
});
