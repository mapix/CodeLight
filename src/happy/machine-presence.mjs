import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';
import { encryptRecord, decryptRecord } from './session-transport.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {{serverUrl:string,token:string,machineId:string,accountSecret?:Uint8Array,metadata?:Value,metadataVersion?:number,requestTimeoutMs?:number,onRpc?:(method:string)=>void}} Options */

/** One machine connection owns discovery/control-plane RPC. It never registers model runner handlers. */
export class CodeLightMachineConnection extends EventEmitter {
  /** @type {Map<string,(params:unknown)=>Promise<unknown>|unknown>} */ handlers = new Map();
  /** @param {Options} options */
  constructor(options) {
    super(); this.options = options; this.closed = false;
    this.timeoutMs = options.requestTimeoutMs ?? 15000; this.metadataVersion = options.metadataVersion ?? 0;
    if (options.accountSecret && options.accountSecret.length !== 32) throw Error('The machine account key must be 32 bytes.');
    this.socket = io(options.serverUrl, { path: '/v1/updates', auth: { token: options.token, clientType: 'machine-scoped', machineId: options.machineId, happyClient: 'codelight/0.2.0' },
      transports: ['websocket'], autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
    this.socket.on('connect', () => {
      if (this.closed) return;
      for (const method of this.handlers.keys()) this.socket.emit('rpc-register', { method: `${options.machineId}:${method}` }); this.alive();
      this.emit('connected'); this.updateMetadata().catch(() => this.emit('diagnostic', { code: 'machine-metadata-pending' }));
    });
    this.socket.on('disconnect', () => this.emit('disconnected'));
    this.socket.on('connect_error', () => this.emit('diagnostic', { code: 'machine-connect-error' }));
    this.socket.on('rpc-request', (/** @type {Value} */ request, /** @type {(reply:string)=>void} */ callback) => {
      this.serve(request).then(callback).catch(() => {
        if (options.accountSecret) callback(encryptRecord({ ok: false, error: { code: 'machine-rpc-error', message: 'The machine RPC could not complete.' }, effectMayHaveOccurred: true }, options.accountSecret, 'legacy'));
      });
    });
    this.timer = setInterval(() => this.alive(), 15000); this.timer.unref(); this.socket.connect();
  }
  alive() { if (!this.closed && this.socket.connected) this.socket.volatile.emit('machine-alive', { machineId: this.options.machineId, time: Date.now() }); }
  /** @param {number} [timeoutMs] */
  waitForConnect(timeoutMs = this.timeoutMs) {
    if (this.socket.connected) return Promise.resolve();
    if (this.closed) return Promise.reject(Error('The machine connection is closed.'));
    return new Promise((resolveWait, reject) => {
      const cleanup = () => { clearTimeout(timer); this.removeListener('connected', connected); this.removeListener('closing', closing); };
      const connected = () => { cleanup(); resolveWait(undefined); };
      const closing = () => { cleanup(); reject(Error('The machine connection closed before connecting.')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('The machine connection did not become ready.')); }, timeoutMs);
      this.once('connected', connected); this.once('closing', closing);
    });
  }
  async updateMetadata() {
    if (!this.options.metadata || !this.options.accountSecret || !this.socket.connected) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = /** @type {Value} */ (await this.socket.timeout(this.timeoutMs).emitWithAck('machine-update-metadata', { machineId: this.options.machineId,
        expectedVersion: this.metadataVersion, metadata: encryptRecord(this.options.metadata, this.options.accountSecret, 'legacy') }));
      if (reply.result === 'success') { this.metadataVersion = reply.version; return; }
      if (reply.result !== 'version-mismatch' || !Number.isSafeInteger(reply.version)) throw Error('Machine metadata could not be updated.');
      this.metadataVersion = reply.version;
      const current = decryptRecord(reply.metadata, this.options.accountSecret, 'legacy');
      if (current && typeof current === 'object' && !Array.isArray(current)) this.options.metadata = { ...current, ...this.options.metadata };
    }
    throw Error('Machine metadata changed concurrently.');
  }
  /** @param {string} method @param {(params:unknown)=>Promise<unknown>|unknown} handler */
  registerRpc(method, handler) {
    if (this.closed || !this.options.accountSecret || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(method) || this.handlers.has(method)) throw Error('Register one explicit machine RPC with its account key.');
    this.handlers.set(method, handler); if (this.socket.connected) this.socket.emit('rpc-register', { method: `${this.options.machineId}:${method}` });
    return () => { if (this.handlers.get(method) !== handler) return; this.handlers.delete(method); this.socket.emit('rpc-unregister', { method: `${this.options.machineId}:${method}` }); };
  }
  /** @param {Value} request */
  async serve(request) {
    const key = this.options.accountSecret; if (!key) throw Error('This presence-only connection has no RPC key.');
    let invoked = false;
    try {
      if (this.closed) throw Error('The machine connection is closed.');
      const prefix = `${this.options.machineId}:`, method = typeof request.method === 'string' && request.method.startsWith(prefix) ? request.method.slice(prefix.length) : '';
      if (/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(method)) {
        try { this.options.onRpc?.(method); } catch { /* 数字统计回调不改变 RPC admission 或业务结果。 */ }
      }
      const handler = this.handlers.get(method); if (!handler || typeof request.params !== 'string') throw Error('The requested machine method is unavailable.');
      const params = decryptRecord(request.params, key, 'legacy'); if (params === null) throw Error('The machine request could not be decoded.');
      invoked = true; return encryptRecord(await handler(params), key, 'legacy');
    } catch (error) {
      const code = typeof /** @type {Value} */ (error)?.code === 'string' ? /** @type {Value} */ (error).code : 'machine-rpc-unavailable';
      return encryptRecord({ ok: false, error: { code, message: 'The requested CodeLight machine operation could not complete.' }, effectMayHaveOccurred: invoked }, key, 'legacy');
    }
  }
  close() {
    if (this.closed) return; this.closed = true; this.emit('closing'); clearInterval(this.timer);
    for (const method of this.handlers.keys()) this.socket.emit('rpc-unregister', { method: `${this.options.machineId}:${method}` });
    this.handlers.clear(); this.socket.removeAllListeners(); this.socket.disconnect(); this.removeAllListeners();
  }
}

/** Backward-compatible presence-only entry point. @param {Options} options */
export function machinePresence(options) { return new CodeLightMachineConnection(options); }
