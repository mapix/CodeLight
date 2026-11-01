import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sockets: [] as any[], nonce: 0, credentials: { token: 'fixture-token' } as any }));
vi.mock('socket.io-client', () => ({ io: vi.fn((_url, options) => {
    const socket: any = { connected: true, on: vi.fn(), onAny: vi.fn(), disconnect: vi.fn(), emit: vi.fn(), timeout: vi.fn(), emitWithAck: vi.fn().mockResolvedValue({ ok: true, result: 'reply' }) };
    socket.options=options; socket.io={ opts:options, on:vi.fn() }; socket.timeout.mockReturnValue(socket); mocks.sockets.push(socket); return socket;
}) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'fixture' } } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (count: number) => new Uint8Array(count).fill(++mocks.nonce) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => mocks.credentials } }));
vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./storage', () => ({ storage: {} }));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: true } }));
import { apiSocket } from './apiSocket';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@/encryption/base64';
afterEach(() => { apiSocket.disconnect(); mocks.sockets.length = 0; mocks.credentials = { token: 'fixture-token' }; });

it('a route disconnect cancels an outstanding peer read instead of leaving the session loading', async () => {
    const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)), device=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
    const endpoint='https://read.example';
    const peer={id:'fixture-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'cloudflare',kind:'cloudflare' as const,url:endpoint}],
        device:{publicKey:encodeBase64(device.publicKey,'base64url'),secretKey:encodeBase64(device.secretKey,'base64url')}};
    apiSocket.initialize({endpoint,token:'fixture-token',peer},{} as any);
    mocks.credentials = { token: 'fixture-token', peer };
    const request=vi.fn((_url: unknown, options: any) => new Promise((_resolve,reject) => options.signal.addEventListener('abort',()=>reject(Error('read aborted')))));
    vi.stubGlobal('fetch',request);
    try {
        const pending=apiSocket.peerRequest('/api/peer/catalog');
        await vi.waitFor(()=>expect(request).toHaveBeenCalled());
        apiSocket.disconnect(); await expect(pending).rejects.toThrow('read aborted');
    } finally { vi.unstubAllGlobals(); }
});

it('saved peer socket initialization works before a pairing provider installs any PRNG', () => {
    const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)), device=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
    const endpoint='https://cold.example';
    const peer={id:'fixture-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'cloudflare',kind:'cloudflare' as const,url:endpoint}],
        device:{publicKey:encodeBase64(device.publicKey,'base64url'),secretKey:encodeBase64(device.secretKey,'base64url')}};
    const unavailable=vi.spyOn(nacl,'randomBytes').mockImplementation(()=>{throw Error('no PRNG');});
    try {
        expect(()=>apiSocket.initialize({endpoint,token:'fixture-token',peer},{} as any)).not.toThrow();
        expect(mocks.sockets).toHaveLength(1); expect(unavailable).not.toHaveBeenCalled();
        const options=mocks.sockets[0].options;
        const packet=JSON.parse(Buffer.from(options.extraHeaders.Authorization.slice(10),'base64url').toString());
        const plain=nacl.box.open(Buffer.from(packet.ciphertext,'base64url'),Buffer.from(packet.nonce,'base64url'),device.publicKey,mac.secretKey)!;
        expect(JSON.parse(Buffer.from(plain).toString()).path).toBe('/v1/updates/');
        expect(options.path).toBe('/v1/updates/');
    } finally { unavailable.mockRestore(); }
});
it('each reconnect attempt reopens connecting status and renews the one-use proof before another error', () => {
    const mac=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)), device=nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
    const endpoint='http://192.168.1.2:8800',peer={id:'fixture-peer',key:encodeBase64(mac.publicKey,'base64url'),channels:[{id:'local',kind:'local' as const,url:endpoint}],device:{publicKey:encodeBase64(device.publicKey,'base64url'),secretKey:encodeBase64(device.secretKey,'base64url')}};
    apiSocket.initialize({endpoint,token:'fixture-token',peer},{} as any);
    const socket=mocks.sockets[0], statuses:string[]=[], release=apiSocket.onStatusChange(status=>statuses.push(status));
    const error=socket.on.mock.calls.find((call:any[])=>call[0]==='connect_error')[1];
    const retry=socket.io.on.mock.calls.find((call:any[])=>call[0]==='reconnect_attempt')[1];
    const first=socket.io.opts.extraHeaders.Authorization;
    error(Error('fixture')); retry(); const second=socket.io.opts.extraHeaders.Authorization; error(Error('fixture'));
    expect(statuses).toEqual(['connecting','error','connecting','error']); expect(second).not.toBe(first); release();
});

