import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { MacConnectionService, privateLANAddresses } from '../src/happy/mac-connection-service.mjs';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { PairingInvitations, createPairingGateway } from '../src/happy/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/happy/device-registry.mjs';

/** @typedef {Record<string,any>} Value */
const LAN = { en0: [{ address: '192.168.50.2', family: 'IPv4', internal: false }] };
/** @param {()=>boolean} predicate */
async function until(predicate) { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.ok(predicate()); }
class Tunnel extends EventEmitter { async start() { return 'https://fixture-public.example'; } activate() {} close() {} }
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'codelight-mac-connections-')), phone = nacl.box.keyPair(), mac = nacl.box.keyPair();
  const token = 'synthetic-device-token', account = { secret: randomBytes(32).toString('base64url') }, devices = new DeviceRegistry(join(state, 'devices.json'));
  const deviceId = await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'Fixture phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token, deviceId } });
  let backendHeaders = /** @type {Value|null} */ (null), reads = 0, starts = 0, preparations = 0;
  const backend = createServer((req, res) => { backendHeaders = req.headers; res.end('synthetic-backend'); }); backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); const address = backend.address(); assert.ok(address && typeof address !== 'string');
  const selected = { source: { app: 'codex', id: 'native-fixture', title: 'Fixture session', hostId: 'fixture-host', updatedAt: Date.now() },
    binding: { happySessionId: 'mirror-fixture', machineId: 'machine-fixture', sessionKey: Buffer.alloc(32, 8).toString('base64'), metadata: { nativeSession: { catalogueAvailable: true } } } };
  const uses = new Map(), actors = new Map();
  const actor = { status: () => ({ sourceStatus: 'connected' }), transport: { peerSnapshot: () => ({ metadata: selected.binding.metadata }) }, connector: { readRecent: async (/** @type {Value} */ options) => {
    assert.ok((uses.get('fixture-source') ?? 0) > 0, 'source must remain pinned throughout the native read'); reads++; return { rows: [{ id: 'latest', role: 'assistant', turnId: 'fixture-turn', text: 'synthetic-current' }], hasMore: false, nextCursor: null, fresh: options.fresh };
  } }, openDesktop: () => { throw Error('recent reads must not navigate desktop'); } };
  const daemon = { sources: new Map([['fixture-source', selected]]), actors, closed: false, ownsLease: true, inventoryAvailable: true,
    useSource: async (/** @type {string} */ key, /** @type {()=>Promise<Value>} */ operation) => { uses.set(key, (uses.get(key) ?? 0) + 1); try { return await operation(); } finally { uses.set(key, uses.get(key) - 1); } },
    prepareSource: async (/** @type {string} */ key) => { assert.equal(key, 'fixture-source'); preparations++; actors.set(key, actor); return actor; },
    startSource: async (/** @type {string} */ key, /** @type {Value} */ value) => { assert.equal(key, 'fixture-source'); assert.equal(value, actor); starts++; } };
  const gatewayOptions = /** @type {Value[]} */ ([]), requestedHosts = /** @type {string[]} */ ([]);
  const service = new MacConnectionService({ state, cloudflared: 'unused', upstream: 'http://127.0.0.1:' + address.port, account, devices, invitations, daemon: /** @type {import('../src/happy/mac-daemon.mjs').CodeLightMacDaemon} */ (/** @type {unknown} */ (daemon)),
    interfaces: () => LAN,
    gatewayFactory: options => { gatewayOptions.push(options); const server = createPairingGateway(options), listen = server.listen.bind(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ host) => { requestedHosts.push(host); return listen(port, '127.0.0.1'); }); return server; },
    managerFactory: options => new ConnectionChannelsManager({ ...options, transportFactory: () => new Tunnel(), probesFor: () => ({ verify: async () => {} }) }) });
  t.after(async () => { await service.close(); invitations.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); await rm(state, { recursive: true, force: true }); });
  await service.start(); await until(() => service.candidates().some(row => row.kind === 'local'));
  return { service, phone, mac, token, account, devices, deviceId, daemon, gatewayOptions, requestedHosts, counters: () => ({ reads, starts, preparations, backendHeaders }) };
}
/** @param {Value} f @param {Value} channel @param {string} path @param {string} [method] */
function header(f, channel, path, method = 'GET') {
  const nonce = randomBytes(24), payload = { version: 2, token: f.token, origin: channel.url, method, path, at: Date.now() };
  return 'CodeLight ' + Buffer.from(JSON.stringify({ publicKey: Buffer.from(f.phone.publicKey).toString('base64url'), nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(payload)), nonce, f.mac.publicKey, f.phone.secretKey)).toString('base64url') })).toString('base64url');
}
/** The fixture intercepts requested binds to keep every test listener on loopback.
 * @param {Value} channel @param {string} path */
