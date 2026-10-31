import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeProjectActivityService } from '../src/happy/project-activity.mjs';
import { CodexActivityObserver } from '../src/adapters/codex-activity.mjs';

/** @typedef {Record<string, any>} Value */
/** @param {number} i @param {Value} [extra] */
function source(i, extra = {}) { return { id: `thread-${i}`, relayId: `phone-${i}`, app: 'codex', kind: 'session', hostId: 'local', workspace: '/fixture/project', ...extra }; }
const group = { id: 'phone-card', projectKey: '/fixture/project', hostId: 'local' };
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
class Observer {
  value = { known: false, active: false, waiting: false, status: 'refreshing' };
  refreshes = 0; closed = false;
  /** @type {(()=>void)|null} */ finish = null;
  /** @param {boolean} deferred @param {()=>void} begin @param {()=>void} end */
  constructor(deferred, begin, end) { this.deferred = deferred; this.begin = begin; this.end = end; }
  refresh() {
    this.refreshes++; this.begin();
    return new Promise(resolve => {
      this.finish = () => { this.end(); if (!this.closed) this.value = { known: true, active: true, waiting: true, status: 'ready' }; resolve(undefined); };
      if (!this.deferred) this.finish();
    });
  }
  status() { return { ...this.value }; }
  close() { this.closed = true; }
}

/** A native-shaped follower, used with the actual observer rather than a ready stub. */
class WireActivityIpc {
  socket = { destroyed: false }; clientId = 'fixture-follower'; owner = 'local:original';
  subscriptions = 0; refreshes = 0; releases = 0; activeRefreshes = 0; peakRefreshes = 0;
  deferredRefresh = false; failStart = false;
  callbacks = /** @type {Map<string,(frame:Value)=>void>} */ (new Map());
  states = /** @type {Map<string,Value>} */ (new Map());
  revisions = /** @type {Map<string,number>} */ (new Map());
  pending = /** @type {(()=>void)[]} */ ([]);
  /** @param {string} _id */ generation(_id) { return this.owner; }
  async connect() {}
  /** @param {string} id @param {(frame:Value)=>void} callback */
  async subscribe(id, callback) {
    this.subscriptions++;
    if (this.failStart) throw Error('No native owner');
    this.callbacks.set(id, callback);
    if (!this.states.has(id)) this.states.set(id, { threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [], turns: [] });
    if (!this.revisions.has(id)) this.revisions.set(id, 1);
    this.snapshot(id);
    return () => { if (this.callbacks.delete(id)) this.releases++; };
  }
  /** @param {string} id @param {Value} change */
  emit(id, change) { this.callbacks.get(id)?.({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: this.owner.split(':').at(-1), params: { conversationId: id, hostId: 'local', change } }); }
  /** @param {string} id */
  snapshot(id) { this.emit(id, { type: 'snapshot', revision: this.revisions.get(id), conversationState: this.states.get(id) }); }
  /** @param {string} id @param {Value[]} patches @param {number} baseRevision @param {number} revision */
  patch(id, patches, baseRevision, revision) { this.revisions.set(id, revision); this.emit(id, { type: 'patches', baseRevision, revision, patches }); }
  /** @param {string} id */
  async refreshSnapshot(id) {
    this.refreshes++; this.activeRefreshes++; this.peakRefreshes = Math.max(this.peakRefreshes, this.activeRefreshes);
    await new Promise(resolve => {
      const finish = () => { this.snapshot(id); this.activeRefreshes--; resolve(undefined); };
      if (this.deferredRefresh) this.pending.push(finish); else finish();
    });
  }
  finish() { const pending = this.pending; this.pending = []; for (const finish of pending) finish(); }
  dispose() { this.callbacks.clear(); this.finish(); }
}
/** @param {import('node:test').TestContext} t @param {WireActivityIpc} ipc @param {number} [count] */
function wireFixture(t, ipc, count = 1) {
  let now = 100;
  const service = new NativeProjectActivityService({ sources: () => Array.from({ length: count }, (_, i) => source(i)), inventoryAvailable: () => true, now: () => now,
    ipcFactory: () => ipc, observerFactory: options => new CodexActivityObserver(/** @type {any} */ (options)) });
  t.after(() => service.close());
  return { service, advance: () => { now += 10000; } };
}
/** @param {import('node:test').TestContext} t @param {{sources?:Value[],deferred?:boolean,maxSources?:number}} [options] */
function fixture(t, options = {}) {
  let now = 100, active = 0, peak = 0, available = true;
  let sources = options.sources ?? [source(1)];
  const observers = /** @type {Map<string,Observer>} */ (new Map());
  const created = /** @type {Observer[]} */ ([]), disposals = /** @type {string[]} */ ([]);
  const service = new NativeProjectActivityService({ sources: () => sources, inventoryAvailable: () => available, now: () => now, epoch: 'fixture-epoch', maxSources: options.maxSources,
    ipcFactory: host => ({ dispose() { disposals.push(host); } }), observerFactory: config => {
      const observer = new Observer(options.deferred === true, () => { active++; peak = Math.max(peak, active); }, () => { active--; });
      // The service only receives reduced status; fixture completion is controlled externally.
      observers.set(config.id, observer); created.push(observer); return observer;
    } });
  t.after(() => service.close());
  return { service, observers, created, disposals, advance: (/** @type {number} */ ms) => { now += ms; }, setSources: (/** @type {Value[]} */ value) => { sources = value; }, setAvailable: (/** @type {boolean} */ value) => { available = value; }, peak: () => peak };
}
/** @param {NativeProjectActivityService} service @param {string} clientId @param {number} requestSeq @param {Value[]} [groups] */
function poll(service, clientId, requestSeq, groups = [group]) { return service.poll({ clientId, requestSeq, groups: /** @type {any} */ (groups) }); }

