import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ endpoint: 'https://old.example', peer: 'peer:fixture-peer', scope: 0, nonce: 0, credentials: {} as any, values: new Map<string,string>(), rpc: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async (key:string) => mocks.values.get(key) ?? null, setItem: async (key:string,value:string) => { mocks.values.set(key,value); } } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture-command-' + ++mocks.nonce }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => mocks.credentials } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mocks.endpoint }));
vi.mock('./apiSocket', () => ({ apiSocket: { peerIdentity: () => mocks.peer, machineRPC: mocks.rpc } }));
vi.mock('./codeLightBackgroundCache', () => ({ codeLightAccountScope: async () => { mocks.endpoint = 'https://new.example'; return 'scope-' + ++mocks.scope; } }));
import { selectCodeLightSession } from './codeLightSessionSelection';
const session: any = { id: 'fixture-session', metadata: { machineId: 'fixture-machine', bridge: { source: { app: 'codex' }, sourceKey: 'fixture-source' } } };
beforeEach(() => {
    mocks.endpoint = 'https://old.example'; mocks.peer = 'peer:fixture-peer'; mocks.credentials = { token: 'fixture-token', secret: 'fixture-secret', peer: { id: 'fixture-peer' } };
    mocks.rpc.mockClear(); mocks.rpc.mockImplementation(async (_id:string,_method:string,params:any) => ({ receipt: { id: params.commandId, status: 'complete', result: {} } }));
});
it('a verified same-peer route change during scope loading does not fail desktop selection', async () => {
    await expect(selectCodeLightSession(session)).resolves.toBeUndefined(); expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
it('a different peer is rejected before selection dispatch', async () => {
    mocks.peer = 'peer:other-peer';
    await expect(selectCodeLightSession(session)).rejects.toThrow('Selection authority changed'); expect(mocks.rpc).not.toHaveBeenCalled();
});
it('legacy endpoint changes retain the original authority fence', async () => {
    delete mocks.credentials.peer;
    await expect(selectCodeLightSession(session)).rejects.toThrow('Selection authority changed'); expect(mocks.rpc).not.toHaveBeenCalled();
});
