import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandReceipts } from '../src/commands.mjs';
import { PhoneAuth } from '../src/auth.mjs';
import { BridgeError } from '../src/errors.mjs';

test('paired browser remains authenticated after independent service restart without plaintext token storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-auth-'));
  try {
    const path = join(directory, 'clients.json');
    const first = await PhoneAuth.load(path);
    const session = first.pair(first.pairCode, 'phone');
    await first.persist();
    const stored = await readFile(path, 'utf8');
    assert.ok(!stored.includes(session.cookie.split('.')[1]));
    const next = await PhoneAuth.load(path);
    assert.equal(next.authorize(`bridge_session=${session.cookie}`), session.id);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    next.revoke(session.id); await next.persist();
    const afterLogout = await PhoneAuth.load(path);
    assert.throws(() => afterLogout.authorize(`bridge_session=${session.cookie}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('settled and in-flight native receipts survive restart without redispatch or storing user input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-receipts-'));
  try {
    const path = join(directory, 'receipts.json');
    const first = await CommandReceipts.load(path);
    let effects = 0;
    const payload = { text: 'private text must never be saved' };
    await first.run('phone:codex:session', 'command_settled', payload, async () => { effects++; return { admitted: true }; });
    const next = await CommandReceipts.load(path);
    assert.equal((await next.run('phone:codex:session', 'command_settled', payload, async () => { effects++; })).status, 'complete');
    assert.equal(effects, 1);
    assert.ok(!(await readFile(path, 'utf8')).includes(payload.text));
    // A running receipt is the exact persisted boundary before native dispatch finishes.
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved[0].receipt.status = 'running';
    await writeFile(path, JSON.stringify(saved));
    const crashed = await CommandReceipts.load(path);
    assert.equal((await crashed.run('phone:codex:session', 'command_settled', payload, async () => { effects++; })).status, 'unknown');
    assert.equal(effects, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('receipt persistence failure before dispatch stops the native effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-failed-store-'));
  try {
    const registry = new CommandReceipts();
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, 'block');
    registry.storePath = join(blocker, 'receipts.json');
    let effects = 0;
    const result = await registry.run('phone', 'command_store', {}, async () => { effects++; });
    assert.equal(result.status, 'failed'); assert.equal(effects, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown receipts retain only bounded native cause codes across restart without redispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-native-cause-'));
  try {
    const path = join(directory, 'receipts.json'), registry = await CommandReceipts.load(path);
    let effects = 0;
    const payload = { action: 'activate', sourceKey: 'fixture-original-window' };
    const receipt = await registry.run('machine', 'cause-window-once', payload, async () => {
      effects++; throw Object.assign(new BridgeError('delivery-unknown', 'private raw details must not persist'), { nativeCause: 'ax_window_ambiguous' });
    });
    assert.equal(receipt.status, 'unknown'); assert.equal(receipt.error, 'delivery-unknown');
    assert.equal(/** @type {any} */ (receipt).nativeCause, 'ax_window_ambiguous');
    const restored = await CommandReceipts.load(path);
    assert.deepEqual(await restored.run('machine', 'cause-window-once', payload, async () => { effects++; }), receipt);
    assert.equal(effects, 1);
    const malformed = JSON.parse(await readFile(path, 'utf8')); malformed[0].receipt.nativeCause = '/private/path secret-token';
    await writeFile(path, JSON.stringify(malformed));
    const sanitized = await CommandReceipts.load(path);
    assert.equal(sanitized.query('machine', 'cause-window-once')?.nativeCause, undefined);
    assert.equal(sanitized.query('machine', 'cause-window-once')?.status, 'unknown');
    const invalid = await registry.run('machine', 'cause-private-details', {}, async () => { throw Object.assign(new BridgeError('delivery-unknown', 'private raw details'), { nativeCause: '/private/path secret-token' }); });
    assert.equal(/** @type {any} */ (invalid).nativeCause, undefined);
    const oversize = await registry.run('machine', 'cause-too-long-details', {}, async () => { throw Object.assign(new BridgeError('delivery-unknown', 'private raw details'), { nativeCause: 'x'.repeat(81) }); });
    assert.equal(/** @type {any} */ (oversize).nativeCause, undefined);
    const stored = await readFile(path, 'utf8');
    assert.ok(!stored.includes('/private/path')); assert.ok(!stored.includes('private raw details')); assert.ok(!stored.includes('secret-token'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