test('poll returns immediately, shares one native observer across phones, and counts overlap', async t => {
  const f = fixture(t, { deferred: true });
  const first = poll(f.service, 'phone-a', 1);
  assert.deepEqual(first.groups[0], { id: group.id, total: 1, active: 0, waiting: 0, unknown: 1, status: 'refreshing' });
  const second = poll(f.service, 'phone-b', 1, [{ ...group, id: 'another-card' }]);
  assert.equal(second.epoch, first.epoch); assert.equal(second.sequence, first.sequence + 1);
  await flush(); assert.equal(f.created.length, 1); assert.equal(f.created[0].refreshes, 1);
  f.created[0].finish?.(); await flush();
  const ready = poll(f.service, 'phone-a', 2).groups[0];
  assert.deepEqual(ready, { id: group.id, total: 1, active: 1, waiting: 1, unknown: 0, status: 'ready' });
  poll(f.service, 'phone-a', 3, []); assert.equal(f.created[0].closed, false);
  poll(f.service, 'phone-b', 2, []); assert.equal(f.created[0].closed, true);
  assert.deepEqual(f.disposals, ['local']);
});

test('leases and release tombstones reject late polls/releases and identical retries do not revive interest', async t => {
  const f = fixture(t);
  poll(f.service, 'phone', 1); await flush();
  f.advance(20000); poll(f.service, 'phone', 1);
  f.advance(10001); poll(f.service, 'other', 1, []);
  assert.equal(f.created[0].closed, true);
  poll(f.service, 'phone', 1); await flush(); assert.equal(f.created.length, 1);
  poll(f.service, 'phone', 2); await flush(); assert.equal(f.created.length, 2);
  assert.throws(() => poll(f.service, 'phone', 1, []), { code: 'stale-activity-interest' });
  assert.throws(() => poll(f.service, 'phone', 2, []), { code: 'activity-interest-conflict' });
  poll(f.service, 'phone', 3, []);
  f.advance(119999);
  assert.throws(() => poll(f.service, 'phone', 2), { code: 'stale-activity-interest' });
  poll(f.service, 'phone', 3, []); await flush(); assert.equal(f.created.length, 2);
});

test('late observer completions never recreate released or closed interests', async t => {
  const f = fixture(t, { deferred: true });
  poll(f.service, 'phone', 1); await flush();
  assert.equal(f.created[0].refreshes, 1);
  poll(f.service, 'phone', 2, []);
  f.created[0].finish?.(); await flush();
  assert.equal(f.service.entries.size, 0); assert.equal(f.created.length, 1);
  poll(f.service, 'phone', 3); await flush();
  f.service.close(); f.created[1].finish?.(); await flush();
  assert.equal(f.service.entries.size, 0); assert.equal(f.created.length, 2);
});

