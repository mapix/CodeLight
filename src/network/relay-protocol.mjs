import { randomBytes } from 'node:crypto';

/** @typedef {Record<string,any>} Value */
export const FRAME_BYTES = 64 * 1024;
export const WINDOW_BYTES = 256 * 1024;
export const MAX_STREAMS = 64;
const BUFFER_BYTES = 2 * 1024 * 1024;
export const validStreamId = (/** @type {unknown} */ id) => typeof id === 'string' && /^[a-f0-9]{32}$/u.test(id);
export const streamId = () => randomBytes(16).toString('hex');
export function safePath(/** @type {unknown} */ value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || /[\x00-\x20\x7f\\#]/u.test(value)) throw Error('invalid-forward-path');
  return value;
}
/** Strip transport framing and forbid header injection; application bytes remain opaque.
 * @param {unknown} input @param {boolean} [upgrade] */
export function safeHeaders(input, upgrade = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid-forward-headers');
  const result = /** @type {Record<string,string|string[]>} */ ({}); let bytes = 0;
  const entries = Object.entries(input); if (entries.length > 128) throw Error('header-budget');
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_\x60|~0-9a-z-]+$/u.test(name)) throw Error('invalid-forward-header');
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 32 || values.some(v => typeof v !== 'string' || /[\r\n\x00]/u.test(v))) throw Error('invalid-forward-header');
    bytes += name.length + values.reduce((total, v) => total + v.length, 0); if (bytes > 32 * 1024) throw Error('header-budget');
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'proxy-connection', 'te', 'trailer', 'upgrade'].includes(name)) continue;
    result[name] = Array.isArray(value) ? values : values[0];
  }
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}

/** Network-only stream multiplexer. Credit is returned after the destination
 * drains, not when a frame merely arrives; bodies are never accumulated.
 */
export class RelayChannel {
  /** @param {import('ws').WebSocket} socket @param {(value:Value)=>void} control */
  constructor(socket, control) {
    this.socket = socket; this.control = control; this.closed = false;
    this.streams = /** @type {Map<string,Value>} */ (new Map());
    socket.on('message', (data, binary) => { try { this.receive(/** @type {Buffer} */ (data), binary); } catch { socket.close(1008, 'invalid-network-frame'); } });
    socket.once('close', () => this.close()); socket.on('error', () => {});
  }
  /** @param {Value} value */
  send(value) {
    if (this.closed || this.socket.readyState !== 1) return false;
    const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > 16384) throw Error('control-budget');
    this.socket.send(bytes, error => { if (error) this.close(); else this.wake(); }); return true;
  }
  /** @param {string} id @param {Value} options @returns {Value} */
  add(id, options) {
    if (!validStreamId(id) || this.streams.has(id) || this.streams.size >= MAX_STREAMS) throw Error('stream-budget');
    const stream = { ...options, id, credit: WINDOW_BYTES, uncredited: 0, pending: null, offset: 0, sending: false, sourceEnded: false, sentEnd: false, closed: false, sentBytes: 0 };
    this.streams.set(id, stream); return stream;
  }
  /** @param {Value} stream @param {Value} source @param {Buffer} [initial] */
  pipe(stream, source, initial = Buffer.alloc(0)) {
    source.pause(); stream.source = source;
    if (initial.length) { stream.pending = initial; stream.offset = 0; }
    source.on('data', (/** @type {Buffer} */ chunk) => {
      source.pause(); if (stream.closed) return;
      if (stream.pending || chunk.length > WINDOW_BYTES) { this.drop(stream.id); return; }
      stream.pending = chunk; stream.offset = 0; this.pump(stream);
    });
    source.once('end', () => { stream.sourceEnded = true; this.pump(stream); });
    source.once('error', () => this.drop(stream.id));
    if (source.readableEnded) stream.sourceEnded = true;
    this.pump(stream);
  }
  /** @param {Value} stream */
  pump(stream) {
    if (stream.closed || this.closed || stream.sending || this.socket.readyState !== 1 || this.socket.bufferedAmount > BUFFER_BYTES) return;
    if (stream.pending && stream.credit > 0) {
      const length = Math.min(FRAME_BYTES, stream.credit, stream.pending.length - stream.offset);
      const header = Buffer.allocUnsafe(17); header[0] = 1; Buffer.from(stream.id, 'hex').copy(header, 1);
      const frame = Buffer.concat([header, stream.pending.subarray(stream.offset, stream.offset + length)]);
      stream.credit -= length; stream.offset += length; stream.sentBytes += length;
      if (stream.bodyLimit && stream.sentBytes > stream.bodyLimit) { this.drop(stream.id); return; }
      if (stream.offset === stream.pending.length) { stream.pending = null; stream.offset = 0; }
      stream.sending = true;
      this.socket.send(frame, { binary: true }, error => { stream.sending = false; if (error) this.drop(stream.id); else { this.pump(stream); this.wake(); } });
      return;
    }
    if (!stream.pending && stream.sourceEnded && !stream.sentEnd) { stream.sentEnd = true; this.send({ type: 'end', id: stream.id }); }
    else if (!stream.pending && stream.credit > 0) stream.source?.resume();
  }
  wake() { for (const stream of this.streams.values()) this.pump(stream); }
  /** @param {Buffer} data @param {boolean} binary */
  receive(data, binary) {
    if (this.closed) return;
    if (binary) {
      if (data.length < 18 || data.length > FRAME_BYTES + 17 || data[0] !== 1) throw Error('data-budget');
      const stream = this.streams.get(data.subarray(1, 17).toString('hex')); if (!stream) return;
      const body = data.subarray(17); stream.uncredited += body.length;
      if (!stream.writable || stream.uncredited > WINDOW_BYTES) throw Error('credit-budget');
      stream.writable.write(body, (/** @type {Error|undefined} */ error) => {
        stream.uncredited -= body.length;
        if (error) this.drop(stream.id);
        else if (!stream.closed) this.send({ type: 'credit', id: stream.id, bytes: body.length });
      }); return;
    }
    if (data.length > 16384) throw Error('control-budget');
    const value = JSON.parse(data.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw Error('invalid-control');
    if (['credit', 'end', 'abort', 'complete'].includes(value.type)) {
      if (!validStreamId(value.id)) throw Error('invalid-stream');
      const stream = this.streams.get(value.id); if (!stream) return;
      if (value.type === 'credit') {
        if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0 || stream.credit + value.bytes > WINDOW_BYTES) throw Error('invalid-credit');
        stream.credit += value.bytes; this.pump(stream);
      } else if (value.type === 'end') stream.writable?.end();
      else this.drop(stream.id, false);
      return;
    }
    this.control(value);
  }
  /** @param {string} id @param {boolean} [notify] */
  drop(id, notify = true) {
    const stream = this.streams.get(id); if (!stream) return;
    stream.closed = true; this.streams.delete(id); clearTimeout(stream.timer);
    if (notify) this.send({ type: 'abort', id });
    stream.onAbort?.(); stream.source?.destroy(); stream.writable?.destroy(); stream.request?.destroy();
  }
  /** Completed output can retire without changing the underlying owner/runtime.
   * @param {string} id */
  done(id) { const stream = this.streams.get(id); if (stream) { stream.closed = true; clearTimeout(stream.timer); this.streams.delete(id); } }
  close() { if (this.closed) return; this.closed = true; for (const id of this.streams.keys()) this.drop(id, false); }
}
