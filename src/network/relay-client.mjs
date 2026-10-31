import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';
import nacl from 'tweetnacl';
import { RelayChannel, FRAME_BYTES, safePath, safeHeaders } from './relay-protocol.mjs';
import { relayIdentity, registrationMessage } from './relay-server.mjs';

/** @typedef {Record<string,any>} Value */
export function normalizeRelayAddress(/** @type {string} */ input) {
  const value = new URL(input.trim());
  if (value.username || value.password || value.search || value.hash || value.pathname !== '/' ||
    value.protocol !== 'https:' && !(value.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname))) throw Error('invalid-relay-address');
  return value.origin;
}
export async function validateRelayAddress(/** @type {string} */ address, /** @type {AbortSignal|undefined} */ signal = undefined) {
  const origin = normalizeRelayAddress(address);
  const response = await fetch(origin + '/relay/v1/info', { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (!response.ok || !response.body) throw Error('relay-validation-failed');
  const reader = response.body.getReader(); let text = '', bytes = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) throw Error('invalid-relay-service'); text += Buffer.from(value).toString('utf8'); } }
  finally { await reader.cancel().catch(() => {}); }
  const info = JSON.parse(text);
  if (info.service !== 'codelight-network-relay' || info.version !== 1 || info.http !== true || info.websocket !== true || info.requiresToken !== true) throw Error('invalid-relay-service');
  return origin;
}

/** A persistent outbound connection forwards only the owned loopback gateway.
 * Reconnect never replays HTTP requests, application frames or commands. */
export class RelayTunnelClient extends EventEmitter {
  /** @param {{serverUrl:string,token:string,seed:Uint8Array,upstream:string}} options */
  constructor(options) {
    super(); this.options = options; this.origin = normalizeRelayAddress(options.serverUrl);
    const target = new URL(options.upstream);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw Error('Relay can forward only its owned loopback gateway.');
    if (options.seed.length !== 32) throw Error('invalid-network-identity');
    this.target = target; this.keys = nacl.sign.keyPair.fromSeed(options.seed); this.id = relayIdentity(this.keys.publicKey);
    this.publicUrl = this.origin + '/r/' + this.id;
    this.socket = /** @type {WebSocket|null} */ (null); this.channel = /** @type {RelayChannel|null} */ (null);
    this.closed = false; this.ready = false; this.active = false; this.paused = false; this.delay = 1000;
    this.cancel = new AbortController();
    this.timer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
    this.initialReject = /** @type {((error:Error)=>void)|null} */ (null);
  }
  async start() {
    await validateRelayAddress(this.origin, this.cancel.signal);
    if (this.closed) throw Error('relay-closed');
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(this.options.token ?? '')) throw Error('relay-access-key-required');
    return new Promise((resolve, reject) => {
      this.initialReject = reject;
      const connected = () => { this.removeListener('connected', connected); this.initialReject = null; resolve(this.publicUrl); };
      this.once('connected', connected); this.connect();
    });
  }
  activate() { this.active = true; }
  /** @param {boolean} value */
  pauseReconnect(value) { this.paused = value; if (value && this.timer) { clearTimeout(this.timer); this.timer = null; } else if (!value && !this.ready) this.schedule(); }
  connect() {
    if (this.closed) return;
    const url = new URL(this.origin + '/relay/v1/tunnel'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, { headers: { Authorization: 'Bearer ' + this.options.token }, followRedirects: false, handshakeTimeout: 8000, maxPayload: FRAME_BYTES + 17, perMessageDeflate: false });
    this.socket = socket; this.ready = false;
    const timeout = setTimeout(() => socket.close(1008, 'registration-timeout'), 10000); timeout.unref();
    const channel = new RelayChannel(socket, value => {
      if (!this.ready) {
        if (value.type === 'challenge' && value.version === 1 && /^[A-Za-z0-9_-]{43}$/u.test(value.challenge ?? '')) {
          channel.send({ type: 'register', challenge: value.challenge, publicKey: Buffer.from(this.keys.publicKey).toString('base64url'), signature: Buffer.from(nacl.sign.detached(registrationMessage(value.challenge), this.keys.secretKey)).toString('base64url') }); return;
        }
        if (value.type !== 'registered' || value.version !== 1 || value.id !== this.id || value.publicPath !== '/r/' + this.id) throw Error('invalid-relay-registration');
        clearTimeout(timeout); this.ready = true; this.delay = 1000; this.emit('connected', this.publicUrl); return;
      }
      this.forward(channel, value);
    });
    this.channel = channel;
    socket.on('error', () => { this.initialReject?.(Error('relay-connection-failed')); });
    socket.once('close', () => {
      clearTimeout(timeout); channel.close();
      if (this.socket !== socket) return;
      this.ready = false; this.initialReject?.(Error('relay-connection-failed')); this.initialReject = null;
      this.emit('disconnected'); this.schedule();
    });
  }
  schedule() {
    if (this.closed || !this.active || this.paused || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.delay); this.timer.unref(); this.delay = Math.min(this.delay * 2, 10000);
  }
  /** @param {RelayChannel} channel @param {Value} value */
  forward(channel, value) {
    if (!['http-open', 'upgrade-open'].includes(value.type) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(value.method)) throw Error('invalid-forward-request');
    const upgrade = value.type === 'upgrade-open', path = safePath(value.path), headers = safeHeaders(value.headers, upgrade);
    const stream = channel.add(value.id, { bodyLimit: upgrade ? null : 64 * 1024 * 1024 });
    const upstream = request({ hostname: '127.0.0.1', port: this.target.port, method: value.method, path, headers });
    stream.writable = upstream; stream.request = upstream;
    upstream.once('error', () => channel.drop(value.id));
    upstream.once('response', response => {
      channel.send({ type: upgrade ? 'upgrade-head' : 'http-head', id: value.id, status: response.statusCode, headers: safeHeaders(response.headers) });
      channel.pipe(stream, response);
    });
    upstream.once('upgrade', (response, socket, head) => {
      socket.pause(); stream.writable = socket; stream.bodyLimit = null;
      socket.once('close', () => channel.drop(value.id)); socket.on('error', () => channel.drop(value.id));
      channel.send({ type: 'upgrade-head', id: value.id, status: response.statusCode, headers: safeHeaders(response.headers, true) });
      channel.pipe(stream, socket, head);
    });
    if (upgrade) upstream.end();
  }
  close() {
    if (this.closed) return; this.closed = true; this.active = false;
    this.cancel.abort();
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    this.initialReject?.(Error('relay-closed')); this.initialReject = null;
    this.channel?.close(); this.socket?.terminate(); this.keys.secretKey.fill(0);
  }
}
