import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createNetworkRelay, registrationMessage } from '../src/network/relay-server.mjs';
import { EntryProbes } from '../src/network/public-access.mjs';
import { PairingInvitations, createPairingGateway } from '../src/happy/pairing-gateway.mjs';
import nacl from 'tweetnacl';
import { RelayTunnelClient, normalizeRelayAddress, validateRelayAddress } from '../src/network/relay-client.mjs';
import { safePath, safeHeaders } from '../src/network/relay-protocol.mjs';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { DeviceProofVerifier } from '../src/network/device-proof.mjs';
import { DeviceRegistry } from '../src/happy/device-registry.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @param {import('node:http').Server} server */
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string'); return 'http://127.0.0.1:' + address.port; }
const token = 'a'.repeat(43);
test('sealed peer proof survives a prefixed relay and authenticates the realtime backend header', { timeout: 10000 }, async t => {
  const require = createRequire(new URL('../packages/relay/package.json', import.meta.url));
  const { Server } = require(['socket', 'io'].join('.'));
  const backend = createServer(), ioServer = new Server(backend, { path: '/v1/updates', transports: ['websocket'] });
  ioServer.use((/** @type {Record<string,any>} */ socket, /** @type {(error?:Error)=>void} */ next) => next(socket.handshake.headers.authorization === 'Bearer fixture-device' ? undefined : Error('Missing authentication token')));
  ioServer.on('connection', (/** @type {Record<string,any>} */ socket) => socket.on('read-diagnostic', (/** @type {(value:Record<string,any>)=>void} */ ack) => ack({ connected: true })));
  const upstream = await listen(backend), mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const publicKey = Buffer.from(phone.publicKey).toString('base64url'), device = createHash('sha256').update(publicKey).digest('hex').slice(0, 24);
  const directory = await mkdtemp(join(tmpdir(), 'codelight-relay-proof-')), devices = new DeviceRegistry(join(directory, 'devices.json'), []);
  assert.equal(await devices.approve(publicKey, 'Fixture', 'fixture-device'), device);
  let base = '';
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { token: 'fixture-device', secret: 'a'.repeat(43) } });
  const proof = new DeviceProofVerifier({ key: mac.secretKey, devices, origins: () => [base] });
  const gateway = createPairingGateway({ upstream, invitations, devices, proof, expectedOrigin: () => base });
  const gatewayUrl = await listen(gateway), relay = createNetworkRelay({ token }), origin = await listen(relay);
  const client = new RelayTunnelClient({ serverUrl: origin, token, seed: randomBytes(32), upstream: gatewayUrl });
  /** @type {import('socket.io-client').Socket|undefined} */ let socket;
  t.after(async () => { socket?.disconnect(); client.close(); relay.close(); gateway.closeAllConnections(); gateway.close(); ioServer.close(); invitations.close(); await devices.tail; await rm(directory, { recursive: true, force: true }); });
  base = await client.start(); client.activate();
  const nonce = randomBytes(24), payload = Buffer.from(JSON.stringify({ version: 2, token: 'fixture-device', origin: base, method: 'GET', path: '/v1/updates/', at: Date.now() }));
  const header = 'CodeLight ' + Buffer.from(JSON.stringify({ publicKey, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(nacl.box(payload, nonce, mac.publicKey, phone.secretKey)).toString('base64url') })).toString('base64url');
  socket = io(origin, { path: new URL(base).pathname + '/v1/updates/', extraHeaders: { Authorization: header }, auth: { clientType: 'user-scoped' }, transports: ['websocket'], reconnection: false });
  const connection = socket;
  await new Promise((resolve, reject) => { connection.once('connect', () => resolve(undefined)); connection.once('connect_error', reject); });
  assert.deepEqual(await socket.timeout(1000).emitWithAck('read-diagnostic'), { connected: true });
});
test('relay validates addresses and rejects proxy targets, header injection and unconfigured registration', async () => {
  assert.equal(normalizeRelayAddress('https://relay.example/'), 'https://relay.example');
  for (const url of ['http://relay.example', 'https://user:key@relay.example', 'https://relay.example?key=a', 'https://relay.example/path', 'https://relay.example/#token']) assert.throws(() => normalizeRelayAddress(url));
  for (const path of ['http://private.example/', '//private.example/', '/a\r\nb']) assert.throws(() => safePath(path));
  assert.throws(() => safeHeaders({ authorization: 'a\r\nb' }));
  assert.throws(() => createNetworkRelay({ token: '' }));
  const fake = createServer((_req, res) => res.end('<html>not a relay</html>')); const url = await listen(fake);
  try { await assert.rejects(() => validateRelayAddress(url)); } finally { fake.closeAllConnections(); fake.close(); }
});

