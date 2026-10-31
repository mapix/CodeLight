import { afterEach, describe, expect, it, vi } from 'vitest';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { get, post } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.example' }));
vi.mock('@/sync/apiSocket', () => ({ getHappyClientId: () => 'fixture' }));
import { authApprove } from './authApprove';
afterEach(() => { get.mockReset(); post.mockReset(); });

describe('CodeLight pairing request state', () => {
    it('does not report an absent or wrong-server link as success', async () => {
        get.mockResolvedValue({ data: { status: 'not_found', supportsV2: false } });
        await expect(authApprove('test-token', new Uint8Array(32), new Uint8Array(2), new Uint8Array(3))).rejects.toThrow('same server');
        expect(post).not.toHaveBeenCalled();
    });
    it('keeps an already authorized request idempotent', async () => {
        get.mockResolvedValue({ data: { status: 'authorized', supportsV2: false } });
        await authApprove('test-token', new Uint8Array(32), new Uint8Array(2), new Uint8Array(3));
        expect(post).not.toHaveBeenCalled();
    });
    it('uses the server-declared v1 response for the existing Mac pairing protocol', async () => {
        get.mockResolvedValue({ data: { status: 'pending', supportsV2: false } }); post.mockResolvedValue({ data: {} });
        await authApprove('test-token', new Uint8Array(32), new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]));
        expect(post.mock.calls[0][1].response).toBe('AQI=');
    });
});
