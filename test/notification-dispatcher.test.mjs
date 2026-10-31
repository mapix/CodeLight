import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceRegistry } from '../src/happy/device-registry.mjs';
import { NotificationDispatcher, notificationSummary, actionableTransitions } from '../src/happy/notification-dispatcher.mjs';

test('notifications require a new original transition; bootstrap and historical backfill remain quiet', () => {
  const old = { currentTurnId: null, turns: { old: 'completed' }, requests: ['old-approval'] };
  assert.deepEqual(actionableTransitions(null, old), []);
  assert.deepEqual(actionableTransitions(old, { ...old, turns: { ...old.turns, historical: 'completed' } }), []);
  assert.deepEqual(actionableTransitions({ ...old, currentTurnId: 'new' }, { ...old, turns: { ...old.turns, new: 'completed' }, requests: ['old-approval', 'new-input'] }).map(e => e.kind), ['completed', 'input']);
  const summary = notificationSummary({ rows: [{ turnId: 'turn', status: 'complete', text: 'private text' }], currentTurnId: null }, [{ key: 'request', request: { command: 'private command' } }]);
  assert.ok(!JSON.stringify(summary).includes('private'));
});

test('device-bound delivery deduplicates across restart, suppresses the viewed session and excludes revoked devices', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-notifications-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const devices = await DeviceRegistry.load(join(directory, 'devices.json'));
  const first = await devices.approve('first', 'Phone', 'first-token'), second = await devices.approve('second', 'Phone', 'second-token');
  await devices.registerPush(first, { enabled: true, token: 'a'.repeat(64), environment: 'development' });
  await devices.registerPush(second, { enabled: true, token: 'b'.repeat(64), environment: 'development' });
  devices.viewingPresence(first, { active: true, sessionId: 'session' });
  const sent = /** @type {string[]} */ ([]);
  const options = { path: join(directory, 'notifications.json'), devices, origin: () => 'https://fixture.example', sender: { environment: 'development', send: async (/** @type {string} */ token) => { sent.push(token); return { ok: true }; } } };
  let dispatcher = new NotificationDispatcher(options); await dispatcher.start();
  const running = { currentTurnId: 'turn', turns: {}, requests: [], epoch: 'owner' }, done = { currentTurnId: null, turns: { turn: 'completed' }, requests: [], epoch: 'owner' };
  await dispatcher.observe('source', 'session', running); await dispatcher.observe('source', 'session', done); await dispatcher.observe('source', 'session', done);
  assert.deepEqual(sent, ['b'.repeat(64)]); await dispatcher.close();
  dispatcher = new NotificationDispatcher(options); await dispatcher.start();
  await dispatcher.observe('source', 'session', running); await dispatcher.observe('source', 'session', done); assert.equal(sent.length, 1);
  await devices.revoke(second);
  await dispatcher.observe('source', 'another-session', { ...done, requests: ['new-input'] }); assert.equal(sent.length, 2); assert.equal(sent[1], 'a'.repeat(64));
  await dispatcher.close();
  assert.equal(devices.list().find(d => d.id === second)?.notifications, false);
  assert.ok(!JSON.stringify(devices.list()).includes('a'.repeat(64)));
});

test('provider invalidation disables only that push token; no configured sender creates no backlog', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-invalid-push-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const devices = await DeviceRegistry.load(join(directory, 'devices.json')), id = await devices.approve('device', 'Phone', 'fixture-token');
  await devices.registerPush(id, { enabled: true, token: 'a'.repeat(64), environment: 'development' });
  const dispatcher = new NotificationDispatcher({ path: join(directory, 'notifications.json'), devices, origin: () => '', sender: { environment: 'development', send: async () => ({ invalidToken: true, ok: false }) } });
  await dispatcher.start(); await dispatcher.observe('source', 'session', { currentTurnId: null, turns: {}, requests: [] });
  await dispatcher.observe('source', 'session', { currentTurnId: null, turns: {}, requests: ['new'] });
  assert.equal(devices.notificationDevices().length, 0); assert.equal(devices.authorize('fixture-token'), id); await dispatcher.close();
});
