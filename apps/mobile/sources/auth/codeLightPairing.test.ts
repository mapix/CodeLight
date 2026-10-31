import { describe, expect, it } from 'vitest';
import { CodeLightPairingController, parseCodeLightPairingCode, type PendingCodeLightPairing, type PairingCredentials } from './codeLightPairing';

const origin = 'https://fixture.example';
const url = `codelight://pair?v=1&origin=${encodeURIComponent(origin)}&invite=${'A'.repeat(43)}&key=${'B'.repeat(43)}&expires=10000`;
function fixture(selected = origin) {
    let pending: PendingCodeLightPairing | null = null, credentials: PairingCredentials | null = null, generated = 0, exchanged = 0, reloads = 0, failSave = false, failLogin = false;
    const controller = new CodeLightPairingController({
        load: async () => pending, save: async value => { if (failSave) throw Error('store'); pending = value; }, clear: async () => { pending = null; },
        generateKey: () => { generated++; return { publicKey: 'device', secretKey: 'private-device-key' }; },
        encrypt: () => ({ publicKey: 'device', nonce: 'nonce', ciphertext: 'cipher' }), exchange: async () => { exchanged++; return {}; },
        decrypt: () => ({ version: 1, origin, macKey: 'B'.repeat(43), credentials: { token: 'token', secret: 'C'.repeat(43), serverUrl: origin } }),
        currentOrigin: () => selected, selectOrigin: value => { selected = value; }, credentials: () => credentials,
        saveCredentials: async value => { credentials = value; }, login: async value => { if (failLogin) throw Error('login'); credentials = value; },
        reload: async () => { reloads++; }, now: () => 1000,
    });
    return { controller, counts: () => ({ generated, exchanged, reloads }), pending: () => pending, credentials: () => credentials,
        failSave: () => { failSave = true; }, failLogin: (value: boolean) => { failLogin = value; } };
}
describe('scan-only Mac pairing', () => {
    it('coalesces scans and persists one device key before exchange without a registration action', async () => {
        const f = fixture(); await Promise.all([f.controller.connect(url), f.controller.connect(url)]);
        expect(f.counts()).toEqual({ generated: 1, exchanged: 1, reloads: 0 }); expect(f.credentials()?.serverUrl).toBe(origin); expect(f.pending()).toBeNull();
    });
    it('secure storage failure has no network/login effect', async () => {
        const f = fixture(); f.failSave(); await expect(f.controller.connect(url)).rejects.toMatchObject({ code: 'storage' });
        expect(f.counts().exchanged).toBe(0); expect(f.credentials()).toBeNull();
    });
    it('origin switch reloads first and resumes the same device key', async () => {
        const f = fixture('http://127.0.0.1:57070'); await f.controller.connect(url);
        expect(f.counts()).toEqual({ generated: 1, exchanged: 0, reloads: 1 }); await f.controller.resume();
        expect(f.counts()).toEqual({ generated: 1, exchanged: 1, reloads: 1 });
    });
    it('login failure retains the scan and private key for an idempotent retry', async () => {
        const f = fixture(); f.failLogin(true); await expect(f.controller.connect(url)).rejects.toThrow('login');
        f.failLogin(false); await f.controller.resume(); expect(f.counts().generated).toBe(1); expect(f.credentials()).not.toBeNull();
    });
    it('rejects unsupported, duplicate, expired and insecure public destinations before network activity', () => {
        for (const invalid of [url + '&v=1', url + '#secret', url.replace('expires=10000', 'expires=1'), url.replace(encodeURIComponent(origin), encodeURIComponent('http://public.example')), url.replace(encodeURIComponent(origin), encodeURIComponent('https://user:pass@fixture.example'))]) expect(() => parseCodeLightPairingCode(invalid, 1000)).toThrow();
    });
});
