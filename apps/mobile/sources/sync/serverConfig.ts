import { config } from '@/config';
import { MMKV } from 'react-native-mmkv';
import { normalizeServerOrigin } from '@/utils/serverOrigin';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';
const USE_CUSTOM_SERVER_FOR_VOICE_KEY = 'use-custom-server-for-voice';
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';
let runtimeServerUrl: string | undefined;

export function getServerUrl(): string {
    // CodeLight 的服务器切换必须重载自己的 JS runtime；旧网络任务不能在 await 后把旧 token 发到新地址。
    if (config.noninvasiveLocal && runtimeServerUrl) return runtimeServerUrl;
    // A selected private run must not silently reuse a previously persisted
    // server (including another loopback run). Production ignores this path.
    // CodeLight 正常启动允许用户配置自建服务；隔离测试凭据不能成为正式 App 的启动条件。
    if (__DEV__ && process.env.EXPO_PUBLIC_HARNESS_MODE === '1') {
        const configured = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        if (!configured) throw new Error('Harness startup requires its explicit server URL.');
        const parsed = new URL(configured);
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)
            || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
            throw new Error('Harness startup requires a plain loopback HTTP origin.');
        }
        runtimeServerUrl = parsed.origin; return parsed.origin;
    }
    const selected = serverConfigStorage.getString(SERVER_KEY) ||
           (globalThis as any).__HAPPY_CONFIG__?.serverUrl ||
           process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||
           (config.noninvasiveLocal ? 'http://127.0.0.1:57070' : DEFAULT_SERVER_URL);
    const origin = normalizeServerOrigin(selected);
    if (config.noninvasiveLocal) runtimeServerUrl = origin;
    return origin;
}

export function rewriteLoopbackHost(url: string): string {
    try {
        const target = new URL(url);
        if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname)) {
            return url;
        }
        const reachable = new URL(getServerUrl());
        target.protocol = reachable.protocol;
        target.host = reachable.host;
        if (reachable.pathname !== '/' && !target.pathname.startsWith(reachable.pathname + '/')) target.pathname = reachable.pathname + target.pathname;
        return target.toString();
    } catch {
        return url;
    }
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(SERVER_KEY, normalizeServerOrigin(url));
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

export function shouldUseCustomServerForVoice(): boolean {
    return isUsingCustomServer() && serverConfigStorage.getBoolean(USE_CUSTOM_SERVER_FOR_VOICE_KEY) === true;
}

export function setUseCustomServerForVoice(enabled: boolean): void {
    if (enabled) {
        serverConfigStorage.set(USE_CUSTOM_SERVER_FOR_VOICE_KEY, true);
    } else {
        serverConfigStorage.delete(USE_CUSTOM_SERVER_FOR_VOICE_KEY);
    }
}

export function getVoiceServerUrl(): string {
    return shouldUseCustomServerForVoice() ? getServerUrl() : DEFAULT_SERVER_URL;
}

export function getLogServerUrl(): string | null {
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    
    try {
        normalizeServerOrigin(url);
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