function localRequestUrl(channel, path) { return 'http://127.0.0.1:' + new URL(channel.url).port + path; }
/** @param {Value} f @param {Value} value */
function unseal(f, value) { const plain = nacl.box.open(Buffer.from(value.ciphertext, 'base64url'), Buffer.from(value.nonce, 'base64url'), f.mac.publicKey, f.phone.secretKey); assert.ok(plain); return JSON.parse(Buffer.from(plain).toString()); }

test('LAN discovery selects at most three distinct actual private IPv4 addresses', () => {
  const interfaces = { test: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '8.8.8.8', family: 'IPv4', internal: false }, { address: '192.168.1.2', family: 'IPv4', internal: false },
    { address: '192.168.1.2', family: 'IPv4', internal: false }, { address: '10.0.0.2', family: 'IPv4', internal: false }, { address: '172.20.1.2', family: 'IPv4', internal: false }, { address: '10.0.0.3', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }] };
  const rows = privateLANAddresses(interfaces); assert.equal(rows.length, 3); assert.equal(new Set(rows).size, 3);
  assert.ok(rows.every(row => !['127.0.0.1', '8.8.8.8', 'fe80::1', '0.0.0.0'].includes(row)));
});

test('Mac composition shares one proof/account/daemon, uses distinct public gateways and does not rotate QR on repeated readiness confirmation', async t => {
  const f = await fixture(t);
  assert.equal(f.gatewayOptions.length, 3); assert.equal(new Set(f.gatewayOptions.map(row => row.proof)).size, 1);
  assert.ok(f.gatewayOptions.every(row => row.invitations === f.gatewayOptions[0].invitations && row.devices === f.devices));
  assert.deepEqual(f.requestedHosts, ['127.0.0.1', '127.0.0.1', '192.168.50.2']);
  const first = f.service.pairing(); assert.ok(first && new URL(first.pairingUrl).searchParams.get('v') === '2');
  const local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  assert.equal(f.service.manager.confirm('local', local.url), true); assert.equal(f.service.pairing(), null);
  const encodedChoices = new URL(first.pairingUrl).searchParams.get('channels'); assert.ok(encodedChoices); const choices = JSON.parse(Buffer.from(encodedChoices, 'base64url').toString()); assert.equal(choices.length, 2);
  await f.service.manager.setEnabled([]); const empty = f.service.pairing(); assert.equal(empty?.pairingUrl, ''); assert.equal(empty?.origin, '');
  assert.equal(f.daemon.closed, false); assert.deepEqual(f.counters(), { reads: 0, starts: 0, preparations: 0, backendHeaders: null });
});

test('LAN rejects a raw bearer and exposes peer channels only as a pinned sealed response', async t => {
  const f = await fixture(t), local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  const path = '/api/peer/channels', url = localRequestUrl(local, path);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + f.token } })).status, 401);
  const authorization = header(f, local, path), response = await fetch(url, { headers: { Authorization: authorization } }); assert.equal(response.status, 200);
  const value = await response.json(), text = JSON.stringify(value); assert.equal(text.includes(f.token), false); assert.equal(text.includes(local.url), false);
  const decoded = unseal(f, value); assert.equal(decoded.peerId, f.service.peerId()); assert.ok(decoded.payload.channels.some((/** @type {Value} */ row) => row.url === local.url));
  assert.equal((await fetch(url, { headers: { Authorization: authorization } })).status, 401);
});

test('peer catalog is index-only and recent/history source reads remain pinned without desktop navigation', async t => {
  const f = await fixture(t), catalog = await f.service.peerApi('/api/peer/catalog?limit=200', 'GET', {}, f.deviceId);
  assert.equal(catalog.sessions[0].id, 'mirror-fixture'); assert.equal(catalog.sessions[0].sessionKey, undefined);
  assert.equal(f.counters().starts, 0); assert.equal(f.counters().reads, 0);
  const recent = await f.service.peerApi('/api/peer/sessions/mirror-fixture/recent', 'POST', { limit: 50 }, f.deviceId);
  assert.equal(recent.rows[0].text, 'synthetic-current'); assert.equal(recent.session.sessionKey.length > 0, true); assert.equal(f.counters().reads, 1);
  await assert.rejects(f.service.peerApi('/api/peer/sessions/mirror-fixture/history', 'GET', {}, f.deviceId), /cursor/);
  await assert.rejects(f.service.peerApi('/api/peer/sessions/foreign/recent', 'POST', {}, f.deviceId), /unavailable/);
  assert.equal(f.daemon.closed, false);
});

test('proof authorization replaces the token only on the owned backend link and revocation affects the same LAN entry', async t => {
  const f = await fixture(t), local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  const path = '/v2/sessions', url = localRequestUrl(local, path), authorization = header(f, local, path);
  assert.equal(authorization.includes(f.token), false);
  const response = await fetch(url, { headers: { Authorization: authorization } }); assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic-backend');
  assert.equal(f.counters().backendHeaders?.authorization, 'Bearer ' + f.token);
  await f.devices.revoke(f.deviceId);
  assert.equal((await fetch(url, { headers: { Authorization: header(f, local, path) } })).status, 401);
});
