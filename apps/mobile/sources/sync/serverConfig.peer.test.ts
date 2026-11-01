import { beforeEach, expect, it, vi } from 'vitest';
const values = vi.hoisted(() => new Map<string, string>());
vi.hoisted(() => { vi.stubGlobal('__DEV__', false); });
vi.mock('@/config', () => ({ config: { noninvasiveLocal: true } }));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'fixture' }, digestStringAsync: async (_kind: string, value: string) => value }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return values.get(key); }
    set(key: string, value: string) { values.set(key, value); }
    delete(key: string) { values.delete(key); }
} }));
beforeEach(() => { vi.resetModules(); values.clear(); values.set('custom-server-url', 'https://old.example'); });
it('a verified same-peer change updates the active endpoint while ordinary server edits still require reload', async () => {
    const server = await import('./serverConfig');
    expect(server.getServerUrl()).toBe('https://old.example');
    server.setServerUrl('https://new.example');
    expect(server.getServerUrl()).toBe('https://old.example');
    server.commitPeerServerUrl('https://new.example');
    expect(server.getServerUrl()).toBe('https://new.example');
    expect(values.get('custom-server-url')).toBe('https://new.example');
});
it('same-peer route changes retain the account cache scope and a different peer stays isolated', async () => {
    const { codeLightAccountScope } = await import('./codeLightBackgroundCache');
    const credentials={token:'fixture',secret:'fixture',serverUrl:'https://old.example',peer:{id:'original-peer'}} as any;
    expect(await codeLightAccountScope(credentials)).toBe(await codeLightAccountScope({...credentials,serverUrl:'https://new.example'}));
    expect(await codeLightAccountScope(credentials)).not.toBe(await codeLightAccountScope({...credentials,peer:{id:'other-peer'}}));
});
