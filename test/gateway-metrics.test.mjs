import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import WebSocket, { WebSocketServer } from 'ws';
import { GatewayMetrics } from '../src/happy/gateway-metrics.mjs';
import { PairingInvitations, createPairingGateway } from '../src/happy/pairing-gateway.mjs';

/** @typedef {Record<string,any>} Value */
class CounterSocket extends EventEmitter {
  bytesRead = 0; bytesWritten = 0; destroyed = false;
  close() { this.destroyed = true; this.emit('close'); }
}
/** @param {CounterSocket} socket */
function nativeSocket(socket) { return /** @type {import('node:net').Socket} */ (/** @type {unknown} */ (socket)); }
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test('sampling reads exact socket deltas without payload listeners or duplicate close counting', async () => {
  let now = 0;
  const metrics = new GatewayMetrics({ clock: () => now }), a = new CounterSocket(), b = new CounterSocket();
  metrics.trackSocket(nativeSocket(a)); metrics.trackSocket(nativeSocket(a)); metrics.trackSocket(nativeSocket(b));
  assert.equal(a.listenerCount('data'), 0); assert.equal(a.listenerCount('close'), 1);
  a.bytesRead = 100; a.bytesWritten = 40; b.bytesRead = 25; b.bytesWritten = 10;
  now = 1000; metrics.request(); metrics.rpc();
  assert.deepEqual(metrics.snapshot({ connectedDevices: 2 }), { version: 1, receivedBytes: 125, sentBytes: 50, totalReceivedBytes: 125, totalSentBytes: 50,
    receiveBytesPerSecond: 125, sendBytesPerSecond: 50, httpRequests: 1, rpcRequests: 1, connectedDevices: 2, uptimeMs: 1000 });
  a.bytesRead = 150; a.bytesWritten = 60; b.bytesRead = 35; b.bytesWritten = 20;
  a.close(); b.close(); a.close(); metrics.trackSocket(nativeSocket(a));
  now = 2000;
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.receivedBytes, 185); assert.equal(snapshot.sentBytes, 80);
  assert.equal(snapshot.receiveBytesPerSecond, 60); assert.equal(snapshot.sendBytesPerSecond, 30);
  assert.equal(metrics.sockets.size, 0);
  await metrics.close(); now = 9000; a.bytesRead = 999; a.emit('close'); metrics.request(); metrics.rpc();
  assert.equal(metrics.snapshot().receivedBytes, 185); assert.equal(metrics.snapshot().uptimeMs, 2000);
  assert.ok(Object.values(metrics.snapshot()).every(value => typeof value === 'number' && Number.isFinite(value)));
});

test('durable counters resume independently of session bytes, requests, rate and monotonic uptime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-metrics-')), path = join(directory, 'totals.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 0;
  const first = await GatewayMetrics.load(path, { clock: () => now }), socket = new CounterSocket();
  first.trackSocket(nativeSocket(socket)); socket.bytesRead = 234; socket.bytesWritten = 456; first.request(); first.rpc();
  now = 1000; first.snapshot(); await first.close();
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(saved, { version: 1, totalReceivedBytes: 234, totalSentBytes: 456 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const second = await GatewayMetrics.load(path, { clock: () => now });
  t.after(() => second.close());
  assert.deepEqual(second.snapshot(), { version: 1, receivedBytes: 0, sentBytes: 0, totalReceivedBytes: 234, totalSentBytes: 456,
    receiveBytesPerSecond: 0, sendBytesPerSecond: 0, httpRequests: 0, rpcRequests: 0, connectedDevices: 0, uptimeMs: 0 });
  const next = new CounterSocket(); second.trackSocket(nativeSocket(next)); next.bytesRead = 16; next.bytesWritten = 32;
  now = 3000; assert.equal(second.snapshot().receiveBytesPerSecond, 8); await second.close();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, totalReceivedBytes: 250, totalSentBytes: 488 });
});

test('many samples and changes coalesce to periodic writes, then idle sampling writes nothing', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const writes = /** @type {Value[]} */ ([]);
  let now = 0;
  const metrics = await GatewayMetrics.load('/fixture/counters', { clock: () => now, storage: { async read() { return null; }, async write(_path, value) { writes.push({ ...value }); } } });
  t.after(() => metrics.close());
  const socket = new CounterSocket(); metrics.trackSocket(nativeSocket(socket));
  for (let i = 0; i < 1000; i++) { now += 10; socket.bytesRead += 2; socket.bytesWritten++; metrics.snapshot(); }
  await flush(); assert.equal(writes.length, 0);
  t.mock.timers.tick(4999); await flush(); assert.equal(writes.length, 0);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(writes, [{ version: 1, totalReceivedBytes: 2000, totalSentBytes: 1000 }]);
  t.mock.timers.tick(20000); await flush(); assert.equal(writes.length, 1);
  socket.bytesRead += 12; await metrics.close(); assert.equal(writes.length, 2);
});