it('a disconnected socket cannot buffer a mutation for a later reconnect', async () => {
    const account: any = { getSessionEncryption: () => ({ encryptRaw: async () => 'ciphertext', decryptRaw: async () => ({}) }) };
    apiSocket.initialize({ endpoint: 'https://current.example', token: 'fixture-token' }, account);
    mocks.sockets[0].connected = false;
    await expect(apiSocket.sessionRPC('fixture-id', 'communication', {})).rejects.toMatchObject({ effectMayHaveOccurred: false });
    expect(mocks.sockets[0].emitWithAck).not.toHaveBeenCalled();
});

it.each(['session', 'machine'] as const)('a %s request cannot move to a different connection while encrypting', async kind => {
    let finish!: (value: string) => void;
    const encryption = { encryptRaw: () => new Promise<string>(resolve => { finish = resolve; }), decryptRaw: async () => ({}) };
    const account: any = { getSessionEncryption: () => encryption, getMachineEncryption: () => encryption };
    apiSocket.initialize({ endpoint: 'https://first.example', token: 'fixture-token' }, account);
    const result = kind === 'session'
        ? apiSocket.sessionRPC('fixture-id', 'communication', {}, 'https://first.example')
        : apiSocket.machineRPC('fixture-id', 'operation', {}, 'https://first.example');
    apiSocket.disconnect(); apiSocket.initialize({ endpoint: 'https://second.example', token: 'other-fixture' }, account);
    finish('ciphertext'); await expect(result).rejects.toMatchObject({ message: 'RPC connection changed', effectMayHaveOccurred: false });
    expect(mocks.sockets.every(s => s.emitWithAck.mock.calls.length === 0)).toBe(true);
});

it('an expected connection mismatch fails before encryption or dispatch', async () => {
    const encryptRaw = vi.fn(), account: any = { getSessionEncryption: () => ({ encryptRaw }) };
    apiSocket.initialize({ endpoint: 'https://current.example', token: 'fixture-token' }, account);
    await expect(apiSocket.sessionRPC('fixture-id', 'communication', {}, 'https://old.example')).rejects.toThrow('RPC connection changed');
    expect(encryptRaw).not.toHaveBeenCalled(); expect(mocks.sockets[0].emitWithAck).not.toHaveBeenCalled();
});

it('a matching connection still encrypts, dispatches and decrypts the reply', async () => {
    const encryptRaw = vi.fn().mockResolvedValue('ciphertext'), decryptRaw = vi.fn().mockResolvedValue({ accepted: true });
    const account: any = { getSessionEncryption: () => ({ encryptRaw, decryptRaw }) };
    apiSocket.initialize({ endpoint: 'https://current.example', token: 'fixture-token' }, account);
    await expect(apiSocket.sessionRPC('fixture-id', 'communication', { answer: 'fixture' }, 'https://current.example')).resolves.toEqual({ accepted: true });
    expect(mocks.sockets[0].emitWithAck).toHaveBeenCalledWith('rpc-call', { method: 'fixture-id:communication', params: 'ciphertext' });
    expect(decryptRaw).toHaveBeenCalledWith('reply');
});

it.each(['session', 'machine'] as const)('a %s broker rejection before worker emission remains definitively unsent', async kind => {
    const encryption = { encryptRaw: async () => 'ciphertext', decryptRaw: vi.fn() };
    apiSocket.initialize({ endpoint: 'https://current.example', token: 'fixture-token' }, { getSessionEncryption: () => encryption, getMachineEncryption: () => encryption } as any);
    mocks.sockets[0].emitWithAck.mockResolvedValue({ ok: false, error: 'RPC method not available', effectMayHaveOccurred: false });
    const result = kind === 'session' ? apiSocket.sessionRPC('fixture', 'communication', {}) : apiSocket.machineRPC('fixture', 'operation', {});
    await expect(result).rejects.toMatchObject({ message: 'RPC method not available', effectMayHaveOccurred: false });
    expect(encryption.decryptRaw).not.toHaveBeenCalled();
});

it('a stored credential from another peer cannot authorize an HTTP request to the current Mac', async () => {
    const mac = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)), device = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
    const endpoint = 'https://current.example', peer = { id: 'current-peer', key: encodeBase64(mac.publicKey, 'base64url'), channels: [{ id: 'cloudflare', kind: 'cloudflare' as const, url: endpoint }], device: { publicKey: encodeBase64(device.publicKey, 'base64url'), secretKey: encodeBase64(device.secretKey, 'base64url') } };
    apiSocket.initialize({ endpoint, token: 'fixture-token', peer }, {} as any); mocks.credentials = { token: 'other-token', peer: { ...peer, id: 'different-peer' } };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try { await expect(apiSocket.request('/codelight/notifications/presence', { method: 'POST' })).rejects.toThrow('authenticated peer changed'); expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
});
