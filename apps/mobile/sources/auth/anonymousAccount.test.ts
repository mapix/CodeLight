import { describe, it, expect } from 'vitest';
import { AnonymousAccountCreation, type PendingAnonymousAccount } from './anonymousAccount';
import { InitializationGate } from '../sync/initializationGate';
import { normalizeServerOrigin } from '../utils/serverOrigin';

function fixture() {
    let saved: PendingAnonymousAccount | null = null, generated = 0, calls = 0, loggedIn = 0, storeFails = false, loginFails = false;
    const used: string[] = [];
    const controller = new AnonymousAccountCreation({
        load: async () => saved, save: async (_, value) => { if (storeFails) throw Error('test store failure'); saved = value; }, clear: async () => { saved = null; },
        generateSecret: async () => `fixture-seed-${++generated}`,
        authenticate: async secret => { calls++; used.push(secret); return 'fixture-token'; },
        login: async () => { if (loginFails) throw Error('test credential save failure'); loggedIn++; },
    });
    return { controller, used, counts: () => ({ generated, calls, loggedIn }), setStoreFails: (value: boolean) => { storeFails = value; }, setLoginFails: (value: boolean) => { loginFails = value; } };
}

describe('CodeLight anonymous identity', () => {
    it('coalesces repeated clicks and never authenticates before the pending seed is saved', async () => {
        const f = fixture(); await Promise.all([f.controller.create('https://fixture'), f.controller.create('https://fixture')]);
        expect(f.counts()).toEqual({ generated: 1, calls: 1, loggedIn: 1 });
    });
    it('failed secure storage has no network or login effect', async () => {
        const f = fixture(); f.setStoreFails(true); await expect(f.controller.create('https://fixture')).rejects.toMatchObject({ code: 'storage' });
        expect(f.counts()).toEqual({ generated: 1, calls: 0, loggedIn: 0 });
    });
    it('retry after credential save failure preserves the original seed', async () => {
        const f = fixture(); f.setLoginFails(true); await expect(f.controller.create('https://fixture')).rejects.toMatchObject({ code: 'login' });
        f.setLoginFails(false); await f.controller.create('https://fixture');
        expect(f.used).toEqual(['fixture-seed-1', 'fixture-seed-1']); expect(f.counts().generated).toBe(1);
    });
});

it('initialization failure does not set a successful latch or falsely ignore a retry', async () => {
    const gate = new InitializationGate(); let attempts = 0, cleanups = 0;
    await expect(gate.run('fixture-account', async () => { attempts++; throw Error('partial init'); }, () => { cleanups++; })).rejects.toThrow();
    await gate.run('fixture-account', async () => { attempts++; }, () => { cleanups++; });
    expect({ attempts, cleanups }).toEqual({ attempts: 2, cleanups: 1 });
    await expect(gate.run('different-server-account', async () => {}, () => {})).rejects.toThrow('reload');
});

it('server origins normalize matching addresses and reject credential/path-bearing destinations', () => {
    expect(normalizeServerOrigin(' https://EXAMPLE.com:443/ ')).toBe('https://example.com');
    for (const url of ['https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'https://example.com/#key', 'file:///tmp']) expect(() => normalizeServerOrigin(url)).toThrow();
});