test('threshold flush and concurrent shutdown serialize writes and preserve bytes sampled during an in-flight write', async () => {
  const writes = /** @type {Value[]} */ ([]);
  let release = /** @type {(()=>void)|null} */ (null), concurrent = 0, peak = 0;
  const metrics = await GatewayMetrics.load('/fixture/counters', { writeThresholdBytes: 10, storage: {
    async read() { return null; }, async write(_path, value) {
      concurrent++; peak = Math.max(peak, concurrent);
      if (!writes.length) await new Promise(resolve => { release = () => resolve(undefined); });
      writes.push({ ...value }); concurrent--;
    },
  } });
  const socket = new CounterSocket(); metrics.trackSocket(nativeSocket(socket));
  socket.bytesRead = 10; metrics.snapshot(); await flush(); assert.equal(concurrent, 1);
  socket.bytesRead = 35; socket.bytesWritten = 8; metrics.snapshot();
  const closing = metrics.close(); assert.equal(metrics.close(), closing);
  /** @type {(()=>void)|null} */ (release)?.(); await closing;
  assert.equal(peak, 1); assert.deepEqual(writes, [{ version: 1, totalReceivedBytes: 10, totalSentBytes: 0 }, { version: 1, totalReceivedBytes: 35, totalSentBytes: 8 }]);
});

test('invalid persistent totals fail without silently replacing cumulative history', async () => {
  await assert.rejects(() => GatewayMetrics.load('/fixture/counters', { storage: { async read() { return { version: 1, totalReceivedBytes: -1, totalSentBytes: 2 }; }, async write() { throw Error('Must not write'); } } }), /Invalid gateway metric counters/);
});

test('unavailable cumulative history stays unmeasured while current connection traffic is valid', async () => {
  const metrics = new GatewayMetrics({ cumulativeKnown: false });
  const socket = new CounterSocket(); metrics.trackSocket(nativeSocket(socket)); socket.bytesRead = 37; socket.bytesWritten = 23;
  const value = metrics.snapshot();
  assert.equal(value.receivedBytes, 37); assert.equal(value.sentBytes, 23);
  assert.equal(value.totalReceivedBytes, null); assert.equal(value.totalSentBytes, null);
  assert.throws(() => new GatewayMetrics({ cumulativeKnown: false, path: '/fixture/history' }), /must not overwrite/);
  await metrics.close();
});

test('shutdown retries the final cumulative write after an earlier in-flight persistence failure', async () => {
  let calls = 0, release = /** @type {(()=>void)|null} */ (null);
  const saved = /** @type {Value[]} */ ([]);
  const metrics = await GatewayMetrics.load('/fixture/counters', { writeThresholdBytes: 1, storage: {
    async read() { return null; }, async write(_path, value) {
      if (++calls === 1) { await new Promise(resolve => { release = () => resolve(undefined); }); throw Error('Transient persistence failure'); }
      saved.push({ ...value });
    },
  } });
  const socket = new CounterSocket(); metrics.trackSocket(nativeSocket(socket)); socket.bytesRead = 30; metrics.snapshot(); await flush();
  socket.bytesRead = 50; socket.bytesWritten = 12;
  const closed = metrics.close(); /** @type {(()=>void)|null} */ (release)?.(); await closed;
  assert.equal(calls, 2); assert.deepEqual(saved, [{ version: 1, totalReceivedBytes: 50, totalSentBytes: 12 }]);
});

test('real owned HTTP and upgraded WebSocket sockets count interface bytes once across concurrent clients', async t => {
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : 'fixture response');
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data))));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  const metrics = new GatewayMetrics(), invitations = new PairingInvitations({ key: nacl.randomBytes(32), credentials: {} });
  const gateway = createPairingGateway({ upstream: `http://127.0.0.1:${upstreamAddress.port}`, invitations, metrics });
  const owned = /** @type {import('node:net').Socket[]} */ ([]), clients = /** @type {import('node:net').Socket[]} */ ([]);
  gateway.on('connection', socket => owned.push(socket));
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const local = gateway.address(); assert.ok(local && typeof local !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${local.port}/v1/updates`);
  t.after(async () => {
    ws.terminate(); for (const socket of clients) socket.destroy(); gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve)); wss.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await metrics.close(); invitations.close();
  });
  /** @param {string} body */
  const http = async body => {
    const socket = createConnection({ host: '127.0.0.1', port: local.port }); clients.push(socket); socket.resume();
    await once(socket, 'connect');
    socket.write(`POST /echo HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await once(socket, 'close');
  };
  await Promise.all([http('PRIVATE_FIXTURE_BODY'.repeat(20)), http('another fixture body'), once(ws, 'open')]);
  const wsSocket = /** @type {import('node:net').Socket} */ (/** @type {Value} */ (ws)._socket); clients.push(wsSocket);
  for (const length of [2048, 65536]) {
    const reply = once(ws, 'message'); ws.send(Buffer.alloc(length, 3)); assert.equal((await reply)[0].length, length);
  }
  ws.close(); await once(ws, 'close'); await flush();
  const snapshot = metrics.snapshot({ connectedDevices: 1 });
  assert.equal(snapshot.httpRequests, 3); assert.equal(owned.length, 3);
  assert.equal(snapshot.receivedBytes, owned.reduce((sum, socket) => sum + socket.bytesRead, 0));
  assert.equal(snapshot.sentBytes, owned.reduce((sum, socket) => sum + socket.bytesWritten, 0));
  assert.equal(snapshot.receivedBytes, clients.reduce((sum, socket) => sum + socket.bytesWritten, 0));
  assert.equal(snapshot.sentBytes, clients.reduce((sum, socket) => sum + socket.bytesRead, 0));
  assert.ok(Object.values(snapshot).every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
  await metrics.close(); assert.equal(metrics.snapshot().receivedBytes, snapshot.receivedBytes);
});