test('bounded starts use at most four simultaneous owner reads and excess membership stays unknown', async t => {
  const f = fixture(t, { sources: Array.from({ length: 130 }, (_, i) => source(i)), deferred: true });
  assert.equal(poll(f.service, 'phone', 1).groups[0].unknown, 130);
  await flush(); assert.equal(f.created.length, 128); assert.equal(f.peak(), 4);
  assert.equal(f.created.filter(observer => observer.refreshes).length, 4);
  for (let i = 0; i < 32; i++) {
    for (const observer of f.created.filter(observer => observer.refreshes && observer.finish)) { const finish = observer.finish; observer.finish = null; finish?.(); }
    await flush();
  }
  const summary = poll(f.service, 'phone', 2).groups[0];
  assert.equal(summary.total, 130); assert.equal(summary.active, 128); assert.equal(summary.waiting, 128); assert.equal(summary.unknown, 2); assert.equal(summary.status, 'unavailable');
  assert.equal(f.peak(), 4);
});

test('only Codex native membership and explicit host/project identity affect totals', async t => {
  const f = fixture(t, { sources: [source(1), source(1), source(2, { app: 'claude' }), source(3, { kind: 'window' }), source(4, { controlMode: 'window' }), source(5, { controlMode: 'new-mode' }),
    source(6, { project: { key: 'project-key' } }), source(7, { hostId: 'remote' }), source(8, { archived: true }), source(9, { catalogueAvailable: false }), source(10, { metadata: { bridge: { controlMode: 'window' } } }),
    source(11, { controlMode: null }), source(12, { bridge: { controlMode: null } }), source(13, { metadata: { bridge: { controlMode: null } } }),
    source(14, { controlMode: 'session', bridge: { controlMode: 'new-mode' } }), source(15, { controlMode: 'session', metadata: { bridge: { controlMode: 'window' } } }),
    source(16, { metadata: { controlMode: 'new-mode' } }), source(17, { metadata: { controlMode: null } })] });
  const summaries = poll(f.service, 'phone', 1, [group, { id: 'project', projectKey: 'project-key', hostId: 'local' }, { id: 'remote', projectKey: '/fixture/project', hostId: 'remote' }]).groups;
  assert.deepEqual(summaries.map(group => [group.id, group.total]), [['phone-card', 2], ['project', 1], ['remote', 1]]);
  await flush(); assert.equal(f.created.length, 4);
});

test('inventory loss and cold/unavailable owners preserve unknown coverage', async t => {
  const f = fixture(t, { deferred: true });
  poll(f.service, 'phone', 1); await flush();
  f.created[0].value = { known: false, active: false, waiting: false, status: 'unavailable' };
  const cold = poll(f.service, 'phone', 2).groups[0]; assert.equal(cold.unknown, 1); assert.equal(cold.active, 0);
  f.setAvailable(false);
  const lost = poll(f.service, 'phone', 3).groups[0]; assert.equal(lost.unknown, 1); assert.equal(lost.status, 'unavailable'); assert.equal(f.created[0].closed, true);
  f.setSources([]); const emptyUnknown = poll(f.service, 'phone', 4).groups[0]; assert.equal(emptyUnknown.total, 0); assert.equal(emptyUnknown.status, 'unavailable');
});

test('payload remains small and contains only summaries even with large source/history data', async t => {
  const large = 'PRIVATE_HISTORY_PAYLOAD'.repeat(200000);
  const f = fixture(t, { sources: [source(1, { history: large, title: large, tools: [{ output: large }], project: { key: '/fixture/project', label: large } })] });
  const result = poll(f.service, 'phone', 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 500);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.ok(!JSON.stringify([...f.service.entries.values()].map(entry => entry.source)).includes('PRIVATE_'));
  assert.deepEqual(Object.keys(result.groups[0]).sort(), ['active', 'id', 'status', 'total', 'unknown', 'waiting']);
  assert.throws(() => poll(f.service, 'phone', 2, Array.from({ length: 17 }, (_, i) => ({ ...group, id: String(i) }))), { code: 'invalid-activity-interest' });
  assert.throws(() => poll(f.service, 'phone', 2, [group, group]), { code: 'invalid-activity-interest' });
  assert.throws(() => poll(f.service, 'phone', 2, [{ ...group, id: 'a'.repeat(8193) }]), { code: 'invalid-activity-interest' });
  await flush(); assert.equal(f.created.length, 1);
});

