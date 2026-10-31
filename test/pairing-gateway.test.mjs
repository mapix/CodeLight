import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import nacl from 'tweetnacl';
import WebSocket, { WebSocketServer } from 'ws';
import { PairingInvitations, createPairingGateway } from '../src/happy/pairing-gateway.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {Value} grant @param {ReturnType<typeof nacl.box.keyPair>} device */
function encryptedRequest(grant, device) {
  const url = new URL(grant.url), nonce = nacl.randomBytes(24);
  const plain = Buffer.from(JSON.stringify({ version: 1, invite: url.searchParams.get('invite'), origin: url.searchParams.get('origin') }));
  return { publicKey: Buffer.from(device.publicKey).toString('base64url'), nonce: Buffer.from(nonce).toString('base64url'),
    ciphertext: Buffer.from(nacl.box(plain, nonce, Buffer.from(grant.key, 'base64url'), device.secretKey)).toString('base64url') };
}

function fixture() {
  let now = 1000;
  const mac = nacl.box.keyPair(), device = nacl.box.keyPair();
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { token: 'fixture-token', secret: 'fixture-secret' }, now: () => now, ttlMs: 100 });
  return { invitations, mac, device, advance: (/** @type {number} */ value) => { now += value; } };
}

test('public pairing bounds crypto admission, recovers after refill and preserves credential issuance', async t => {
  let now = 0, issued = 0;
  const mac = nacl.box.keyPair(), device = nacl.box.keyPair();
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: {}, issueCredentials: async () => { issued++; return { token: 'fixture', secret: 'fixture' }; } });
  const grant = invitations.issue('https://fixture.example');
  const gateway = createPairingGateway({ upstream: 'http://127.0.0.1:1', invitations, pairingBudget: { capacity: 1, now: () => now } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); invitations.close(); });
  const address = gateway.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/codelight/pairing/exchange`;
  const post = (/** @type {Value} */ body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  const limited = await post(encryptedRequest(grant, device));
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1'); assert.equal(issued, 0);
  now = 1000;
  const accepted = await post(encryptedRequest(grant, device)); assert.equal(accepted.status, 200); assert.equal(issued, 1);
  now = 2000;
  assert.equal((await post(encryptedRequest(grant, device))).status, 200); assert.equal(issued, 1);
  assert.equal(gateway.maxConnections, 128); assert.equal(gateway.headersTimeout, 10000); assert.equal(gateway.requestTimeout, 60000);
});
test('scan grant is authenticated by the QR-pinned Mac and retry keeps identical encrypted credentials', () => {
  const f = fixture(), grant = f.invitations.issue('https://fixture.example'), url = new URL(grant.url);
  const input = { invite: /** @type {string} */ (url.searchParams.get('invite')), publicKey: Buffer.from(f.device.publicKey).toString('base64url') };
  const reply = f.invitations.exchange(input), plaintext = nacl.box.open(Buffer.from(reply.ciphertext, 'base64url'), Buffer.from(reply.nonce, 'base64url'), f.mac.publicKey, f.device.secretKey);
  assert.ok(plaintext); assert.equal(JSON.parse(Buffer.from(plaintext).toString()).origin, 'https://fixture.example');
  assert.deepEqual(f.invitations.exchange(input), reply);
  f.advance(200); assert.deepEqual(f.invitations.exchange(input), reply);
  const foreign = nacl.box.keyPair();
  assert.throws(() => f.invitations.exchange({ ...input, publicKey: Buffer.from(foreign.publicKey).toString('base64url') }), /used/);
  assert.equal(nacl.box.open(Buffer.from(reply.ciphertext, 'base64url'), Buffer.from(reply.nonce, 'base64url'), foreign.publicKey, f.device.secretKey), null);
});
test('unused invitations expire and malformed device keys cannot consume them', () => {
  const f = fixture(), grant = f.invitations.issue('https://fixture.example'), invite = /** @type {string} */ (new URL(grant.url).searchParams.get('invite'));
  assert.throws(() => f.invitations.exchange({ invite, publicKey: 'bad-key' }), /invalid/);
  f.advance(100); assert.throws(() => f.invitations.exchange({ invite, publicKey: Buffer.from(f.device.publicKey).toString('base64url') }), /expired/);
});
test('gateway forwards HTTP only to its declared loopback API and keeps invitation enumeration private', async t => {
  const upstream = createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  const f = fixture(), gateway = createPairingGateway({ upstream: `http://127.0.0.1:${upstreamAddress.port}`, invitations: f.invitations });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(async () => { await new Promise(r => gateway.close(r)); await new Promise(r => upstream.close(r)); });
  const gatewayAddress = gateway.address(); assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const origin = `http://127.0.0.1:${gatewayAddress.port}`;
  assert.deepEqual(await (await fetch(origin + '/health')).json(), { path: '/health' });
  assert.equal((await fetch(origin + '/codelight/pairing/code')).status, 404);
  assert.equal((await fetch(origin + '/codelight/pairing/exchange')).status, 405);
  const grant = f.invitations.issue('https://fixture.example');
  const response = await fetch(origin + '/codelight/pairing/exchange', { method: 'POST', body: JSON.stringify(encryptedRequest(grant, f.device)) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('encrypted invitation requests bind both endpoint and phone key before consuming a grant', () => {
  const f = fixture(), grant = f.invitations.issue('https://fixture.example'), request = encryptedRequest(grant, f.device);
  const foreign = nacl.box.keyPair();
  assert.throws(() => f.invitations.exchangeEncrypted({ ...request, publicKey: Buffer.from(foreign.publicKey).toString('base64url') }), /invalid/);
  const reply = f.invitations.exchangeEncrypted(request);
  assert.deepEqual(f.invitations.exchangeEncrypted(request), reply);
  assert.throws(() => f.invitations.exchangeEncrypted(encryptedRequest(grant, foreign)), /used/);
});
test('gateway preserves the actual v1 realtime upgrade path and duplex frames', async t => {
  const upstream = createServer(), wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(data))));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const f = fixture(), gateway = createPairingGateway({ upstream: `http://127.0.0.1:${address.port}`, invitations: f.invitations });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const local = gateway.address(); assert.ok(local && typeof local !== 'string');
  const ws = new WebSocket(`ws://127.0.0.1:${local.port}/v1/updates/?EIO=4&transport=websocket`);
  t.after(async () => { ws.terminate(); gateway.closeAllConnections(); await new Promise(r => gateway.close(r)); wss.close(); await new Promise(r => upstream.close(r)); });
  await once(ws, 'open'); const reply = once(ws, 'message'); ws.send('fixture realtime frame');
  assert.equal((await reply)[0].toString(), 'fixture realtime frame');
});
