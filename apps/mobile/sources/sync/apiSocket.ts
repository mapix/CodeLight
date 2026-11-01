import { socketServerEndpoint } from '@/utils/serverOrigin';
import { io, Socket } from 'socket.io-client';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { TokenStorage } from '@/auth/tokenStorage';
import { Encryption } from './encryption/encryption';
import { storage } from './storage';
import { config } from '@/config';
import type { PeerCredentials } from '@slopus/happy-wire/codelight';
import { peerAuthorization, decodePeerResponse } from './peerNetwork';
import { abortBudget } from './abortBudget';

export function getHappyClientId(): string {
    let platform: string = Platform.OS; // 'ios' | 'android' | 'web'
    if (platform === 'web' && typeof window !== 'undefined' && '__TAURI__' in window) {
        platform = 'desktop';
    }
    const version = Constants.expoConfig?.version || '0.0.0';
    return `${platform}/${version}`;
}

/**
 * Compute the current "active" or "background" state for the current platform.
 * Mobile uses AppState. Web/desktop uses document.visibilityState + window focus —
 * "active" means the tab is visible AND has focus, so a backgrounded tab or an
 * unfocused window correctly counts as background and won't suppress mobile pushes.
 */
export function getCurrentAppState(): 'active' | 'background' {
    if (Platform.OS === 'web') {
        if (typeof document === 'undefined') {
            return 'active';
        }
        const visible = document.visibilityState === 'visible';
        const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
        return visible && focused ? 'active' : 'background';
    }
    return AppState.currentState === 'active' ? 'active' : 'background';
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
    peer?: PeerCredentials;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

// Comfortably past the server's worst honest case: a 15s wait for a
// reconnecting daemon to rejoin the room, then a 30s call.
const RPC_ACK_TIMEOUT_MS = 50_000;

/**
 * Runs one step of an RPC and, if it throws, says which step that was.
 *
 * A TypeError raised inside a minified dependency reads like
 * "undefined is not an object (evaluating 'this.#i')" — true, and useless,
 * because nothing in it says where. The step's name and the throw site's top
 * frame are carried out with the message so the report places itself.
 */
async function labelRpcStep<T>(step: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (!(error instanceof Error)) throw new Error(`${step}: ${String(error)}`);
        const frame = error.stack?.split('\n')[1]?.trim();
        const labeled = new Error(frame ? `${step}: ${error.message} (at ${frame})` : `${step}: ${error.message}`);
        Object.assign(labeled, { rpcStep: step });
        if (step === 'encrypting the request' || (error as { effectMayHaveOccurred?: boolean }).effectMayHaveOccurred === false) Object.assign(labeled, { effectMayHaveOccurred: false });
        throw labeled;
    }
}

//
// Main Class
//

