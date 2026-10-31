import { describe, it, expect } from 'vitest';
import { normalizeServerOrigin, serverEndpoint, socketServerEndpoint, isSameServerEndpoint } from './serverOrigin';
import { parseCodeLightPairingCode } from '../auth/codeLightPairing';
import { fetchCodeLightSessionPages } from '../sync/codeLightSessionPages';

const base = 'https://relay.example/r/' + 'a'.repeat(24);
describe('transparent network relay base', () => {
    it('keeps prefixed REST and updates paths without turning the path into a Socket.IO namespace', () => {
        expect(normalizeServerOrigin(base + '/')).toBe(base);
        expect(serverEndpoint(base, '/v1/sessions').toString()).toBe(base + '/v1/sessions');
        expect(socketServerEndpoint(base)).toEqual({ origin: 'https://relay.example', path: '/r/' + 'a'.repeat(24) + '/v1/updates' });
        expect(socketServerEndpoint('https://direct.example')).toEqual({ origin: 'https://direct.example', path: '/v1/updates' });
    });
    it('does not attach credentials to another Mac prefix, lookalike hostname or blob origin', () => {
        expect(isSameServerEndpoint(base + '/files/example', base)).toBe(true);
        expect(isSameServerEndpoint('https://relay.example/r/' + 'b'.repeat(24) + '/files/example', base)).toBe(false);
        expect(isSameServerEndpoint(base + 'evil/files/example', base)).toBe(false);
        expect(isSameServerEndpoint('https://relay.example.evil/files/example', 'https://relay.example')).toBe(false);
        expect(isSameServerEndpoint('blob:https://relay.example/opaque', 'https://relay.example')).toBe(false);
    });
    it('uses the unchanged QR exchange while retaining the validated base path', () => {
        const url = new URL('codelight://pair');
        for (const [key, value] of Object.entries({ v: '1', origin: base, invite: 'a'.repeat(43), key: 'b'.repeat(43), expires: '2000' })) url.searchParams.set(key, value);
        expect(parseCodeLightPairingCode(url.toString(), 1000).origin).toBe(base);
        expect(() => normalizeServerOrigin('https://relay.example/r/../../private')).toThrow();
    });
    it('catalog paging never drops the relay prefix', async () => {
        const urls: string[] = [];
        const request = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response(JSON.stringify({ sessions: [], hasNext: false, nextCursor: null })); }) as typeof fetch;
        await fetchCodeLightSessionPages(base, {}, request);
        expect(urls[0]).toBe(base + '/v2/sessions?limit=200');
    });
});
