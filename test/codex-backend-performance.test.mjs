import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** @typedef {Record<string, any>} Value */
class NativeFixture {
  /** @type {((frame:Value)=>void)|null} */ callback = null;
  releases = 0;
  generation() { return null; }
  /** @param {string} _id @param {(frame:Value)=>void} callback */
  async subscribe(_id, callback) { this.callback = callback; return () => { this.releases += 1; this.callback = null; }; }
  /** @param {Value} change */
  emit(change) { this.callback?.({ type: 'broadcast', method: 'thread-stream-state-changed', params: { change } }); }
  dispose() { this.callback = null; }
}

/** @param {number} turnCount @param {number} itemCount @param {number} bytes @returns {{turns:Value[],threadRuntimeStatus:Value,requests:Value[],latestModel:string}} */
function longState(turnCount = 300, itemCount = 12, bytes = 512) {
  const turns = Array.from({ length: turnCount }, (_, turnIndex) => ({
    turnId: `turn-${turnIndex}`, status: 'completed', turnStartedAtMs: turnIndex,
    items: Array.from({ length: itemCount }, (_, itemIndex) => ({
      id: `item-${turnIndex}-${itemIndex}`, type: itemIndex % 2 ? 'commandExecution' : 'agentMessage',
      ...(itemIndex % 2 ? { command: 'synthetic-output', status: 'completed', aggregatedOutput: 'x'.repeat(bytes) } : { text: `Synthetic answer ${turnIndex}/${itemIndex} ${'a'.repeat(bytes)}` }),
      privateConfig: { value: 'synthetic-private-state', nested: Array.from({ length: 6 }, () => ({ flags: [true, false] })) },
    })),
  }));
  return { turns, threadRuntimeStatus: { type: 'idle' }, requests: [], latestModel: 'synthetic-model' };
}

/** @param {import('node:test').TestContext} t @param {Value} state @param {typeof CodexBackend} [Backend] */
async function start(t, state, Backend = CodexBackend) {
  const native = new NativeFixture();
  const backend = new Backend({ ipc: /** @type {any} */ (native), snapshotRefreshMs: 0 });
  /** @type {Value|null} */ let consumer = null;
  const pending = backend.subscribe('synthetic', (view) => { consumer = view; });
  while (!native.callback) await new Promise((resolve) => setImmediate(resolve));
  native.emit({ type: 'snapshot', conversationState: state, revision: 1 });
  await pending;
  const stop = () => { backend.dispose(); consumer = null; };
  t.after(stop);
  const session = backend.sessions.get('synthetic');
  assert.ok(session);
  return { native, backend, session, consumer: () => consumer, stop };
}

test('long native metadata patches retain private history and ordered projection without row work', async (t) => {
  const { native, session, consumer } = await start(t, longState());
  const base = session.state; const before = session.view;
  assert.ok(base && before);
  native.emit({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'active' }] });
  assert.ok(session.state?.turns === base.turns);
  assert.ok(session.view?.rows === before.rows);
  assert.equal(session.projection?.work.projectedItems, 0);
  assert.equal(session.projection?.work.serializedRowBytes, 0);
  assert.equal(consumer()?.status, 'active');
  assert.equal(consumer()?.rows.length, 3600);
  assert.notEqual(consumer()?.rows, session.view?.rows);
  assert.notEqual(session.view?.contentStamp, before.contentStamp);
});