test('long scoped UI IDs and workspace keys round-trip while descriptor bytes remain bounded', async t => {
  const projectKey = '/' + 'p'.repeat(4095), uiId = 'server/account/machine:'.repeat(20) + projectKey;
  const f = fixture(t, { sources: [source(1, { workspace: projectKey })] });
  const longGroup = { ...group, id: uiId, projectKey };
  assert.ok(uiId.length > 4096);
  const result = poll(f.service, 'phone', 1, [longGroup]);
  assert.equal(result.groups[0].id, uiId); assert.equal(result.groups[0].total, 1);
  const fullId = 'i'.repeat(8192);
  assert.equal(poll(f.service, 'phone', 2, [{ ...longGroup, id: fullId }]).groups[0].id, fullId);
  assert.throws(() => poll(f.service, 'phone', 3, [{ ...longGroup, projectKey: '/' + 'p'.repeat(4096) }]), { code: 'invalid-activity-interest' });
  const oversized = Array.from({ length: 16 }, (_, i) => ({ ...group, id: String(i).padStart(2, '0') + '界'.repeat(8190) }));
  assert.throws(() => poll(f.service, 'phone', 3, oversized), /size budget/);
  await flush(); assert.equal(f.created.length, 1);
});

test('repeated warm polls read the small native replica without additional subscriptions or full snapshots', async t => {
  const ipc = new WireActivityIpc(), f = wireFixture(t, ipc);
  poll(f.service, 'phone', 1); await flush();
  assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  for (let sequence = 2; sequence <= 12; sequence++) {
    f.advance();
    assert.equal(poll(f.service, 'phone', sequence).groups[0].active, 1);
    await flush();
  }
  assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  const native = /** @type {Value} */ (ipc.states.get('thread-0'));
  native.threadRuntimeStatus.type = 'idle'; native.requests.push({ id: 'native-request' });
  ipc.patch('thread-0', [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }, { op: 'add', path: ['requests', 0], value: { id: 'native-request' } }], 1, 2);
  const changed = poll(f.service, 'phone', 13).groups[0];
  assert.equal(changed.active, 0); assert.equal(changed.waiting, 1); assert.equal(changed.unknown, 0);
  await flush(); assert.equal(ipc.refreshes, 0);
});

test('native gaps recover through the same four-read bound and never refresh ready peers', async t => {
  const ipc = new WireActivityIpc(), f = wireFixture(t, ipc, 8);
  poll(f.service, 'phone', 1); await flush(); await flush();
  assert.equal(ipc.subscriptions, 8); assert.equal(ipc.refreshes, 0);
  ipc.deferredRefresh = true;
  for (let i = 0; i < 8; i++) ipc.patch(`thread-${i}`, [], 99, 2);
  await flush();
  assert.equal(ipc.refreshes, 4); assert.equal(ipc.activeRefreshes, 4); assert.equal(ipc.peakRefreshes, 4);
  assert.equal(poll(f.service, 'phone', 2).groups[0].unknown, 8);
  ipc.finish(); await flush();
  assert.equal(ipc.refreshes, 8); assert.equal(ipc.activeRefreshes, 4);
  ipc.finish(); await flush();
  assert.equal(poll(f.service, 'phone', 3).groups[0].unknown, 0); await flush();
  assert.equal(ipc.refreshes, 8); assert.equal(ipc.peakRefreshes, 4);
});

test('cold failure retries only on a later poll and owner change needs a new native snapshot', async t => {
  const ipc = new WireActivityIpc(); ipc.failStart = true;
  const f = wireFixture(t, ipc);
  poll(f.service, 'phone', 1); await flush(); await flush(); await flush();
  assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  assert.equal(f.service.entries.values().next().value?.observer.status().known, false);
  ipc.failStart = false; poll(f.service, 'phone', 2); await flush();
  assert.equal(ipc.subscriptions, 2); assert.equal(ipc.refreshes, 0);
  ipc.owner = 'local:replacement';
  const before = poll(f.service, 'phone', 3).groups[0]; assert.equal(before.unknown, 1);
  await flush(); assert.equal(ipc.subscriptions, 3); assert.equal(ipc.refreshes, 0);
  assert.equal(poll(f.service, 'phone', 4).groups[0].unknown, 0); await flush(); assert.equal(ipc.refreshes, 0);
  ipc.socket.destroyed = true;
  assert.equal(poll(f.service, 'phone', 5).groups[0].unknown, 1);
  poll(f.service, 'phone', 6, []); await flush();
  assert.equal(f.service.entries.size, 0); assert.equal(ipc.subscriptions, 3);
});

