import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalAgentAdapter, LOCAL_AGENT_CATALOG } from '../src/adapters/local-agent-window.mjs';
import { discoverLocalAgents, inspectLocalAgents } from '../src/adapters/local-agent-discovery.mjs';

/** @typedef {Record<string,any>} Value */
async function fixture(/** @type {string} */ app) {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-agent-window-'));
  /** @type {Value[]} */ const calls = [];
  const bounds = { x: 20, y: 20, width: 1000, height: 700 };
  const stamp = { runtimeGeneration: 'app-runtime', windowGeneration: 'app-window', layoutGeneration: 'controls', imageLayoutHash: 'layout', bounds };
  let locked = false, hasWindows = true;
  const native = async (/** @type {Value} */ request) => {
    calls.push(request);
    if (request.operation === 'probe') return { running: true, pid: 42, runtimeGeneration: 'app-runtime',
      permissions: { accessibility: true, screenCapture: true }, sessionAccess: { screenLocked: locked, lockStateKnown: true },
      windows: hasWindows ? [{ windowId: 9, applicationWindow: true, windowGeneration: 'app-window', bounds }] : [], axWindowInventory: { windows: [{ bounds }] } };
    if (request.operation === 'mirror') return { imagePath: join(dir, 'fixture.png'), captureStamp: stamp, controls: [{ nodeId: 'input', role: 'AXTextArea', valueSettable: true, enabled: true, text: { value: '' } }] };
    return { performed: true, businessAcceptanceVerified: false };
  };
  return { adapter: createLocalAgentAdapter(app, { native, screenshotDir: dir }), calls, stamp, lock: () => { locked = true; }, noWindows: () => { hasWindows = false; }, dispose: () => rm(dir, { recursive: true, force: true }) };
}

test('new apps preserve their actual bundle/window identity and do not manufacture session admission', async () => {
  const claude = await fixture('claude-desktop'), cursor = await fixture('cursor');
  try {
    const a = (await claude.adapter.list())[0], b = (await cursor.adapter.list())[0];
    assert.equal(a.id, b.id); assert.notEqual(a.app, b.app);
    const view = await claude.adapter.snapshot(a.id);
    assert.equal(view.app, 'claude-desktop'); assert.equal(view.currentTurnId, null); assert.equal(view.sessionIdentityVerified, false); assert.equal(view.textInputAvailable, true); assert.deepEqual(view.rows, []);
    const command = await claude.adapter.command(a.id, 'type', { captureStamp: claude.stamp, nodeId: 'input', text: 'Dedicated fixture only' }, 'local-agent-type-0001');
    assert.equal(command.businessAcceptanceVerified, false);
    assert.ok(claude.calls.every(c => c.bundleId === 'com.anthropic.claudefordesktop'));
    assert.ok(cursor.calls.every(c => c.bundleId === 'com.todesktop.230313mzl4w4u92'));
  } finally { await claude.adapter.dispose(); await cursor.adapter.dispose(); await claude.dispose(); await cursor.dispose(); }
});

test('unrecognized apps, implicit launches, terminal typing, stale ownership and locked windows cannot dispatch', async () => {
  assert.throws(() => createLocalAgentAdapter('arbitrary-app'), { code: 'unsupported-local-agent' });
  const f = await fixture('warp');
  try {
    await assert.rejects(f.adapter.command('window_9', 'launch', {}, 'no-auto-launch-0001'), { code: 'explicit-app-open-required' });
    await assert.rejects(f.adapter.command('window_9', 'type', { captureStamp: f.stamp, nodeId: 'input', text: 'unsafe' }, 'no-terminal-type-0001'), { code: 'terminal-input-unverified' });
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.adapter.command('window_9', 'click', { captureStamp: { ...f.stamp, runtimeGeneration: 'older' }, x: 1, y: 1 }, 'stale-local-window-0001'), { code: 'stale-runtime' });
    f.lock(); await assert.rejects(f.adapter.command('window_9', 'press', { captureStamp: f.stamp, nodeId: 'input' }, 'locked-local-window-0001'), { code: 'screen-locked' });
    assert.ok(f.calls.every(c => c.operation === 'probe'));
  } finally { await f.adapter.dispose(); await f.dispose(); }
});

test('a running app without a real window does not advertise capture or control', async () => {
  const f = await fixture('cursor');
  try { f.noWindows(); const status = /** @type {Value} */ (await f.adapter.status()); assert.equal(status.connected, false); assert.equal(status.reason, 'window-unavailable'); assert.equal(status.capabilities.capture, false); }
  finally { await f.adapter.dispose(); await f.dispose(); }
});

test('installed helper processes are not a running app and full argv is never requested', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-agent-install-'));
  const app = join(dir, 'Claude.app'); await mkdir(join(app, 'Contents'), { recursive: true }); await writeFile(join(app, 'Contents', 'Info.plist'), 'fixture');
  try {
    const inventory = await inspectLocalAgents({ applicationsDirectories: [dir], processes: async () => [{ pid: 2, parentPid: 1, executable: join(app, 'Contents/Frameworks/Helper') }],
      readPlist: async () => ({ CFBundleIdentifier: 'com.anthropic.claudefordesktop', CFBundleExecutable: 'Claude', CFBundleShortVersionString: 'fixture' }) });
    const item = inventory.applications.find(a => a.app === 'claude-desktop');
    assert.equal(item?.installed, true); assert.equal(item?.running, false); assert.deepEqual(item?.processes, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('discovery returns unavailable app-window placeholders separately from verified physical windows', async () => {
  const inventory = { applications: [{ app: 'claude-desktop', name: 'Claude Desktop', installed: true, identityMatches: true }, { app: 'cursor', name: 'Cursor', installed: true, identityMatches: true }] };
  const factory = (/** @type {string} */ app) => ({ status: async () => ({ running: app === 'cursor', connected: app === 'cursor', runtimeGeneration: app === 'cursor' ? 'r' : null, reason: 'agent-not-running' }),
    list: async () => [{ id: 'window_21', kind: 'window', title: 'Fixture', windowGeneration: 'w' }], dispose: async () => {} });
  const all = await discoverLocalAgents({ inventory, createAdapter: factory });
  assert.equal(all.find(a => a.app === 'claude-desktop')?.available, false);
  assert.equal(all.find(a => a.app === 'claude-desktop')?.id, 'app-window');
  assert.equal(all.find(a => a.app === 'cursor')?.id, 'window_21');
  const physical = await discoverLocalAgents({ inventory, createAdapter: factory, includeUnavailable: false });
  assert.equal(physical.length, 1); assert.equal(physical[0].sessionIdentityVerified, false);
  assert.ok(LOCAL_AGENT_CATALOG.every(item => typeof item.bundleId === 'string'));
});
