import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { RelayTunnelClient, normalizeRelayAddress } from './relay-client.mjs';
import { readOptionalPrivateJson, writeDurablePrivateJson } from '../happy/discovery-persistence.mjs';

/** @typedef {Record<string,any>} Value */
export class EntryProbes {
  constructor() { this.probes = /** @type {Map<string,Value>} */ (new Map()); }
  create() {
    const challenge = randomBytes(32).toString('base64url'), response = randomBytes(32).toString('base64url');
    this.probes.set(challenge, { response, expires: Date.now() + 20000 });
    return { path: '/codelight/entry-probe?challenge=' + challenge, response, release: () => this.probes.delete(challenge) };
  }
  /** @param {unknown} challenge */
  response(challenge) { const value = typeof challenge === 'string' ? this.probes.get(challenge) : null; return value && value.expires > Date.now() ? value.response : null; }
  /** Two independent secrets prove HTTP and WebSocket forwarding, not a reflected URL nonce.
   * @param {string} origin @param {AbortSignal} [signal] */
  async verify(origin, signal) {
    const http = this.create();
    try {
      const response = await fetch(origin + http.path, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
      if (!response.ok || !response.body) throw Error('public-http-validation-failed');
      const reader = response.body.getReader(); let text = '', length = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 128) throw Error('public-http-validation-failed'); text += Buffer.from(chunk.value).toString('utf8'); } }
      finally { await reader.cancel().catch(() => {}); }
      if (text !== http.response) throw Error('public-http-validation-failed');
    }
    finally { http.release(); }
    const upgrade = this.create();
    try {
      await new Promise((resolve, reject) => {
        const url = new URL(origin + upgrade.path); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, { followRedirects: false, handshakeTimeout: 8000, maxPayload: 1024, perMessageDeflate: false });
        socket.on('error', () => {});
        const abort = () => { socket.terminate(); reject(Error('public-access-cancelled')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => { socket.terminate(); reject(Error('public-websocket-validation-failed')); }, 10000);
        socket.once('message', data => { clearTimeout(timer); socket.close(); if (data.toString() === upgrade.response) resolve(undefined); else reject(Error('public-websocket-validation-failed')); });
        socket.once('error', () => { clearTimeout(timer); socket.terminate(); reject(Error('public-websocket-validation-failed')); });
        socket.once('close', () => { signal?.removeEventListener('abort', abort); clearTimeout(timer); reject(Error('public-websocket-validation-failed')); });
      });
    } finally { upgrade.release(); }
  }
}

