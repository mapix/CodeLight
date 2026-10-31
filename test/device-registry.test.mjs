import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DeviceRegistry } from '../src/happy/device-registry.mjs';
import { PairingInvitations, createPairingGateway } from '../src/happy/pairing-gateway.mjs';

test('device revocation closes only its connections and remains effective after reload', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codelight-devices-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'devices.json'), devices = await DeviceRegistry.load(path);
  const first = await devices.approve('fixture-phone-key', 'Phone', 'phone-token'), second = await devices.approve('fixture-tablet-key', 'Tablet', 'tablet-token');
  await devices.rename(first, 'My phone'); const socket = new Socket(); devices.connected(first, socket);
  assert.equal(devices.list().find(row => row.id === first)?.connected, true);
  await devices.revoke(first); assert.equal(socket.destroyed, true); assert.equal(devices.authorize('phone-token'), null); assert.equal(devices.authorize('tablet-token'), second);
  const restored = await DeviceRegistry.load(path); assert.equal(restored.authorize('phone-token'), null); assert.equal(restored.list().find(row => row.id === first)?.name, 'My phone');
});
test('public gateway blocks unpaired/revoked tokens and cannot mint a replacement token through account auth routes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codelight-admission-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const devices = await DeviceRegistry.load(join(folder, 'devices.json')), id = await devices.approve('fixture-key', 'Phone', 'device-token');
  const upstream = createServer((_req, res) => res.end('{}')); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const invitations = new PairingInvitations({ key: new Uint8Array(32), credentials: {} });
  const gateway = createPairingGateway({ upstream: `http://127.0.0.1:${address.port}`, invitations, devices }); gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const local = gateway.address(); assert.ok(local && typeof local !== 'string'); const url = `http://127.0.0.1:${local.port}`;
  t.after(async () => { gateway.closeAllConnections(); await new Promise(r => gateway.close(r)); await new Promise(r => upstream.close(r)); });
  const headers = { Authorization: 'Bearer device-token' };
  const pushUrl = url + '/codelight/notifications/device';
  assert.equal((await fetch(pushUrl, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(pushUrl, { method: 'POST', headers, body: JSON.stringify({ enabled: true, token: 'a'.repeat(64), environment: 'development' }) })).status, 200);
  assert.equal(devices.notificationDevices().length, 1);
  assert.equal((await fetch(url + '/codelight/notifications/presence', { method: 'POST', headers, body: JSON.stringify({ active: true, sessionId: 'session' }) })).status, 200);
  assert.equal((await fetch(url + '/v1/sessions')).status, 401); assert.equal((await fetch(url + '/v1/sessions', { headers })).status, 200);
  assert.equal((await fetch(url + '/v1/auth', { headers })).status, 401); await devices.revoke(id);
  assert.equal((await fetch(url + '/v1/sessions', { headers })).status, 401);
  assert.equal((await fetch(pushUrl, { method: 'POST', headers, body: '{}' })).status, 401); assert.equal(devices.notificationDevices().length, 0);
});

test('viewed sessions require a live foreground device and a bounded nonfuture heartbeat', () => {
  const now = 1_000_000;
  const rows = [
    { id: 'fresh', presence: { active: true, sessionId: 'happy-fresh', at: now } },
    { id: 'same-session', presence: { active: true, sessionId: 'happy-fresh', at: now - 15000 } },
    { id: 'edge', presence: { active: true, sessionId: 'happy-edge', at: now - 45000 } },
    { id: 'expired', presence: { active: true, sessionId: 'happy-expired', at: now - 45001 } },
    { id: 'future', presence: { active: true, sessionId: 'happy-future', at: now + 1 } },
    { id: 'background', presence: { active: false, sessionId: 'happy-background', at: now } },
    { id: 'revoked', revoked: true, presence: { active: true, sessionId: 'happy-revoked', at: now } },
    { id: 'empty', presence: { active: true, sessionId: ' ', at: now } },
    { id: 'disconnected', presence: { active: true, sessionId: 'happy-disconnected', at: now } },
  ];
  const before = JSON.stringify(rows), devices = new DeviceRegistry('/fixture/not-written.json', rows), sockets = new Map();
  for (const row of rows) if (row.id !== 'disconnected') { const socket = new Socket(); sockets.set(row.id, socket); devices.connected(row.id, socket); }
  try {
    assert.deepEqual([...devices.viewedSessions(now)].sort(), ['happy-edge', 'happy-fresh']);
    sockets.get('fresh').emit('close'); sockets.get('same-session').emit('close');
    assert.deepEqual([...devices.viewedSessions(now)], ['happy-edge']);
    assert.deepEqual([...devices.viewedSessions(now + 1)], ['happy-future']);
    assert.equal(devices.viewedSessions(now + 45002).size, 0); assert.equal(JSON.stringify(rows), before);
  } finally { for (const socket of sockets.values()) socket.destroy(); }
});