class ApiSocket {
    private intentionalDisconnect = false;
    private lastPeerConnectionError: { code: string; httpStatus?: number } | null = null;
    peerConnected() { return this.socket?.connected === true; }
    peerConnectionError() { return this.lastPeerConnectionError; }
    peerCanReconnect() { return !this.intentionalDisconnect; }
    peerIdentity() { return this.config?.peer?.id ? 'peer:' + this.config.peer.id : null; }
    async switchPeerChannel(endpoint: string, peer: PeerCredentials): Promise<void> {
        if (!this.config?.peer || this.config.peer.id !== peer.id || !peer.channels.some(channel => channel.url === endpoint)) throw Error('Invalid peer channel switch');
        const encryption = this.encryption, token = this.config.token;
        if (!encryption) throw Error('Peer encryption is unavailable');
        this.disconnect(); this.initialize({ endpoint, token, peer }, encryption);
        const connection = this.config;
        await new Promise<void>((resolve, reject) => {
            let release: (() => void) | undefined;
            const timer = setTimeout(() => { release?.(); reject(Error('The connection channel did not respond')); }, 10000);
            release = this.onStatusChange(status => {
                if (this.config !== connection) { clearTimeout(timer); release?.(); reject(Error('A newer channel selection replaced this one')); }
                else if (status === 'connected') { clearTimeout(timer); release?.(); resolve(); }
            });
        });
    }

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private peerReads = new Set<() => void>();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config || this.socket) {
            return;
        }
        this.intentionalDisconnect = false;
        this.lastPeerConnectionError = null;

        this.updateStatus('connecting');

        const endpoint = socketServerEndpoint(this.config.endpoint);
        // Engine.IO 默认补尾斜杠；密封签名必须覆盖真正的 upgrade 路径。
        const socketPath = endpoint.path.replace(/\/$/, '') + '/';
        const connection = this.config;
        const proofHeaders = () => connection.peer ? { Authorization: peerAuthorization(connection.token, connection.peer, connection.endpoint, 'GET', endpoint.origin + socketPath) } : { Authorization: `Bearer ${connection.token}` };
        this.socket = io(endpoint.origin, {
            path: socketPath,
            // Mac 网关按独立设备 token 准入升级请求，撤销设备后关闭该设备的连接而不影响其他手机。
            ...(config.noninvasiveLocal ? { extraHeaders: proofHeaders() } : {}),
            // A callback, not an object literal: socket.io re-invokes it for
            // every connect AND reconnect, so appState is read fresh each time.
            // With a literal, a socket that first connected while foregrounded
            // would keep announcing `active` on later reconnects, and the server
            // would suppress pushes for a backgrounded user until the follow-up
            // `app-state` event landed.
            auth: (cb) => cb({
                ...(!connection.peer ? { token: connection.token } : {}),
                clientType: 'user-scoped' as const,
                happyClient: getHappyClientId(),
                appState: getCurrentAppState(),
            }),
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });
        // 每次 upgrade 使用新的设备证明；同一 nonce 不能在重连时重放。
        this.socket.io?.on('reconnect_attempt', () => {
            if (this.socket && this.config === connection) {
                this.socket.io.opts.extraHeaders = proofHeaders();
                // 重试必须离开旧 error；否则连续 connect_error 被状态去重吞掉，Mac 恢复后不会重新选路。
                this.updateStatus('connecting');
            }
        });

        this.setupEventHandlers();
    }

    disconnect() {
        for (const abort of this.peerReads) abort();
        this.peerReads.clear();
        this.intentionalDisconnect = true;
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.updateStatus('disconnected');
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * The server answers every rpc-call it hears, but an emit made while the
     * socket is down is buffered by socket.io and its ack never arrives, so a
     * bare emitWithAck waits for the rest of the app's life. The server's own
     * budget is a 15s grace window for a reconnecting daemon plus a 30s call,
     * so past that the call is not slow — it is gone, and the caller deserves
     * to hear so.
     */
    private async rpcCall(method: string, params: unknown, expectedSocket?: Socket): Promise<any> {
        // disconnect() nulls the socket, so this is a state a caller can really
        // reach. Read it once and say what happened, rather than letting a
        // property access on null surface as a TypeError.
        const socket = this.socket;
        if (expectedSocket && expectedSocket !== socket) throw Object.assign(new Error('RPC connection changed'), { effectMayHaveOccurred: false });
        if (!socket?.connected) {
            // Socket.IO 会缓存离线 emit；变更请求必须在这里拒绝，不能关闭表单后才补发。
            throw Object.assign(new Error('Not connected to the computer'), { effectMayHaveOccurred: false });
        }
        return await socket
            .timeout(RPC_ACK_TIMEOUT_MS)
            .emitWithAck('rpc-call', { method, params })
            .catch(() => {
                throw new Error('The computer did not respond');
            });
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A, expectedServerUrl?: string): Promise<R> {
        const config = this.config, socket = this.socket, encryption = this.encryption;
        if (expectedServerUrl !== undefined && config?.endpoint !== expectedServerUrl) throw Object.assign(new Error('RPC connection changed'), { effectMayHaveOccurred: false });
        const sessionEncryption = encryption!.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            throw Object.assign(new Error('The session connection is not ready'), { effectMayHaveOccurred: false });
        }

        // Four unrelated things happen here — encrypt, emit, wait, decrypt —
        // and a raw TypeError out of any of them arrives at the caller saying
        // only what it could not read, never which one was running. Naming the
        // step costs nothing on the way through and turns an unplaceable
        // message into an address.
        const encrypted = await labelRpcStep(
            'encrypting the request',
            () => sessionEncryption.encryptRaw(params),
        );
        // 加密是异步的；期间扫码切换连接后，旧请求不能随全局 socket 发到新账户/入口。
        if (config !== this.config || socket !== this.socket || encryption !== this.encryption) throw Object.assign(new Error('RPC connection changed'), { effectMayHaveOccurred: false });
        const result = await labelRpcStep(
            'sending the request',
            () => this.rpcCall(`${sessionId}:${method}`, encrypted, socket ?? undefined),
        );
        if (result.ok) {
            return await labelRpcStep(
                'reading the answer',
                () => sessionEncryption.decryptRaw(result.result),
            ) as R;
        }
        throw Object.assign(new Error(result.error || 'RPC call failed'), result.effectMayHaveOccurred === false ? { effectMayHaveOccurred: false } : {});
    }

    /**
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(machineId: string, method: string, params: A, expectedServerUrl?: string): Promise<R> {
        const config = this.config, socket = this.socket, encryption = this.encryption;
        if (expectedServerUrl !== undefined && config?.endpoint !== expectedServerUrl) throw Object.assign(new Error('RPC connection changed'), { effectMayHaveOccurred: false });
        const machineEncryption = encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw Object.assign(new Error('The machine connection is not ready'), { effectMayHaveOccurred: false });
        }

        const encrypted = await labelRpcStep('encrypting the request', () => machineEncryption.encryptRaw(params));
        if (config !== this.config || socket !== this.socket || encryption !== this.encryption) throw Object.assign(new Error('RPC connection changed'), { effectMayHaveOccurred: false });
        const result = await this.rpcCall(
            `${machineId}:${method}`,
            encrypted,
            socket ?? undefined,
        );

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }
        throw Object.assign(new Error(result.error || 'RPC call failed'), result.effectMayHaveOccurred === false ? { effectMayHaveOccurred: false } : {});
    }

    /**
     * Sends app focus state to server for push notification routing.
     * Server uses this to suppress pushes when the mobile app is in foreground.
     */
    sendAppState(state: string) {
        this.socket?.emit('app-state', { state });
    }

    send(event: string, data: any) {
        this.socket!.emit(event, data);
        return true;
    }

    async emitWithAck<T = any>(event: string, data: any): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        return await this.socket.emitWithAck(event, data);
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }

        const connection = this.config;
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        if (this.config !== connection) throw Error('The connection changed before this request');
        if (connection.peer && credentials.peer?.id !== connection.peer.id) throw Error('The authenticated peer changed before this request');
        const url = `${connection.endpoint}${path}`;
        const headers = {
            'X-Happy-Client': getHappyClientId(),
            ...options?.headers,
            Authorization: connection.peer ? peerAuthorization(credentials.token, connection.peer, connection.endpoint, options?.method ?? 'GET', url) : `Bearer ${credentials.token}`,
        };

        return fetch(url, {
            ...options,
            headers
        });
    }

    async peerRequest(path: string, options?: RequestInit): Promise<Response> {
        const connection = this.config, peer = connection?.peer;
        if (!peer) throw Error('Scan this Mac again to enable its connection channels');
        const deadline = abortBudget(options?.signal, path.endsWith('/recent') ? 30000 : 10000);
        this.peerReads.add(deadline.abort);
        try {
        const response = await this.request(path, { ...options, signal: deadline.signal });
        if (!response.ok) return response;
        const payload = decodePeerResponse(peer, await response.json());
        if (this.config !== connection) throw Error('The peer connection changed during this read');
        return new Response(JSON.stringify(payload), { status: response.status, headers: { 'Content-Type': 'application/json' } });
        } finally { deadline.dispose(); this.peerReads.delete(deadline.abort); }
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
    }

    //
    // Private Methods
    //

    private isVerboseLogging(): boolean {
        try {
            return storage.getState().localSettings.verboseLogging;
        } catch {
            return false;
        }
    }

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Connected, recovered: ' + this.socket?.recovered);
                console.log('🔌 SyncSocket: Socket ID:', this.socket?.id);
            }
            this.updateStatus('connected');
            if (!this.socket?.recovered) {
                this.reconnectedListeners.forEach(listener => listener());
            }
        });

        this.socket.on('disconnect', (reason) => {
            if (this.isVerboseLogging()) {
                console.log('🔌 SyncSocket: Disconnected', reason);
            }
            this.updateStatus('disconnected');
        });

        // Error events
        this.socket.on('connect_error', (error) => {
            // 真机诊断只保留类别与 HTTP 状态；原错误可能包含地址、header 或凭据，不能持久化。
            const code = error.message === 'Missing authentication token' ? 'missing-token'
                : error.message === 'Invalid authentication token' ? 'invalid-token' : 'transport-error';
            const httpStatus = Number((error as any).description?.status ?? (error as any).context?.status);
            this.lastPeerConnectionError = { code, ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}) };
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Connection error', error);
            }
            this.updateStatus('error');
        });

        this.socket.on('error', (error) => {
            if (this.isVerboseLogging()) {
                console.error('🔌 SyncSocket: Error', error);
            }
            this.updateStatus('error');
        });

        // Message handling
        this.socket.onAny((event, data) => {
            if (this.isVerboseLogging()) {
                console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            }
            const handler = this.messageHandlers.get(event);
            if (handler) {
                handler(data);
            }
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();