test('visible rows add only requested status fields while older project-only v1 calls keep their shape', async t => {
  const f = fixture(t);
  const old = poll(f.service, 'old-phone', 1).groups[0];
  assert.equal(Object.hasOwn(old, 'sessions'), false);
  const requested = { ...group, sessions: [{ id: 'phone-1', nativeId: 'thread-1', title: 'PRIVATE_TITLE', tools: [{ output: 'PRIVATE_OUTPUT' }] }] };
  const cold = poll(f.service, 'new-phone', 1, [requested]).groups[0];
  assert.deepEqual(cold.sessions, [{ id: 'phone-1', known: false, active: false, waiting: false }]);
  await flush();
  const ready = poll(f.service, 'new-phone', 2, [requested]).groups[0];
  assert.deepEqual(ready.sessions, [{ id: 'phone-1', known: true, active: true, waiting: true }]);
  assert.ok(!JSON.stringify(ready).includes('PRIVATE_')); assert.ok(!JSON.stringify(ready).includes('nativeId'));
  assert.deepEqual(Object.keys(ready.sessions[0]).sort(), ['active', 'id', 'known', 'waiting']);
  assert.deepEqual(poll(f.service, 'new-phone', 3, [{ ...group, sessions: [] }]).groups[0].sessions, []);
  assert.equal(Object.hasOwn(poll(f.service, 'old-phone', 2).groups[0], 'sessions'), false);
});

test('row status verifies relay/native pair within the requested project and host without leaking foreign state', async t => {
  const f = fixture(t, { sources: [source(1), source(2, { workspace: '/foreign-project' }), source(3, { hostId: 'remote' }), source(4, { kind: 'window' }), source(5, { app: 'claude' }), source(6, { relayId: undefined })] });
  const rows = [{ id: 'phone-1', nativeId: 'thread-1' }, { id: 'wrong-phone', nativeId: 'thread-1' }, { id: 'phone-2', nativeId: 'thread-2' },
    { id: 'phone-3', nativeId: 'thread-3' }, { id: 'phone-4', nativeId: 'thread-4' }, { id: 'phone-5', nativeId: 'thread-5' },
    { id: 'phone-6', nativeId: 'thread-6' }, { id: 'invalid-native', nativeId: null }, { id: 'missing-native' }];
  const descriptors = [{ ...group, sessions: rows }, { ...group, id: 'other-project', projectKey: '/foreign-project' }, { ...group, id: 'other-host', hostId: 'remote' }];
  poll(f.service, 'phone', 1, descriptors); await flush();
  const result = poll(f.service, 'phone', 2, descriptors).groups;
  assert.equal(result[1].active, 1); assert.equal(result[2].active, 1);
  assert.deepEqual(result[0].sessions, rows.map((row, i) => ({ id: row.id, known: i === 0, active: i === 0, waiting: i === 0 })));
  f.setAvailable(false);
  assert.deepEqual(poll(f.service, 'phone', 3, descriptors).groups[0].sessions, rows.map(row => ({ id: row.id, known: false, active: false, waiting: false })));
});

