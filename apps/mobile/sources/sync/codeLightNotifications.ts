import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { AppState, Platform } from 'react-native';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { config } from '@/config';
import { getServerUrl } from './serverConfig';
import { apiSocket } from './apiSocket';
import { abortBudget } from './abortBudget';

async function postDevice(credentials: AuthCredentials, path: string, value: unknown) {
    const deadline = abortBudget(undefined, 5000);
    try {
    if (credentials.peer) {
        // 同一 Mac 的入口可改变，前台保活不能继续使用旧地址/Bearer，否则可见会话会被误回收。
        if (apiSocket.peerIdentity() !== 'peer:' + credentials.peer.id) throw Error('Device peer changed');
        const response = await apiSocket.request(path, { method: 'POST', signal: deadline.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        if (!response.ok) throw Error(`Device request failed: ${response.status}`);
        return response.json() as Promise<{ registered: boolean; available: boolean }>;
    }
    const origin = credentials.serverUrl ?? getServerUrl();
    if (origin !== getServerUrl()) throw Error('Notification origin changed');
        const response = await fetch(origin + path, { method: 'POST', signal: deadline.signal,
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        if (!response.ok) throw Error(`Notification registration failed: ${response.status}`);
        return response.json() as Promise<{ registered: boolean; available: boolean }>;
    } finally { deadline.dispose(); }
}
export async function syncCodeLightPushToken(credentials: AuthCredentials, granted: boolean) {
    if (!granted) { await postDevice(credentials, '/codelight/notifications/device', { enabled: false }); return null; }
    const environment = config.codeLightPushEnvironment;
    // 通知权限不等于 APNs entitlement；本地试装包未配置推送签名时不能借用上游 Expo 项目。
    if (Platform.OS !== 'ios' || !Device.isDevice || !environment) return null;
    const token = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof token !== 'string') throw Error('Native push token unavailable');
    const result = await postDevice(credentials, '/codelight/notifications/device', { enabled: true, token, environment });
    return result.registered && result.available ? token : null;
}
let presenceStop: (() => void) | null = null;
export function startCodeLightPresence(credentials: AuthCredentials, viewingSession: () => string | null, subscribe: (changed: () => void) => () => void) {
    presenceStop?.();
    let closed = false, lastSession = viewingSession();
    const send = () => { if (!closed) void postDevice(credentials, '/codelight/notifications/presence',
        { active: AppState.currentState === 'active', sessionId: viewingSession() }).catch(() => {}); };
    const appState = AppState.addEventListener('change', send);
    const release = subscribe(() => { const next = viewingSession(); if (next !== lastSession) { lastSession = next; send(); } });
    const timer = setInterval(() => { if (AppState.currentState === 'active') send(); }, 15000);
    presenceStop = () => { closed = true; clearInterval(timer); appState.remove(); release(); };
    send();
    return presenceStop;
}