test('authenticated outbound relay streams HTTP bytes and raw WebSocket upgrades without a business store', { timeout: 15000 }, async t => {
  const backend = createServer((req, res) => {
    if (req.method === 'POST') {
      const hash = createHash('sha256'); req.on('data', bytes => hash.update(bytes)); req.on('end', () => res.end(hash.digest('hex'))); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization }));
  });
  const echo = new WebSocketServer({ server: backend, path: '/v1/updates', perMessageDeflate: false }); echo.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  const upstream = await listen(backend), relay = createNetworkRelay({ token }), origin = await listen(relay);
  const client = new RelayTunnelClient({ serverUrl: origin, token, seed: randomBytes(32), upstream });
  t.after(() => { client.close(); for (const socket of echo.clients) socket.terminate(); echo.close(); relay.close(); backend.closeAllConnections(); backend.close(); });
  const base = await client.start(); client.activate();
  const headers = { Authorization: 'Bearer fixture-device' };
  const response = await fetch(base + '/echo?q=hello', { headers }); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/echo?q=hello', authorization: 'Bearer fixture-device' });
  const body = Buffer.alloc(2 * 1024 * 1024, 137);
  const upload = await fetch(base + '/opaque', { method: 'POST', body });
  assert.equal(await upload.text(), createHash('sha256').update(body).digest('hex'));
  const address = base.replace(/^http/u, 'ws') + '/v1/updates?transport=websocket';
  const socket = new WebSocket(address, { headers }); socket.on('error', () => {}); await once(socket, 'open');
  const received = once(socket, 'message'); socket.send(Buffer.from([0, 1, 255, 17]));
  assert.deepEqual((await received)[0], Buffer.from([0, 1, 255, 17])); socket.close();
  assert.equal((await fetch(origin + '/r/' + 'f'.repeat(24) + '/health')).status, 503);
});

test('wrong relay registration token cannot attach a route or replace an authenticated Mac', { timeout: 10000 }, async t => {
  const backend = createServer((_req, res) => res.end('original-mac')); const upstream = await listen(backend);
  const relay = createNetworkRelay({ token }), origin = await listen(relay), seed = randomBytes(32);
  const client = new RelayTunnelClient({ serverUrl: origin, token, seed, upstream });
  const wrong = new RelayTunnelClient({ serverUrl: origin, token: 'b'.repeat(43), seed, upstream });
  t.after(() => { wrong.close(); client.close(); relay.close(); backend.closeAllConnections(); backend.close(); });
  const base = await client.start();
  await assert.rejects(() => wrong.start()); wrong.close();
  assert.equal(await (await fetch(base + '/health')).text(), 'original-mac');
});

test('authenticated handover fences the old close and retains the same public route', { timeout: 10000 }, async t => {
  const backend = createServer((_req, res) => res.end('same-mac')), upstream = await listen(backend);
  const relay = createNetworkRelay({ token }), origin = await listen(relay), seed = randomBytes(32);
  const first = new RelayTunnelClient({ serverUrl: origin, token, seed, upstream });
  const next = new RelayTunnelClient({ serverUrl: origin, token, seed, upstream });
  t.after(() => { first.close(); next.close(); relay.close(); backend.closeAllConnections(); backend.close(); });
  const base = await first.start(); first.activate(); first.pauseReconnect(true);
  assert.equal(await next.start(), base);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await (await fetch(base + '/health')).text(), 'same-mac');
});

test('relay validation proves both owned gateway channels and keeps QR credentials encrypted to the phone', { timeout: 15000 }, async t => {
  const backend = createServer((_req, res) => res.end('backend')), upstream = await listen(backend);
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair(), probes = new EntryProbes();
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { token: 'synthetic-device', secret: 'a'.repeat(43) } });
  const gateway = createPairingGateway({ upstream, invitations, entryProbe: challenge => probes.response(challenge) }), gatewayUrl = await listen(gateway);
  const relay = createNetworkRelay({ token }), origin = await listen(relay);
  const client = new RelayTunnelClient({ serverUrl: origin, token, seed: randomBytes(32), upstream: gatewayUrl });
  t.after(() => { client.close(); relay.close(); gateway.closeAllConnections(); gateway.close(); backend.closeAllConnections(); backend.close(); invitations.close(); });
  const base = await client.start(); await probes.verify(base);
  const grant = invitations.issue(base), url = new URL(grant.url), nonce = randomBytes(24);
  const packet = { version: 1, origin: base, invite: url.searchParams.get('invite') };
  const encrypted = { publicKey: Buffer.from(phone.publicKey).toString('base64url'), nonce: nonce.toString('base64url'), ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(packet)), nonce, mac.publicKey, phone.secretKey)).toString('base64url') };
  const response = await fetch(base + '/codelight/pairing/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(encrypted) });
  assert.equal(response.status, 200); const reply = await response.json();
  const plain = nacl.box.open(Buffer.from(reply.ciphertext, 'base64url'), Buffer.from(reply.nonce, 'base64url'), mac.publicKey, phone.secretKey);
  assert.ok(plain); assert.equal(JSON.parse(Buffer.from(plain).toString()).credentials.serverUrl, base);
  assert.equal(probes.probes.size, 0);
});

test('fresh registration challenge rejects a signature copied from another tunnel', { timeout: 10000 }, async t => {
  const relay = createNetworkRelay({ token }), origin = await listen(relay), keys = nacl.sign.keyPair();
  t.after(() => relay.close());
  const open = () => { const ws = new WebSocket(origin.replace(/^http/u, 'ws') + '/relay/v1/tunnel', { headers: { Authorization: 'Bearer ' + token } }); ws.on('error', () => {}); return ws; };
  const first = open(), firstMessage = await once(first, 'message'), challenge = JSON.parse(firstMessage[0].toString()).challenge; first.close();
  const second = open(), nextMessage = await once(second, 'message'), nextChallenge = JSON.parse(nextMessage[0].toString()).challenge;
  const closed = once(second, 'close');
  second.send(JSON.stringify({ type: 'register', challenge: nextChallenge, publicKey: Buffer.from(keys.publicKey).toString('base64url'), signature: Buffer.from(nacl.sign.detached(registrationMessage(challenge), keys.secretKey)).toString('base64url') }));
  assert.equal((await closed)[0], 1008);
});
