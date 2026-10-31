import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZCodeAxBackend, invokeNative } from '../src/adapters/zcode-ax.mjs';

/** @typedef {Record<string, any>} Value */

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-window-adapter-'));
  const bounds = { x: 20, y: 30, width: 1000, height: 700 };
  const stamp = { runtimeGeneration: 'runtime-1', windowGeneration: 'window-1', layoutGeneration: 'layout-1', imageLayoutHash: 'image-layout-1', bounds };
  /** @type {Value[]} */ const calls = [];
  let screenLocked = false;
  const native = async (/** @type {Value} */ request) => {
    calls.push(structuredClone(request));
    if (request.operation === 'probe') return { running: true, pid: 42, permissions: { accessibility: true, screenCapture: true },
      sessionAccess: { screenLocked, lockStateKnown: true },
      runtimeGeneration: 'runtime-1', windows: [{ windowId: 12, bounds, onScreen: true, windowGeneration: 'window-1' }],
      axWindowInventory: { windows: [{ role: 'AXWindow', bounds }] } };
    if (request.operation === 'mirror') return { imagePath: join(dir, `image-${calls.length}.png`), captureStamp: stamp,
      window: { bounds, windowId: 12 }, controls: [{ nodeId: 'composer', role: 'AXTextArea', text: { value: '' } }] };
    return { performed: true, operation: request.operation, businessAcceptanceVerified: false };
  };
  const backend = new ZCodeAxBackend({ screenshotDir: dir, native, pollMs: 10000 });
  return { backend, calls, stamp, dir, lock: () => { screenLocked = true; }, dispose: async () => { await backend.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

test('window listing and snapshot never claim a native conversation identity', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.backend.status()).mode, 'accessibility-window');
    const list = await f.backend.list();
    assert.equal(list[0].id, 'window_12'); assert.equal(list[0].kind, 'window');
    const view = await f.backend.snapshot('window_12');
    assert.equal(view.kind, 'window'); assert.equal(view.sessionIdentityVerified, false);
    assert.deepEqual(view.rows, []); assert.deepEqual(view.requests, []); assert.equal(view.currentTurnId, null);
    assert.ok(f.calls.every((call) => ['probe', 'mirror'].includes(call.operation)));
  } finally { await f.dispose(); }
});

test('stale generation, missing capture stamp and outside coordinates never dispatch a mutation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.backend.command('window_12', 'click', { captureStamp: { ...f.stamp, runtimeGeneration: 'old' }, x: 10, y: 10 }, 'stale-window-0001'), { code: 'stale-runtime' });
    await assert.rejects(f.backend.command('window_12', 'click', { runtimeGeneration: 'runtime-1', windowGeneration: 'window-1', x: 10, y: 10 }, 'missing-stamp-0001'), { code: 'capture-stamp-required' });
    await assert.rejects(f.backend.command('window_12', 'click', { captureStamp: f.stamp, x: -1, y: 10 }, 'outside-window-0001'), { code: 'outside-window' });
    assert.ok(f.calls.every((call) => call.operation === 'probe'));
  } finally { await f.dispose(); }
});

test('stable command id dispatches once and native business acceptance is not invented', async () => {
  const f = await fixture();
  try {
    const payload = { captureStamp: f.stamp, nodeId: 'composer', text: 'Only a dedicated test message' };
    const [a, b] = await Promise.all([f.backend.command('window_12', 'type', payload, 'unicode-input-0001'), f.backend.command('window_12', 'type', payload, 'unicode-input-0001')]);
    assert.deepEqual(a, b); assert.equal(a.businessAcceptanceVerified, false);
    assert.equal(f.calls.filter((call) => call.operation === 'type').length, 1);
    await assert.rejects(f.backend.command('window_12', 'type', { ...payload, text: 'changed' }, 'unicode-input-0001'), { code: 'command-conflict' });
    const operation = f.calls.find((call) => call.operation === 'type');
    assert.equal(operation?.expectedRuntimeGeneration, 'runtime-1');
    assert.equal(operation?.expectedWindowGeneration, 'window-1');
    assert.equal(operation?.windowId, 12);
  } finally { await f.dispose(); }
});

test('subscribe disposal stops native mirror polling without touching the application', async () => {
  const f = await fixture();
  try {
    /** @type {Value[]} */ const views = [];
    const dispose = await f.backend.subscribe('window_12', (view) => views.push(view));
    assert.equal(views.length, 1); dispose(); dispose();
    assert.equal(f.backend.subscriptions.size, 0);
    assert.ok(f.calls.every((call) => ['probe', 'mirror'].includes(call.operation)));
  } finally { await f.dispose(); }
});

test('an explicit editable key may use a logical AX binding, while untargeted keys keep the physical stamp gate', async () => {
  const f = await fixture();
  try {
    const logical = { ...f.stamp, axWindowHash: 123, bounds: { x: 0, y: 0, width: 1679, height: 1084 } };
    const result = await f.backend.command('window_12', 'key', { captureStamp: logical, nodeId: 'composer', key: 'command-a' }, 'semantic-key-0001');
    assert.equal(result.performed, true);
    const key = f.calls.find((call) => call.operation === 'key');
    assert.equal(key?.nodeId, 'composer'); assert.equal(key?.pid, 42); assert.equal(key?.windowId, 12);
    await assert.rejects(f.backend.command('window_12', 'key', { captureStamp: logical, key: 'command-a' }, 'untargeted-key-0001'), { code: 'capture-stamp-required' });
  } finally { await f.dispose(); }
});

test('lock metadata clears old images and forbids capture or control dispatch', async () => {
  const f = await fixture();
  try {
    await f.backend.snapshot('window_12');
    const stale = join(f.dir, 'window-11111111-1111-1111-1111-111111111111.png');
    await writeFile(stale, 'only synthetic image bytes');
    f.lock();
    const status = await f.backend.status();
    assert.equal(status.connected, false); assert.equal(status.screenLocked, true); assert.equal(status.reason, 'screen-locked');
    assert.equal(f.backend.images.size, 0);
    await assert.rejects(stat(stale), { code: 'ENOENT' });
    const baseline = f.calls.length;
    await assert.rejects(f.backend.snapshot('window_12'), { code: 'screen-locked' });
    await assert.rejects(f.backend.command('window_12', 'press', { captureStamp: f.stamp, nodeId: 'stop' }, 'locked-control-0001'), { code: 'screen-locked' });
    assert.ok(f.calls.slice(baseline).every((call) => call.operation === 'probe'));
  } finally { await f.dispose(); }
});

test('native partial effect errors become delivery-unknown, while preflight rejects remain failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-effect-helper-'));
  try {
    for (const [name, response, expected] of [
      ['effect', { ok: false, effectMayHaveOccurred: true, error: { code: 'input_effect_unconfirmed' } }, 'delivery-unknown'],
      ['preflight', { ok: false, effectMayHaveOccurred: false, error: { code: 'stale_view' } }, 'stale_view'],
    ]) {
      const binary = join(dir, /** @type {string} */ (name));
      await writeFile(binary, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(response))}));\n`, { mode: 0o700 });
      await assert.rejects(invokeNative(binary, { operation: 'type' }), { code: expected });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