test('long native stdout patch copies ancestors and regenerates exactly the changed public row', async (t) => {
  const { native, session, consumer } = await start(t, longState());
  const base = session.state; const before = session.view;
  assert.ok(base && before);
  native.emit({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns', 299, 'items', 11, 'aggregatedOutput'], value: 'new complete stdout' }] });
  assert.ok(session.state !== base);
  assert.ok(session.state?.turns !== base.turns);
  assert.ok(session.state?.turns[0] === base.turns[0]);
  assert.ok(session.state?.turns[299].items[0] === base.turns[299].items[0]);
  assert.equal(base.turns[299].items[11].aggregatedOutput, 'x'.repeat(512));
  assert.equal(session.view?.rows[0], before.rows[0]);
  assert.equal(session.view?.rows[3598], before.rows[3598]);
  assert.notEqual(session.view?.rows[3599], before.rows[3599]);
  assert.equal(session.projection?.work.projectedItems, 1);
  assert.ok(session.projection?.work.serializedRowBytes < 1000);
  assert.equal(consumer()?.rows.at(-1).tools[0].output, 'new complete stdout');
  consumer()?.rows[0].tools.push({ output: 'consumer-only' });
  assert.deepEqual(session.view?.rows[0].tools, []);
});

test('full same-owner snapshots validate all values and retain unchanged history projections', async (t) => {
  const state = longState();
  const { native, session, consumer } = await start(t, state);
  const base = session.state; const before = session.view; assert.ok(base && before);
  state.turns[299].items[11].aggregatedOutput = 'full snapshot stdout';
  native.emit({ type: 'snapshot', conversationState: structuredClone(state), revision: 1 });
  assert.ok(session.state?.turns[0] === base.turns[0]);
  assert.ok(session.state?.turns[299].items[0] === base.turns[299].items[0]);
  assert.ok(session.view?.rows[0] === before.rows[0]);
  assert.equal(session.projection?.work.projectedItems, 1);
  assert.equal(consumer()?.rows.at(-1).tools[0].output, 'full snapshot stdout');
  state.turns[299].items[11].aggregatedOutput = 'external source mutation';
  assert.equal(session.state?.turns[299].items[11].aggregatedOutput, 'full snapshot stdout');
  const currentRows = session.view?.rows;
  state.turns[299].items[11].aggregatedOutput = 'full snapshot stdout';
  native.emit({ type: 'snapshot', conversationState: state, revision: 1 });
  assert.ok(session.view?.rows === currentRows);
  assert.equal(session.projection?.work.projectedItems, 0);
  assert.equal(session.projection?.work.serializedRowBytes, 0);
  const validBase = session.state;
  Object.defineProperty(state.turns[299].items[11].privateConfig, 'constructor', { enumerable: true, value: 'unsafe-late-snapshot-key' });
  native.emit({ type: 'snapshot', conversationState: state, revision: 2 });
  assert.equal(session.state, null);
  assert.equal(validBase?.turns[299].items[11].aggregatedOutput, 'full snapshot stdout');
  assert.equal(session.view?.status, 'resyncing');
});

test('invalid late native patch cannot mutate any shared base branch or cached row', async (t) => {
  const { native, session } = await start(t, longState(4));
  const base = session.state; const before = session.view;
  assert.ok(base && before);
  native.emit({ type: 'patches', baseRevision: 1, revision: 2, patches: [
    { op: 'replace', path: ['turns', 0, 'items', 1, 'aggregatedOutput'], value: 'must not enter old base' },
    { op: 'replace', path: ['turns', 0, 'items', 1, '__proto__', 'polluted'], value: true },
  ] });
  assert.equal(base.turns[0].items[1].aggregatedOutput, 'x'.repeat(512));
  assert.equal(before.rows[1].tools[0].output, 'x'.repeat(512));
  assert.equal(session.state, null);
  assert.equal(session.view?.status, 'resyncing');
  assert.deepEqual(session.view?.requests, []);
});

/** @param {Value|null} value */
function publicView(value) { assert.ok(value); const copy = { ...value }; delete copy.contentStamp; return copy; }

test('canonical history patches preserve ordering, duplicates, fallback IDs and steering alias changes', async (t) => {
  const state = longState(40, 4, 128);
  const entitiesByKey = Object.fromEntries(state.turns.map((turn) => [turn.turnId, turn]));
  /** @type {Value} */ const canonical = { ...state, turns: [{ turnId: 'stale-fallback', items: [{ type: 'agentMessage', text: 'must not enter canonical history' }] }],
    turnHistory: { history: { islands: [{ entries: state.turns.map((turn) => ({ value: turn.turnId })) }], entitiesByKey } } };
  entitiesByKey['turn-39'].items.push({ type: 'agentMessage', text: 'position fallback' }, { id: 'steer', type: 'steeringUserMessage', clientUserMessageId: 'client', input: [{ type: 'text', text: 'steering text' }] });
  const { native, session, consumer } = await start(t, canonical);
  const full = await start(t, canonical);
  let revision = 1;
  /** @param {Value[]} patches @param {()=>void} mutate */
  const verify = (patches, mutate) => {
    mutate(); native.emit({ type: 'patches', patches, baseRevision: revision, revision: ++revision });
    full.native.emit({ type: 'snapshot', conversationState: canonical, revision });
    assert.deepEqual(publicView(consumer()), publicView(full.consumer()));
  };
  const base = session.state; const before = session.view; assert.ok(base && before);
  verify([{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn-39', 'items', 3, 'aggregatedOutput'], value: 'new canonical stdout' }], () => { entitiesByKey['turn-39'].items[3].aggregatedOutput = 'new canonical stdout'; });
  assert.ok(session.state?.turnHistory.history.entitiesByKey['turn-0'] === base.turnHistory.history.entitiesByKey['turn-0']);
  assert.ok(session.view?.rows[0] === before.rows[0]);
  assert.equal(session.projection?.work.projectedItems, 2); // Changed stdout plus steering whose server alias may have changed.
  verify([{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'turn-39', 'items', 0], value: { id: 'accepted-steer', type: 'userMessage', clientId: 'client', content: [{ type: 'text', text: 'steering text' }] } }], () => { entitiesByKey['turn-39'].items.unshift({ id: 'accepted-steer', type: 'userMessage', clientId: 'client', content: [{ type: 'text', text: 'steering text' }] }); });
  assert.equal(consumer()?.rows.filter((/** @type {Value} */ row) => row.id === 'accepted-steer').length, 1);
  assert.equal(consumer()?.rows.some((/** @type {Value} */ row) => row.id === 'turn-39:5'), true);
  verify([{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn-39', 'status'], value: 'running' }, { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn-39', 'turnStartedAtMs'], value: 999 }], () => { entitiesByKey['turn-39'].status = 'running'; entitiesByKey['turn-39'].turnStartedAtMs = 999; });
  assert.equal(consumer()?.currentTurnId, 'turn-39');
  assert.equal(consumer()?.rows.at(-1).at, 999);
  verify([{ op: 'remove', path: ['turnHistory', 'history', 'islands', 0, 'entries', 0] }], () => { canonical.turnHistory.history.islands[0].entries.shift(); });
  assert.equal(consumer()?.rows[0].turnId, 'turn-1');
  verify([{ op: 'replace', path: [], value: longState(2, 2, 64) }], () => { for (const key of Object.keys(canonical)) delete canonical[key]; Object.assign(canonical, longState(2, 2, 64)); });
  assert.equal(consumer()?.rows.length, 4);
});

test('accepted async replies and changed question titles invalidate dependencies across historical turns', async (t) => {
  const state = longState(50, 4, 64);
  state.turns[0].items = [{ id: 'question-source', type: 'agentMessage', text: 'Question', questions: [{ title: 'Original title', options: ['A'] }] }];
  const { native, session, consumer } = await start(t, state);
  const full = await start(t, state);
  const questionItemId = JSON.stringify(['request_user_input_async', 'question-source', 0]);
  const reply = { id: 'accepted-answer', type: 'userMessage', content: [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId, question: 'Original title', answer: 'A' }])}\n</send_user_message_question_reply>` }] };
  state.turns[49].items.push(reply);
  native.emit({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'add', path: ['turns', 49, 'items', 4], value: reply }] });
  full.native.emit({ type: 'snapshot', conversationState: state, revision: 2 });
  assert.deepEqual(publicView(consumer()), publicView(full.consumer()));
  assert.equal(consumer()?.rows[0].asyncQuestions[0].answered, true);
  assert.equal(consumer()?.rows[0].asyncQuestions[0].answer, 'A');
  assert.ok((session.projection?.work.projectedItems ?? 0) >= 198);
  state.turns[0].items[0].questions[0].title = 'Changed title';
  native.emit({ type: 'patches', baseRevision: 2, revision: 3, patches: [{ op: 'replace', path: ['turns', 0, 'items', 0, 'questions', 0, 'title'], value: 'Changed title' }] });
  full.native.emit({ type: 'snapshot', conversationState: state, revision: 3 });
  assert.deepEqual(publicView(consumer()), publicView(full.consumer()));
  assert.equal(consumer()?.rows.at(-1).text, 'Changed title\nA');
  state.turns[49].items.pop();
  native.emit({ type: 'patches', baseRevision: 3, revision: 4, patches: [{ op: 'replace', path: ['turns', 49, 'items', 'length'], value: 4 }] });
  full.native.emit({ type: 'snapshot', conversationState: state, revision: 4 });
  assert.deepEqual(publicView(consumer()), publicView(full.consumer()));
  assert.equal(consumer()?.rows[0].asyncQuestions[0].answered, false);
});

test('cached history cannot retain stale approval details or removed actionable requests', async (t) => {
  const state = longState(2, 2, 64);
  state.turns[1].items[0] = { id: 'pending-file', type: 'fileChange', status: 'inProgress', changes: [{ path: '/synthetic/file', kind: { type: 'update' }, diff: 'first complete diff' }] };
  state.requests = [{ id: 'file-request', method: 'item/fileChange/requestApproval', params: { turnId: 'turn-1', itemId: 'pending-file' } }];
  const { native, backend, session, consumer } = await start(t, state);
  assert.equal(consumer()?.requests[0].acceptSupported, true);
  native.emit({ type: 'patches', baseRevision: 1, revision: 2, patches: [{ op: 'replace', path: ['turns', 1, 'items', 0, 'changes', 0, 'diff'], value: 'changed complete diff' }] });
  assert.equal(consumer()?.requests[0].changes[0].diff, 'changed complete diff');
  native.emit({ type: 'patches', baseRevision: 2, revision: 3, patches: [{ op: 'replace', path: ['turns', 1, 'items', 0, 'changes'], value: [] }] });
  assert.equal(consumer()?.requests[0].acceptSupported, false);
  await assert.rejects(backend.command('synthetic', 'approval', { kind: 'file', requestId: 'file-request', decision: 'accept' }, 'unsupported-details'), { code: 'approval-details-unavailable' });
  const rows = session.view?.rows;
  native.emit({ type: 'patches', baseRevision: 3, revision: 4, patches: [{ op: 'replace', path: ['requests'], value: [] }] });
  assert.ok(session.view?.rows === rows);
  assert.deepEqual(consumer()?.requests, []);
  await assert.rejects(backend.command('synthetic', 'approval', { kind: 'file', requestId: 'file-request', decision: 'accept' }, 'removed-request'), { code: 'stale-approval' });
});

test('exact ordered content stamps cover untruncated output, revision and owner metadata', async (t) => {
  const state = longState(2, 2, 12000);
  const { native, consumer } = await start(t, state);
  const original = consumer()?.contentStamp;
  native.emit({ type: 'snapshot', conversationState: structuredClone(state), revision: 1 });
  assert.equal(consumer()?.contentStamp, original);
  state.turns[1].items[1].aggregatedOutput += 'suffix beyond any display window';
  native.emit({ type: 'snapshot', conversationState: state, revision: 1 });
  assert.notEqual(consumer()?.contentStamp, original);
  const changed = consumer()?.contentStamp;
  native.emit({ type: 'patches', baseRevision: 1, revision: 2, patches: [] });
  assert.notEqual(consumer()?.contentStamp, changed);
  native.callback?.({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'synthetic-owner-1', params: { hostId: 'local', change: { type: 'snapshot', conversationState: state, revision: 2 } } });
  const ownerStamp = consumer()?.contentStamp;
  assert.equal(consumer()?.ownerGeneration, 'local:synthetic-owner-1');
  native.callback?.({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'synthetic-owner-2', params: { hostId: 'local', change: { type: 'snapshot', conversationState: state, revision: 2 } } });
  assert.notEqual(consumer()?.contentStamp, ownerStamp);
});

/** Run only when requested; full published views are intentionally included. */
test('synthetic complete native receive/publish benchmark', { skip: !process.env.CODELIGHT_NATIVE_BENCHMARK }, async (t) => {
  const currentPath = new URL('../src/adapters/codex-backend.mjs', import.meta.url);
  const currentSource = await readFile(currentPath, 'utf8');
  /** @type {{name:string,Backend:typeof CodexBackend,hash:string}[]} */ const variants = [];
  if (process.env.CODELIGHT_NATIVE_BASELINE) {
    const source = await readFile(process.env.CODELIGHT_NATIVE_BASELINE, 'utf8');
    const resolved = source.replace(/from '(\.[^']+)'/g, (_match, relative) => `from '${new URL(relative, currentPath).href}'`);
    const module = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
    variants.push({ name: 'previous', Backend: module.CodexBackend, hash: createHash('sha256').update(source).digest('hex') });
  }
  variants.push({ name: 'current', Backend: CodexBackend, hash: createHash('sha256').update(currentSource).digest('hex') });
  const loaded = longState(1000, 20, 1024);
  const state = { threadRuntimeStatus: loaded.threadRuntimeStatus, requests: loaded.requests, latestModel: loaded.latestModel,
    turnHistory: { history: { islands: [{ entries: loaded.turns.map((turn) => ({ value: turn.turnId })) }], entitiesByKey: Object.fromEntries(loaded.turns.map((turn) => [turn.turnId, turn])) } } };
  const repetitions = 40;
  const snapshotWire = JSON.stringify(state);
  const results = [];
  for (const scenario of ['stdout', 'status', 'stdout-snapshot']) for (const { name, Backend, hash } of variants) {
    const { native, session, consumer, stop } = await start(t, state, Backend);
    globalThis.gc?.();
    const cpu = process.cpuUsage(); const heapBefore = process.memoryUsage().heapUsed; const began = performance.now();
    let observedHeapPeakBytes = heapBefore;
    let projectedItems = 0; let serializedRowBytes = 0;
    for (let index = 0; index < repetitions; index += 1) {
      const output = `complete output ${index} ${'z'.repeat(1024)}`;
      const patch = scenario === 'stdout' ? { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'turn-999', 'items', 19, 'aggregatedOutput'], value: output } :
        { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: index % 2 ? 'idle' : 'active' };
      if (scenario === 'stdout-snapshot') {
        const incoming = JSON.parse(snapshotWire);
        incoming.turnHistory.history.entitiesByKey['turn-999'].items[19].aggregatedOutput = output;
        native.emit({ type: 'snapshot', conversationState: incoming, revision: 1 });
      } else native.emit({ type: 'patches', baseRevision: index + 1, revision: index + 2, patches: [patch] });
      observedHeapPeakBytes = Math.max(observedHeapPeakBytes, process.memoryUsage().heapUsed);
      projectedItems += session.projection?.work.projectedItems ?? 0;
      serializedRowBytes += session.projection?.work.serializedRowBytes ?? 0;
    }
    const elapsedMs = performance.now() - began; const used = process.cpuUsage(cpu);
    assert.equal(consumer()?.rows.length, 20000);
    if (scenario !== 'status') assert.equal(consumer()?.rows.at(-1).tools[0].output, `complete output 39 ${'z'.repeat(1024)}`);
    else assert.equal(consumer()?.status, 'idle');
    globalThis.gc?.();
    results.push({ name, scenario, hash, elapsedMs, cpuMs: (used.user + used.system) / 1000, heapBeforeBytes: heapBefore, observedHeapGrowthBytes: observedHeapPeakBytes - heapBefore,
      retainedHeapDeltaBytes: globalThis.gc ? process.memoryUsage().heapUsed - heapBefore : null,
      projectedItems: name === 'current' ? projectedItems : null, serializedRowBytes: name === 'current' ? serializedRowBytes : null });
    stop(); globalThis.gc?.();
  }
  t.diagnostic(JSON.stringify({ node: process.version, canonicalHistory: true, turnCount: 1000, rows: 20000, stateBytes: Buffer.byteLength(snapshotWire), repetitions, completeConsumerClone: true, fullSnapshotJsonDecodeIncluded: true,
    heapMetric: 'observed peak growth and post-GC retained delta; not allocated bytes', results }));
});