class CloudflareAccess extends EventEmitter {
  /** @param {{binary:string,upstream:string,state:string}} options */
  constructor(options) { super(); this.options = options; this.closed = false; this.child = /** @type {import('node:child_process').ChildProcess|null} */ (null); this.reject = /** @type {((error:Error)=>void)|null} */ (null); }
  async start() {
    const log = await open(join(this.options.state, 'tunnel.log'), 'a', 0o600);
    if (this.closed) { await log.close(); throw Error('public-access-cancelled'); }
    const child = spawn(this.options.binary, ['tunnel', '--no-autoupdate', '--url', this.options.upstream], { stdio: ['ignore', 'ignore', 'pipe'] }); this.child = child;
    return new Promise((resolve, reject) => {
      this.reject = reject; let buffer = '';
      const timer = setTimeout(() => reject(Error('cloudflare-start-timeout')), 60000);
      child.stderr?.on('data', chunk => {
        void log.write(chunk).catch(() => {}); buffer = (buffer + chunk.toString()).slice(-16384);
        const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u)?.[0]; if (url) { clearTimeout(timer); this.reject = null; resolve(url); }
      });
      child.once('error', () => { clearTimeout(timer); reject(Error('cloudflare-start-failed')); });
      child.once('exit', () => { clearTimeout(timer); void log.close(); reject(Error('cloudflare-exited')); if (!this.closed) this.emit('disconnected'); });
    });
  }
  activate() {}
  pauseReconnect() {}
  async close() {
    this.closed = true; this.reject?.(Error('public-access-cancelled')); this.reject = null;
    const child = this.child;
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

/** One owner commits only verified network configuration; original account/leases are unchanged. */
export class PublicAccessManager extends EventEmitter {
  /** @param {{state:string,upstream:string,cloudflared:string,probes:EntryProbes,transportFactory?:(config:Value,seed:Uint8Array)=>Value}} options */
  constructor(options) {
    super(); this.options = options; this.closed = false; this.tail = Promise.resolve(); this.sequence = 0;
    this.current = /** @type {Value|null} */ (null); this.candidate = /** @type {Value|null} */ (null);
    this.saved = /** @type {Value} */ ({ mode: 'cloudflare' }); this.seed = /** @type {Uint8Array|null} */ (null);
  }
  async load() {
    const identityPath = join(this.options.state, 'network-identity.json');
    let identity = await readOptionalPrivateJson(identityPath);
    if (!identity) { identity = { seed: randomBytes(32).toString('base64url') }; await writeDurablePrivateJson(identityPath, identity); }
    this.seed = new Uint8Array(Buffer.from(identity.seed, 'base64url')); if (this.seed.length !== 32) throw Error('invalid-network-identity');
    this.saved = await readOptionalPrivateJson(join(this.options.state, 'network-access.json')) ?? { mode: 'cloudflare' };
    this.emit('configuration', this.summary()); return this.apply(this.saved, false);
  }
  summary() { return { mode: this.saved.mode, serverUrl: this.saved.serverUrl ?? '', hasToken: !!this.saved.token }; }
  /** @param {Value} input @param {boolean} [persist] */
  apply(input, persist = true) {
    if (!['cloudflare', 'relay'].includes(input?.mode)) return Promise.reject(Error('invalid-public-access-mode'));
    let config;
    try {
      const serverUrl = input.mode === 'relay' ? normalizeRelayAddress(input.serverUrl) : '';
      config = input.mode === 'relay' ? { mode: 'relay', serverUrl,
        token: typeof input.token === 'string' ? input.token : serverUrl === this.saved.serverUrl ? this.saved.token ?? '' : '' } : { mode: 'cloudflare' };
    } catch { return Promise.reject(Error('invalid-relay-address')); }
    const sequence = ++this.sequence;
    // 尚未验证的候选可取消；已经进入持久化提交的候选按顺序完成，避免保存与 active entry 分裂。
    if (this.candidate && this.candidate.stage !== 'committing') { this.candidate.cancel.abort(); void this.candidate.transport.close(); }
    const operation = this.tail.catch(() => {}).then(() => this.perform(config, persist, sequence));
    this.tail = operation.then(() => undefined, () => undefined); return operation;
  }
  /** @param {Value} config @param {boolean} persist @param {number} sequence */
  async perform(config, persist, sequence) {
    if (this.closed || sequence !== this.sequence) throw Error('public-access-cancelled');
    const previous = this.current;
    if (previous && previous.config.mode === config.mode && previous.config.serverUrl === config.serverUrl && previous.config.token === config.token && previous.online) return previous.origin;
    previous?.transport.pauseReconnect(true);
    const transport = this.options.transportFactory?.(config, /** @type {Uint8Array} */ (this.seed)) ?? (config.mode === 'relay'
      ? new RelayTunnelClient({ serverUrl: config.serverUrl, token: config.token, seed: /** @type {Uint8Array} */ (this.seed), upstream: this.options.upstream })
      : new CloudflareAccess({ binary: this.options.cloudflared, upstream: this.options.upstream, state: this.options.state }));
    const candidate = { transport, stage: 'connecting', config, origin: '', online: false, cancel: new AbortController() }; this.candidate = candidate;
    this.emit('status', { state: 'validating', mode: config.mode });
    try {
      const origin = /** @type {string} */ (await transport.start());
      if (this.closed || sequence !== this.sequence) throw Error('public-access-cancelled');
      const deadline = Date.now() + 60000;
      for (;;) {
        try { await this.options.probes.verify(origin, candidate.cancel.signal); break; }
        catch (error) {
          // Quick Tunnel 的 DNS/边缘入口可能晚于进程 ready；只重试只读网络探针，不重放业务请求。
          if (config.mode !== 'cloudflare' || candidate.cancel.signal.aborted || Date.now() >= deadline) throw error;
          await delay(1000, undefined, { signal: candidate.cancel.signal });
        }
      }
      if (this.closed || sequence !== this.sequence) throw Error('public-access-cancelled');
      candidate.stage = 'committing';
      if (persist) await writeDurablePrivateJson(join(this.options.state, 'network-access.json'), { version: 1, ...config });
      this.saved = config; candidate.origin = origin; candidate.online = true; this.current = candidate;
      transport.on('disconnected', () => { if (this.current === candidate && !this.closed) { candidate.online = false; this.emit('status', { state: config.mode === 'relay' ? 'reconnecting' : 'unavailable', mode: config.mode }); } });
      transport.on('connected', () => { if (this.current === candidate && !this.closed) { candidate.online = true; this.emit('status', { state: 'connected', mode: config.mode }); this.emit('ready', { origin, mode: config.mode }); } });
      transport.activate(); previous?.transport.close();
      this.emit('configuration', this.summary()); this.emit('ready', { origin, mode: config.mode }); this.emit('status', { state: 'connected', mode: config.mode });
      return origin;
    } catch (error) {
      transport.close(); previous?.transport.pauseReconnect(false);
      if (sequence === this.sequence && !this.closed) this.emit('status', { state: previous?.online ? 'connected' : 'unavailable', mode: previous?.config.mode ?? config.mode });
      throw error;
    } finally { if (this.candidate === candidate) this.candidate = null; }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.sequence++;
    this.candidate?.cancel.abort();
    await Promise.allSettled([this.candidate?.transport.close(), this.current?.transport.close()]); this.seed?.fill(0);
    await this.tail.catch(() => {});
  }
}