test('visible older rows take allocation and start priority while phones share the 128 observer budget', async t => {
  const f = fixture(t, { sources: Array.from({ length: 150 }, (_, i) => source(i)), deferred: true });
  const identity = (/** @type {number} */ i) => JSON.stringify(['local', `thread-${i}`]);
  poll(f.service, 'header-phone', 1);
  poll(f.service, 'row-phone', 1, [{ ...group, sessions: [{ id: 'wrong-relay', nativeId: 'thread-149' }] }]);
  assert.equal(f.service.entries.has(identity(149)), false);
  const visible = [{ ...group, id: 'row-only-card', sessions: [{ id: 'phone-149', nativeId: 'thread-149' }] }];
  poll(f.service, 'row-phone', 2, visible);
  assert.equal(f.service.entries.size, 128); assert.equal(f.service.entries.has(identity(149)), true);
  assert.equal(f.service.entries.keys().next().value, identity(149));
  await flush();
  const observer = /** @type {Observer} */ (f.observers.get('thread-149'));
  assert.equal(observer.refreshes, 1); assert.equal(f.peak(), 4);
  observer.finish?.(); await flush();
  const result = poll(f.service, 'row-phone', 3, visible).groups[0];
  assert.deepEqual(result.sessions, [{ id: 'phone-149', known: true, active: true, waiting: true }]);
  assert.equal(result.total, 150); assert.ok(result.unknown >= 22);
  poll(f.service, 'third-phone', 1, visible); await flush();
  assert.equal(f.observers.get('thread-149'), observer); assert.equal(observer.refreshes, 1); assert.equal(f.service.entries.size, 128);
  assert.throws(() => poll(f.service, 'row-phone', 2, [{ ...group, sessions: [] }]), { code: 'stale-activity-interest' });
  assert.throws(() => poll(f.service, 'row-phone', 3, [{ ...group, sessions: [] }]), { code: 'activity-interest-conflict' });
});

test('visible row limits and payload budget apply across groups and expose no source history', async t => {
  const large = 'PRIVATE_HISTORY'.repeat(200000);
  const f = fixture(t, { sources: Array.from({ length: 64 }, (_, i) => source(i, { title: large, history: large, tools: [{ output: large }] })) });
  const rows = Array.from({ length: 64 }, (_, i) => ({ id: `phone-${i}`, nativeId: `thread-${i}`, history: large }));
  const result = poll(f.service, 'phone', 1, [{ ...group, sessions: rows }]);
  assert.equal(result.groups[0].sessions?.length, 64); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6500);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_')); assert.ok(!JSON.stringify(result).includes('nativeId'));
  assert.throws(() => poll(f.service, 'phone', 2, [{ ...group, sessions: [...rows, { id: 'extra', nativeId: 'extra' }] }]), /sixty-four/);
  assert.throws(() => poll(f.service, 'phone', 2, [{ ...group, sessions: rows.slice(0, 32) }, { ...group, id: 'another-card', sessions: rows.slice(31) }]), /sixty-four/);
  const oversized = rows.map((row, i) => ({ ...row, id: String(i).padStart(2, '0') + '界'.repeat(8190) }));
  assert.throws(() => poll(f.service, 'phone', 2, [{ ...group, sessions: oversized }]), /size budget/);
  await flush(); assert.equal(f.created.length, 64);
});

test('warm visible rows use the native small replica and recover gaps without per-row or extra snapshot reads', async t => {
  const ipc = new WireActivityIpc(), f = wireFixture(t, ipc);
  const visible = [{ ...group, sessions: [{ id: 'phone-0', nativeId: 'thread-0' }] }];
  poll(f.service, 'phone', 1, visible); await flush();
  for (let sequence = 2; sequence <= 12; sequence++) {
    f.advance();
    assert.deepEqual(poll(f.service, 'phone', sequence, visible).groups[0].sessions, [{ id: 'phone-0', known: true, active: true, waiting: false }]);
    await flush();
  }
  assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 0);
  const native = /** @type {Value} */ (ipc.states.get('thread-0'));
  native.threadRuntimeStatus.type = 'idle'; native.requests.push({ id: 'waiting' });
  ipc.patch('thread-0', [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }, { op: 'add', path: ['requests', 0], value: { id: 'waiting' } }], 1, 2);
  assert.deepEqual(poll(f.service, 'phone', 13, visible).groups[0].sessions, [{ id: 'phone-0', known: true, active: false, waiting: true }]);
  assert.equal(ipc.refreshes, 0);
  ipc.deferredRefresh = true; ipc.patch('thread-0', [], 99, 3); await flush();
  assert.deepEqual(poll(f.service, 'phone', 14, visible).groups[0].sessions, [{ id: 'phone-0', known: false, active: false, waiting: false }]);
  assert.equal(ipc.refreshes, 1); ipc.finish(); await flush();
  assert.deepEqual(poll(f.service, 'phone', 15, visible).groups[0].sessions, [{ id: 'phone-0', known: true, active: false, waiting: true }]);
  await flush(); assert.equal(ipc.subscriptions, 1); assert.equal(ipc.refreshes, 1);
});
