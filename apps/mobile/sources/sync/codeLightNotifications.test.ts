import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ peer: 'peer:original-peer', request: vi.fn(), url: 'http://192.0.2.10:9000', appState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock('expo-notifications', () => ({ getDevicePushTokenAsync: vi.fn() }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: mocks.appState }));
vi.mock('@/config', () => ({ config: { codeLightPushEnvironment: null } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mocks.url }));
vi.mock('./apiSocket', () => ({ apiSocket: { peerIdentity: () => mocks.peer, request: mocks.request } }));
import { startCodeLightPresence } from './codeLightNotifications';
let stop: (() => void) | undefined;
const credentials = { token: 'fixture-token', secret: 'fixture-secret', serverUrl: 'http://192.0.2.10:8000', peer: { id: 'original-peer' } } as any;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); mocks.request.mockReset(); mocks.peer = 'peer:original-peer'; mocks.appState.currentState = 'active'; });

it('foreground session heartbeats use the current authenticated peer route after a same-Mac endpoint change without APNs', async () => {
    vi.useFakeTimers(); mocks.request.mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    let session: string | null = null, changed!: () => void;
    stop = startCodeLightPresence(credentials, () => session, callback => { changed = callback; return () => {}; });
    await Promise.resolve(); session = 'actual-visible-session'; changed(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.request).toHaveBeenCalledWith('/codelight/notifications/presence', expect.objectContaining({ method: 'POST', body: JSON.stringify({ active: true, sessionId: session }) }));
    expect(mocks.request.mock.calls.filter(call => JSON.parse(call[1].body).sessionId === session).length).toBeGreaterThanOrEqual(4);
});

it('an old presence owner does not post to a newly selected different Mac', async () => {
    vi.useFakeTimers(); mocks.peer = 'peer:different-peer';
    stop = startCodeLightPresence(credentials, () => 'old-session', () => () => {});
    await vi.advanceTimersByTimeAsync(30000); expect(mocks.request).not.toHaveBeenCalled();
});
