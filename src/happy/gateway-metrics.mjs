import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { writeDurablePrivateJson } from './discovery-persistence.mjs';

/** @typedef {{version:1,totalReceivedBytes:number,totalSentBytes:number}} Totals */
/** @typedef {{read:(path:string)=>Promise<unknown>,write:(path:string,value:Totals)=>Promise<void>}} Storage */
/** @typedef {{path?:string,clock?:()=>number,storage?:Storage,flushIntervalMs?:number,writeThresholdBytes?:number,initialTotals?:Totals,cumulativeKnown?:boolean}} Options */
/** @typedef {{received:number,sent:number,onClose:()=>void}} SocketSample */
const FILE_STORAGE = {
  /** @param {string} path */ async read(path) { return JSON.parse(await readFile(path, 'utf8')); },
  /** @param {string} path @param {Totals} value */ write: (path, value) => writeDurablePrivateJson(path, value),
};
/** @param {unknown} value @returns {value is number} */
function counter(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** @param {number} a @param {number} b */
function add(a, b) { return Math.min(Number.MAX_SAFE_INTEGER, a + b); }
/** @param {unknown} value @returns {Totals} */
function totals(value) {
  const saved = /** @type {Partial<Totals>|null} */ (value);
  if (!saved || saved.version !== 1 || !counter(saved.totalReceivedBytes) || !counter(saved.totalSentBytes)) throw Error('Invalid gateway metric counters.');
  return { version: 1, totalReceivedBytes: saved.totalReceivedBytes, totalSentBytes: saved.totalSentBytes };
}

/** Only owned gateway interface byte counters; no payload listeners, tokens or native state. */
export class GatewayMetrics {
  /** @param {Options} [options] */
  constructor(options = {}) {
    this.clock = options.clock ?? (() => performance.now()); this.path = options.path ?? null;
    this.cumulativeKnown = options.cumulativeKnown !== false;
    if (!this.cumulativeKnown && this.path) throw Error('Unknown cumulative counters must not overwrite persisted history.');
    this.storage = options.storage ?? FILE_STORAGE;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000; this.writeThresholdBytes = options.writeThresholdBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.flushIntervalMs) || this.flushIntervalMs < 1000 || !Number.isSafeInteger(this.writeThresholdBytes) || this.writeThresholdBytes < 1) throw Error('Invalid gateway metric write budget.');
    this.base = options.initialTotals ? totals(options.initialTotals) : /** @type {Totals} */ ({ version: 1, totalReceivedBytes: 0, totalSentBytes: 0 });
    this.persisted = { ...this.base };
    this.receivedBytes = 0; this.sentBytes = 0; this.httpRequests = 0; this.rpcRequests = 0;
    this.startedAt = this.time(); this.rateAt = this.startedAt; this.rateReceived = 0; this.rateSent = 0;
    this.receiveRate = 0; this.sendRate = 0;
    this.sockets = /** @type {Map<import('node:net').Socket,SocketSample>} */ (new Map());
    this.seen = new WeakSet(); this.closed = false; this.closedAt = /** @type {number|null} */ (null);
    this.flushing = /** @type {Promise<void>|null} */ (null); this.closing = /** @type {Promise<void>|null} */ (null); this.queued = false;
    this.timer = this.path ? setInterval(() => { void this.flush().catch(() => {}); }, this.flushIntervalMs) : null;
    this.timer?.unref();
  }
  /** Resume cumulative bytes only; session counters and monotonic uptime start anew.
   * @param {string} path @param {Omit<Options,'path'|'initialTotals'>} [options] */
  static async load(path, options = {}) {
    if (typeof path !== 'string' || !path.trim()) throw Error('A gateway metrics counter path is required.');
    const storage = options.storage ?? FILE_STORAGE;
    let saved = null;
    try { saved = await storage.read(path); } catch (error) {
      if (error instanceof SyntaxError) throw Error('Invalid gateway metric counters.');
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    return new GatewayMetrics({ ...options, storage, path, ...(saved == null ? {} : { initialTotals: totals(saved) }) });
  }
  /** No data listener is attached: reading counters must not change stream flow.
   * @param {import('node:net').Socket} socket */
  trackSocket(socket) {
    if (this.closed || this.seen.has(socket)) return;
    this.seen.add(socket);
    const sample = { received: 0, sent: 0, onClose: () => {
      this.sampleSocket(socket, sample); this.sockets.delete(socket); this.maybeFlush();
    } };
    this.sampleSocket(socket, sample);
    if (!socket.destroyed) { this.sockets.set(socket, sample); socket.once('close', sample.onClose); }
    this.maybeFlush();
  }
  /** @param {import('node:net').Socket} socket @param {SocketSample} sample */
  sampleSocket(socket, sample) {
    const received = socket.bytesRead, sent = socket.bytesWritten;
    if (counter(received) && received >= sample.received) { this.receivedBytes = add(this.receivedBytes, received - sample.received); sample.received = received; }
    if (counter(sent) && sent >= sample.sent) { this.sentBytes = add(this.sentBytes, sent - sample.sent); sample.sent = sent; }
  }
  sample() { if (!this.closed) for (const [socket, sample] of this.sockets) this.sampleSocket(socket, sample); }
  request() { if (!this.closed) this.httpRequests = add(this.httpRequests, 1); }
  rpc() { if (!this.closed) this.rpcRequests = add(this.rpcRequests, 1); }
  time() { const now = this.clock(); if (typeof now !== 'number' || !Number.isFinite(now)) throw Error('A finite monotonic metric clock is required.'); return now; }
  durable() { return /** @type {Totals} */ ({ version: 1, totalReceivedBytes: add(this.base.totalReceivedBytes, this.receivedBytes), totalSentBytes: add(this.base.totalSentBytes, this.sentBytes) }); }
  dirty() { const value = this.durable(); return value.totalReceivedBytes !== this.persisted.totalReceivedBytes || value.totalSentBytes !== this.persisted.totalSentBytes; }
  maybeFlush() {
    if (!this.path || this.closed || this.queued) return;
    const value = this.durable();
    if (value.totalReceivedBytes - this.persisted.totalReceivedBytes + value.totalSentBytes - this.persisted.totalSentBytes < this.writeThresholdBytes) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.closed) void this.flush().catch(() => {}); });
  }
  /** Numeric sampling is independent of durable IO and conversation synchronization.
   * @param {{connectedDevices?:number}} [options] */
  snapshot(options = {}) {
    this.sample();
    const now = this.closedAt ?? this.time(), elapsed = now - this.rateAt;
    if (elapsed >= 1000) {
      this.receiveRate = (this.receivedBytes - this.rateReceived) * 1000 / elapsed;
      this.sendRate = (this.sentBytes - this.rateSent) * 1000 / elapsed;
      this.rateAt = now; this.rateReceived = this.receivedBytes; this.rateSent = this.sentBytes;
    }
    this.maybeFlush();
    const cumulative = this.durable();
    return { version: 1, receivedBytes: this.receivedBytes, sentBytes: this.sentBytes,
      totalReceivedBytes: this.cumulativeKnown ? cumulative.totalReceivedBytes : null, totalSentBytes: this.cumulativeKnown ? cumulative.totalSentBytes : null,
      receiveBytesPerSecond: this.receiveRate, sendBytesPerSecond: this.sendRate,
      httpRequests: this.httpRequests, rpcRequests: this.rpcRequests,
      connectedDevices: counter(options.connectedDevices) ? options.connectedDevices : 0, uptimeMs: Math.max(0, Math.floor(now - this.startedAt)) };
  }
  flush() {
    this.sample();
    if (this.flushing) return this.flushing;
    if (!this.path || !this.dirty()) return Promise.resolve();
    const value = this.durable(), path = this.path;
    const operation = Promise.resolve().then(() => this.storage.write(path, value)).then(() => { this.persisted = value; })
      .finally(() => { if (this.flushing === operation) this.flushing = null; });
    this.flushing = operation; return operation;
  }
  close() {
    if (this.closing) return this.closing;
    this.sample(); this.closed = true; this.closedAt = this.time();
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const [socket, sample] of this.sockets) socket.removeListener('close', sample.onClose);
    this.sockets.clear();
    const operation = (async () => {
      await this.flushing?.catch(() => {});
      // 关闭期间已捕获的 bytes 可能比在途写入新；最终累计值必须在 shutdown 前落盘。
      if (this.dirty()) await this.flush();
    })();
    this.closing = operation; return operation;
  }
}
