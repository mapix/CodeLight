import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeHappyConnector } from '../src/happy/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { BridgeError } from '../src/errors.mjs';
import { encryptRecord, decryptRecord } from '../src/happy/session-transport.mjs';
import { readObserverHistoryArchives } from '../src/happy/observer-history.mjs';

/** @typedef {Record<string,any>} Value */
class FixtureTransport extends EventEmitter {
  constructor() { super(); this.sessionId = 'happy-fixture'; this.inbox = /** @type {Value[]} */ ([]); this.records = /** @type {Value[]} */ ([]); this.handlers = /** @type {Map<string,(params:unknown)=>Promise<any>>} */ (new Map()); this.metadata = /** @type {Value} */ ({}); this.agentState = /** @type {Value} */ ({}); this.failPublication = false; this.pendingOutbox = 0; }
  async start() {}
  status() { return { pendingInbox: this.inbox.length, pendingOutbox: this.pendingOutbox }; }
  listInbox() { return structuredClone(this.inbox); }
  async ackInbox(/** @type {string} */ id) { this.inbox = this.inbox.filter(item => item.id !== id); }
  registerRpc(/** @type {string} */ method, /** @type {(params:unknown)=>Promise<any>} */ handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async updateMetadata(/** @type {(value:Value)=>Value} */ change) { this.metadata = change(this.metadata); }
  async updateAgentState(/** @type {(value:Value)=>Value} */ change) { this.agentState = change(this.agentState); }
  async publish(/** @type {string} */ localId, /** @type {Value} */ record) { let found = this.records.find(item => item.localId === localId); if (!found) { found = { localId, record: structuredClone(record) }; this.records.push(found); } else assert.deepEqual(found.record, record); if (this.failPublication) { this.failPublication = false; throw Error('fixture happy ack lost'); } return { id: `log-${localId}` }; }
  inject(/** @type {Value} */ record, /** @type {string} */ localId = 'phone-local', /** @type {string} */ id = 'happy-user-1') { this.inbox.push({ id, localId, seq: this.inbox.length + 1, record, publishedByThisTransport: false }); this.emit('record'); }
  async rpc(/** @type {string} */ method, /** @type {Value} */ params) { const handler = this.handlers.get(method); assert.ok(handler); return handler(params); }
}
class FixtureAdapter {
  supportsNativeModelSettings = false;
  completeReads = 0;
  constructor(/** @type {Value} */ view = {}) { this.view = /** @type {Value} */ ({ status: 'idle', currentTurnId: null, rows: [], requests: [], revision: 1, ...view }); this.calls = /** @type {Value[]} */ ([]); this.callback = /** @type {((view:Value)=>void)|null} */ (null); this.fail = false; this.noIdentity = false; this.beforeSnapshot = /** @type {(()=>void)|null} */ (null); }
  async snapshot(/** @type {string} */ _id) { this.beforeSnapshot?.(); return structuredClone(this.view); }
  async freshSnapshot(/** @type {string} */ nativeId) { return this.snapshot(nativeId); }
  async completeSnapshot(/** @type {string} */ nativeId) { this.completeReads++; this.view.historyComplete = true; return this.snapshot(nativeId); }
  async subscribe(/** @type {string} */ _id, /** @type {(view:Value)=>void} */ callback) { this.callback = callback; callback(structuredClone(this.view)); return () => { this.callback = null; }; }
  emit() { this.view.revision++; this.callback?.(structuredClone(this.view)); }
  /** @returns {Promise<Value>} */
  async command(/** @type {string} */ nativeId, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) {
    this.calls.push({ nativeId, action, payload, commandId });
    if (this.fail) throw new BridgeError('delivery-unknown', 'fixture lost native ACK after dispatch');
    if (action === 'send' || action === 'steer') { const turn = this.view.currentTurnId ?? `turn-${this.calls.length}`; this.view.currentTurnId = turn; this.view.status = 'active'; this.view.rows.push({ id: `native-${this.calls.length}`, role: 'user', text: payload.text, turnId: turn, status: 'inProgress', ...(this.noIdentity ? {} : { commandId }) }); this.emit(); return { acknowledged: true, turnId: turn }; }
    if (action === 'interrupt') { this.view.currentTurnId = null; this.view.status = 'idle'; this.emit(); return { interruptedTurnId: payload.turnId, acknowledged: true }; }
    if (action === 'approval') { this.view.requests = this.view.requests.filter((/** @type {Value} */ request) => request.kind !== payload.kind || request.requestId !== payload.requestId); this.emit(); return { acknowledged: true, ok: true }; }
    if (action === 'answer-question') { for (const row of this.view.rows) for (const question of row.asyncQuestions ?? []) if (question.questionItemId === payload.questionItemId) question.answered = true; this.emit(); return { acknowledged: true, ok: true }; }
    throw new BridgeError('unsupported-action', 'fixture unsupported');
  }
}
async function fixture(/** @type {Value} */ view = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'happy-native-fixture-')), transport = new FixtureTransport(), adapter = new FixtureAdapter(view);
  const receiptsPath = join(directory, 'receipts.json'); let epoch = 'owner-1', lease = true;
  const options = { transport, adapter, nativeId: 'original-native-id', sourceIdentity: { app: 'codex', id: 'original-native-id', hostId: 'local' }, bindingId: 'fixture-binding', metadata: { path: '', host: 'fixture', client: { id: 'noninvasive-bridge', name: 'Fixture', version: '1' } }, statePath: join(directory, 'connector.json'), encryptionKey: new Uint8Array(32).fill(9), getGeneration: () => epoch, assertLease: () => lease, admissionTimeoutMs: 25 };
  const create = async (/** @type {Value} */ overrides = {}) => new NativeHappyConnector({ ...options, ...overrides, receipts: await CommandReceipts.load(receiptsPath) });
  return { directory, transport, adapter, options, create, epoch: (/** @type {string} */ value) => { epoch = value; }, lease: (/** @type {boolean} */ value) => { lease = value; }, dispose: () => rm(directory, { recursive: true, force: true }) };
}
const user = (/** @type {string} */ text) => ({ role: 'user', content: { type: 'text', text } });
const events = (/** @type {FixtureTransport} */ transport) => transport.records.map(item => item.record.content);

test('an accepted native row publishes and retains the old steering wire identities in fresh seeds', async () => {
  const f = await fixture({ rows: [{ id: 'temporary-steering-uuid', role: 'user', text: 'Original input', turnId: 'original-turn', commandId: 'original-caller' }] });
  const connector = await f.create();
  try {
    await connector.start(); const oldWire = events(f.transport).find(event => event.ev.t === 'text').id;
    f.adapter.view.rows = [{ id: 'accepted-user-row', role: 'user', text: 'Original input', turnId: 'original-turn', commandId: 'original-caller', replaceSourceRowIds: ['temporary-steering-uuid'] }]; f.adapter.view.revision++;
    await connector.project(f.adapter.view);
    const update = events(f.transport).find(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'accepted-user-row');
    assert.ok(update); assert.ok(update.ev.replaceIds.includes(oldWire));
    const recent = await connector.readRecent({ limit: 20 });
    assert.ok(recent.rows[0].replaceIds.includes(oldWire)); assert.deepEqual(recent.rows[0].replaceSourceRowIds, ['temporary-steering-uuid']);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('a near-capacity legacy checkpoint archives acknowledged bodies and old prefixes without replaying unknown commands', async () => {
  const f = await fixture({ rows: [{ id: 'current-row', role: 'assistant', text: 'Current', turnId: 'current-turn', status: 'completed' }] });
  let connector = await f.create({ recentRowLimit: 2 });
  try {
    await connector.start(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8')), state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    const prefix = 'P'.repeat(11 * 1024 * 1024), body = 'B'.repeat(1024 * 1024);
    const legacy = Array.from({ length: 15 }, (_, index) => ({ id: `legacy-acked-event-${index}`, localId: `legacy-acked-event-${index}-observed`, ciphertext: encryptRecord({ role: 'session', content: { ev: { t: 'text', text: body } } }, f.options.encryptionKey), sent: true }));
    state.events.push(...legacy);
    state.rows.push({ id: 'old-row', role: 'assistant', turnId: 'old-turn', text: prefix,
      digest: createHmac('sha256', f.options.encryptionKey).update(JSON.stringify(prefix)).digest('hex'), eventIds: legacy.map(event => event.id), revision: 3, rowIdentityVersion: 1 });
    const unknown = { id: 'old-unknown-reply', origin: 'rpc', action: 'answer-question', payload: { questionItemId: 'old-question', answer: 'original draft' }, epoch: 'previous-owner', state: 'unknown', error: 'delivery-unknown' };
    state.commands.push(unknown); delete state.activeRowIds;
    const originalEvents = structuredClone(state.events);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) < 32 * 1024 * 1024);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', f.options.encryptionKey, nonce), encoded = Buffer.from(JSON.stringify(state));
    file.ciphertext = Buffer.concat([Buffer.from([0]), nonce, cipher.update(encoded), cipher.final(), cipher.getAuthTag()]).toString('base64'); await writeFile(f.options.statePath, JSON.stringify(file));
    f.adapter.view.rows.push({ id: 'new-row', role: 'assistant', text: 'N'.repeat(1024 * 1024), turnId: 'current-turn', status: 'completed' }); f.adapter.view.revision++;
    connector = await f.create({ recentRowLimit: 2 }); await connector.start();
    let hot = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.ok(Buffer.byteLength(JSON.stringify(hot)) < 8 * 1024 * 1024);
    assert.deepEqual(hot.commands.find((/** @type {Value} */ command) => command.id === unknown.id), unknown);
    assert.deepEqual(hot.rows.find((/** @type {Value} */ row) => row.id === 'old-row').eventIds, legacy.map(event => event.id));
    const history = await readObserverHistoryArchives(hot, f.options.statePath, f.options.encryptionKey);
    for (const event of originalEvents) assert.deepEqual(history.events.find(saved => saved.id === event.id), event);
    const oldRow = history.rows.find(row => row.id === 'old-row'); assert.ok(oldRow); assert.equal(oldRow.text, prefix);
    assert.equal(f.transport.records.some(item => legacy.some(event => item.localId === event.localId)), false);
    f.adapter.view.rows = [{ id: 'old-row', role: 'assistant', text: prefix + ' extended', turnId: 'old-turn', status: 'completed' }]; f.adapter.view.revision++;
    await connector.project(f.adapter.view);
    const delta = events(f.transport).filter(event => event.ev.t === 'text').at(-1);
    assert.ok(delta);
    assert.equal(delta.ev.text, ' extended');
    hot = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.equal(hot.rows.find((/** @type {Value} */ row) => row.id === 'old-row').text, prefix + ' extended');
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an identical full snapshot with empty bootstrap does not rewrite the encrypted checkpoint', async () => {
  const f = await fixture({ contentStamp: 'unchanged-public-view', rows: [{ id: 'stable-row', role: 'assistant', text: 'Stable content', turnId: 'stable-turn', status: 'completed' }] });
  const connector = await f.create();
  try { await connector.start(); const before = await readFile(f.options.statePath, 'utf8');
    await connector.project(f.adapter.view); await connector.project(f.adapter.view);
    assert.equal(await readFile(f.options.statePath, 'utf8'), before);
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown question replies recover only from the accepted original command ID under the same epoch', async () => {
  const f = await fixture({ rows: [{ id: 'question-row', role: 'assistant', text: '', turnId: 'question-turn', asyncQuestions: [{ questionItemId: 'strict-question', title: 'Choose', options: ['A'], answered: false }] }] });
  const connector = await f.create();
  try {
    await connector.start(); f.adapter.fail = true;
    const id = 'strict-question-answer', key = Object.keys(f.transport.agentState.communications)[0];
    await assert.rejects(f.transport.rpc('communication', { commandId: id, id: key, status: 'answered', answers: { answer: { options: ['A'] } } }));
    f.adapter.view.rows.push({ id: 'pending-steer', role: 'user', text: 'Choose\nA', commandId: id, turnId: 'question-turn', inputStatus: 'pending' });
    await connector.project(f.adapter.view);
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId: id })).receipt.status, 'unknown');
    f.adapter.view.rows.at(-1).inputStatus = 'accepted';
    await connector.project(f.adapter.view);
    const recovered = (await f.transport.rpc('bridge-receipt', { commandId: id })).receipt;
    assert.equal(recovered.status, 'complete'); assert.equal(recovered.nativeReceiptStatus, 'unknown'); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('text suffixes preserve native identity and confirmed user rows replace provisional echoes', async () => {
  const f = await fixture({ currentTurnId: 'turn-1', status: 'active', rows: [{ id: 'assistant-row', role: 'assistant', text: 'Hello', turnId: 'turn-1', status: 'inProgress' }] });
  const connector = await f.create();
  try {
    await connector.start();
    f.adapter.view.rows[0].text += ' world'; await connector.project(f.adapter.view);
    const text = f.transport.records.filter(item => item.record.content.ev.t === 'text');
    assert.deepEqual(text.map(item => item.record.meta.nativeRow), [{ id: 'assistant-row', offset: 0, revision: 0 }, { id: 'assistant-row', offset: 5, revision: 0 }]);
    f.adapter.view.rows.push({ id: 'pending-user:client-id', role: 'user', text: 'Reply', commandId: 'client-id', turnId: 'turn-1' });
    await connector.project(f.adapter.view);
    const provisional = events(f.transport).find(event => event.ev.t === 'text' && event.ev.text === 'Reply'); assert.ok(provisional);
    f.adapter.view.rows[1] = { id: 'confirmed-user', role: 'user', text: 'Reply', commandId: 'client-id', turnId: 'turn-1' };
    await connector.project(f.adapter.view);
    const replacement = events(f.transport).find(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'confirmed-user');
    assert.ok(replacement); assert.ok(replacement.ev.replaceIds.includes(provisional.id));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('unchanged legacy text receives one full identity replacement without replaying commands', async () => {
  const f = await fixture({ rows: [{ id: 'legacy-row', role: 'assistant', text: 'Existing complete text', turnId: 'turn-1', status: 'completed' }] });
  let connector = await f.create();
  try {
    await connector.start(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    const state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    for (const row of state.rows) delete row.rowIdentityVersion;
    file.ciphertext = encryptRecord(state, f.options.encryptionKey);
    await writeFile(f.options.statePath, JSON.stringify(file));
    connector = await f.create(); await connector.start(); await connector.project(f.adapter.view);
    const replacements = events(f.transport).filter(event => event.ev.t === 'native-row-upsert' && event.ev.sourceRowId === 'legacy-row');
    assert.equal(replacements.length, 1); assert.equal(replacements[0].ev.text, 'Existing complete text');
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('a fresh own input supplies broker and local aliases instead of creating another phone user message', async () => {
  const f = await fixture(); const connector = await f.create();
  try {
    await connector.start(); f.transport.inject(user('Own phone input'), 'phone-local-alias', 'server-user-alias');
    await connector.processInbox();
    const recent = await connector.readRecent();
    const own = recent.rows.find((/** @type {Value} */ row) => row.role === 'user'); assert.ok(own);
    assert.ok(own.replaceIds.includes('server-user-alias')); assert.ok(own.replaceIds.includes('phone-local-alias'));
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('recent native reads return complete rows and advance seed version for changed same-revision snapshots without commands', async () => {
  const f = await fixture({ currentTurnId: 'original-turn', status: 'active', rows: [{ id: 'native-text', role: 'assistant', text: 'complete base', turnId: 'original-turn', at: 10, status: 'inProgress' }] });
  const connector = await f.create();
  try {
    const first = await connector.readRecent();
    assert.equal(first.rows[0].text, 'complete base'); assert.ok(first.rows[0].replaceIds.length > 0);
    f.adapter.view.rows[0].text += ' and current suffix'; // The original silent snapshot revision intentionally stays 1.
    const second = await connector.readRecent();
    assert.equal(second.revision, first.revision); assert.equal(second.rows[0].text, 'complete base and current suffix');
    assert.ok(second.rows[0].snapshotRevision > first.rows[0].snapshotRevision);
    assert.equal(second.rows[0].streamRevision, first.rows[0].streamRevision); assert.equal(f.adapter.calls.length, 0);
    assert.equal(connector.status().activeOperations, 0);
  } finally { await connector.close(); await f.dispose(); }
});
test('bounded real observation retains full history evidence without publishing older rows or loading history on entry', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: `native-${index}`, role: 'assistant', text: `complete-${index}`, turnId: 'original-turn', at: index, status: 'completed' }));
  const f = await fixture({ rows, historyComplete: false }); Object.assign(f.options, { recentRowLimit: 100 });
  const connector = await f.create();
  try {
    const first = await connector.readRecent();
    assert.equal(first.rows[0].id, 'native-150'); assert.equal(f.adapter.completeReads, 0);
    assert.equal(events(f.transport).filter(event => event.ev.t === 'text').length, 100);
    const older = await connector.readRecent({ fresh: false, cursor: first.nextCursor });
    assert.equal(f.adapter.completeReads, 1); assert.equal(older.historyComplete, true);
    const earlier = await connector.readRecent({ fresh: false, cursor: older.nextCursor });
    assert.equal(earlier.rows[0].id, 'native-50'); assert.equal(f.adapter.completeReads, 1);
    assert.equal(events(f.transport).filter(event => event.ev.t === 'text').length, 100);
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('RPC identity includes the method and cannot reinterpret an open receipt as a successful abort', async () => {
  const f = await fixture({ currentTurnId: 'original-turn' });
  f.adapter.command = async (/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ action, payload, commandId }); return { requested: true };
  };
  const connector = await f.create();
  try {
    await connector.start(); const params = { commandId: 'same-id-different-method', turnId: 'original-turn' };
    await f.transport.rpc('open-desktop', params);
    await assert.rejects(f.transport.rpc('abort', params), { code: 'command-conflict' });
    assert.equal(f.adapter.calls.length, 1); assert.equal(f.adapter.calls[0].action, 'open-desktop');
  } finally { await connector.close(); await f.dispose(); }
});

test('native controls read publishes original settings and model writes retain CAS, receipt and epoch boundaries', async () => {
  const f = await fixture({ currentTurnId: 'active-original-turn', status: 'active' }); f.adapter.supportsNativeModelSettings = true;
  const controls = { model: { available: true, current: { model: 'model-A', reasoningEffort: 'medium', modelProvider: 'fixture' }, models: [{ id: 'model-A', label: 'A', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }, { id: 'model-B', label: 'B', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }], catalogSource: 'fixture' } };
  f.adapter.command = async (/** @type {string} */ nativeId, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ nativeId, action, payload, commandId });
    if (action === 'read-controls') return structuredClone(controls);
    if (action !== 'update-settings') throw new BridgeError('unsupported-action', 'fixture');
    if (f.adapter.fail) throw new BridgeError('delivery-unknown', 'fixture lost settings ACK');
    if (payload.expectedModel !== controls.model.current.model || payload.expectedReasoningEffort !== controls.model.current.reasoningEffort) throw new BridgeError('settings-conflict', 'fixture stale choice');
    controls.model.current = { ...controls.model.current, model: payload.model, reasoningEffort: payload.reasoningEffort }; return { acknowledged: true, applied: true, settingsReadbackConfirmed: true, controls: structuredClone(controls) };
  };
  const connector = await f.create();
  try {
    await connector.start(); await f.transport.rpc('codex-controls-read', { commandId: 'read-original-controls' });
    assert.equal(f.transport.metadata.nativeControls.model.current.model, 'model-A'); assert.equal(f.transport.metadata.capabilities.modelSelection, true);
    const params = { commandId: 'model-choice-stable', model: 'model-B', reasoningEffort: 'low', expectedModel: 'model-A', expectedReasoningEffort: 'medium' };
    await f.transport.rpc('codex-controls-update', params); await f.transport.rpc('codex-controls-update', params);
    assert.equal(f.adapter.calls.filter(c => c.action === 'update-settings').length, 1); assert.equal(f.adapter.view.currentTurnId, 'active-original-turn');
    await assert.rejects(f.transport.rpc('codex-controls-update', { ...params, commandId: 'model-choice-extra-field', cwd: '/never-change' }), { code: 'invalid-settings' });
    await assert.rejects(f.transport.rpc('codex-controls-update', { ...params, commandId: 'model-choice-stale' }), { code: 'settings-conflict' });
    f.adapter.fail = true; const lost = { ...params, commandId: 'model-choice-unknown', expectedModel: 'model-B', expectedReasoningEffort: 'low' };
    await assert.rejects(f.transport.rpc('codex-controls-update', lost), { code: 'delivery-unknown' });
    const count = f.adapter.calls.filter(c => c.action === 'update-settings').length;
    await assert.rejects(f.transport.rpc('codex-controls-update', lost), { code: 'delivery-unknown' }); assert.equal(f.adapter.calls.filter(c => c.action === 'update-settings').length, count);
  } finally { await connector.close(); await f.dispose(); }
});

test('applied model settings with lost readback reconcile the original unknown ID using same-owner reads only', async () => {
  const f = await fixture(); f.adapter.supportsNativeModelSettings = true;
  const controls = { model: { available: true, current: { model: 'model-A', reasoningEffort: 'medium', modelProvider: 'fixture' }, models: [], catalogSource: 'fixture' } };
  let writes = 0;
  f.adapter.command = async (/** @type {string} */ _nativeId, /** @type {string} */ action, /** @type {Value} */ payload) => {
    if (action === 'read-controls') return structuredClone(controls);
    if (action !== 'update-settings') throw new BridgeError('unsupported-action', 'fixture');
    writes++; controls.model.current = { ...controls.model.current, model: payload.model, reasoningEffort: payload.reasoningEffort };
    return { applied: true, acknowledged: false, settingsReadbackConfirmed: false };
  };
  let connector = await f.create();
  const params = { commandId: 'applied-settings-lost-readback', model: 'model-B', reasoningEffort: 'low', expectedModel: 'model-A', expectedReasoningEffort: 'medium' };
  try {
    await connector.start(); await assert.rejects(f.transport.rpc('codex-controls-update', params), { code: 'delivery-unknown' });
    const recovered = await f.transport.rpc('bridge-receipt', { commandId: params.commandId });
    assert.equal(recovered.receipt.id, params.commandId); assert.equal(recovered.receipt.status, 'complete'); assert.equal(recovered.receipt.nativeReceiptStatus, 'unknown'); assert.equal(writes, 1);
    await f.transport.rpc('codex-controls-update', params); assert.equal(writes, 1);
    await connector.close(); connector = await f.create(); await connector.start();
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId: params.commandId })).receipt.status, 'complete');
    await f.transport.rpc('codex-controls-update', params); assert.equal(writes, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('a legacy methodless RPC checkpoint migrates only its frozen original method without native replay', async () => {
  const f = await fixture();
  f.adapter.command = async (/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ action, payload, commandId }); return { requested: true };
  };
  let connector = await f.create();
  const params = { commandId: 'legacy-open-receipt' };
  try {
    await connector.start(); await f.transport.rpc('open-desktop', params); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    const old = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    const command = old.commands.find((/** @type {Value} */ saved) => saved.id === params.commandId);
    delete command.rpcMethod; command.requestDigest = createHmac('sha256', f.options.encryptionKey).update(JSON.stringify(params)).digest('hex');
    file.ciphertext = encryptRecord(old, f.options.encryptionKey);
    await writeFile(f.options.statePath, JSON.stringify(file), { mode: 0o600 });
    connector = await f.create(); await connector.start(); await f.transport.rpc('open-desktop', params);
    await assert.rejects(f.transport.rpc('abort', params), { code: 'command-conflict' });
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('window source has only explicit controls and never treats a phone message as Agent input', async () => {
  const f = await fixture({ kind: 'window', status: 'active', textInputAvailable: false, semanticControlAvailable: true, coordinateControlAvailable: true,
    captureStamp: { runtimeGeneration: 'owner-1', windowGeneration: 'window-1', layoutGeneration: 'layout-1', imageLayoutHash: 'image-1' }, bounds: { width: 600, height: 400 }, imageRef: 'test-encrypted-ref', controls: [] });
  f.options.sourceIdentity.app = 'terminal';
  f.adapter.command = async (/** @type {string} */ _id, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    f.adapter.calls.push({ action, payload, commandId }); return { acknowledged: true };
  };
  const connector = await f.create();
  try {
    await connector.start();
    assert.equal(f.transport.metadata.capabilities.messageReceipts, true);
    assert.ok(f.transport.metadata.capabilities.rpcMethods.includes('window-control'));
    assert.equal(f.transport.agentState.windowObservation.imageRef, 'test-encrypted-ref');
    f.transport.inject(user('cannot inject into a terminal')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
    await assert.rejects(f.transport.rpc('window-control', { commandId: 'terminal-no-type', action: 'type', payload: { nodeId: 'fake', text: 'never injected' } }), { code: 'unsupported-action' });
    assert.equal(f.adapter.calls.length, 0);
    const click = { commandId: 'window-click-once', action: 'click', payload: { captureStamp: f.adapter.view.captureStamp, x: 5, y: 6 } };
    await f.transport.rpc('window-control', click); await f.transport.rpc('window-control', click); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('an idle source without an existing owner keeps observation available and never creates another runtime', async () => {
  const f = await fixture({ status: 'owner-unavailable' });
  f.adapter.subscribe = async () => { throw new BridgeError('codex-owner-unavailable', 'No original owner is loaded.'); };
  const connector = await f.create();
  try { await connector.start(); assert.equal(connector.status().sourceStatus, 'owner-unavailable'); assert.equal(f.transport.metadata.capabilities.steering, false); assert.equal(f.adapter.calls.length, 0); }
  finally { await connector.close(); await f.dispose(); }
});

test('bootstrap identity initializes prefix, Unicode suffix publishes once and nonprefix is explicit replacement', async () => {
  const row = { id: 'row-a', role: 'assistant', text: 'Hello', turnId: 'native-turn', status: 'inProgress' }, f = await fixture({ rows: [row], currentTurnId: 'native-turn', status: 'active' });
  const bootstrap = 'ni' + createHash('sha256').update(`original-native-id:${row.id}:bootstrap`).digest('hex').slice(0, 28);
  f.transport.inbox.push({ id: 'bootstrap-log', localId: bootstrap + '-observed', record: { role: 'session', content: { id: bootstrap, time: 100, role: 'agent', turn: row.turnId, ev: { t: 'text', text: row.text } } } });
  const connector = await f.create();
  try { await connector.start(); assert.equal(events(f.transport).filter(item => item.ev.t === 'text').length, 0);
    f.adapter.view.rows[0].text = 'Hello 😀\n中文'; await connector.project(f.adapter.view);
    assert.equal(events(f.transport).find(item => item.ev.t === 'text')?.ev.text, ' 😀\n中文'); const before = f.transport.records.length; await connector.project(f.adapter.view); assert.equal(f.transport.records.length, before);
    f.adapter.view.rows[0].text = 'corrected text'; await connector.project(f.adapter.view);
    const replacements = events(f.transport).filter(item => item.ev.t === 'native-row-upsert');
    assert.ok(replacements[0].ev.replaceIds.includes(bootstrap));
    const replace = replacements.at(-1); assert.ok(replace); assert.equal(replace.ev.text, 'corrected text');
    assert.ok(replace.ev.replaceIds.includes(replacements[0].id)); assert.equal(connector.status().projectionStatus, 'resync-required'); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('native input called once, accepted references Happy server id/real turn, own echo is correlated by commandId', async () => {
  const f = await fixture(); let connector = await f.create();
  try { await connector.start(); f.transport.inject(user('own Happy message')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    const accepted = events(f.transport).find(item => item.ev.t === 'user-message-accepted'); assert.ok(accepted); assert.equal(accepted.ev.ref, 'happy-user-1'); assert.equal(accepted.ev.runId, 'turn-1');
    assert.equal(events(f.transport).filter(item => item.role === 'user' && item.ev.t === 'text').length, 0);
    await connector.close(); connector = await f.create(); await connector.start(); f.transport.inject(user('own Happy message')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    assert.ok(!(await readFile(f.options.statePath, 'utf8')).includes('own Happy message'));
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown native dispatch survives restart without retry and does not emit fake accepted/rejected', async () => {
  const f = await fixture(); f.adapter.fail = true; let connector = await f.create();
  try { await connector.start(); f.transport.inject(user('unknown request')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    const command = f.adapter.calls[0].commandId; assert.equal((await f.transport.rpc('bridge-receipt', { commandId: command })).receipt.status, 'unknown');
    assert.equal(events(f.transport).filter(item => ['user-message-accepted', 'user-message-rejected'].includes(item.ev.t)).length, 0);
    assert.equal(events(f.transport).filter(item => item.ev.t === 'user-message-delivery-unknown').length, 1);
    await connector.close(); connector = await f.create(); await connector.start(); f.transport.inject(user('unknown request')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown message receipt is stable across restart and late exact native identity confirms it without redispatch', async () => {
  const f = await fixture(); f.adapter.fail = true; let connector = await f.create();
  try {
    await connector.start(); f.transport.inject(user('late-confirmation')); await connector.processInbox();
    const commandId = f.adapter.calls[0].commandId;
    const unknown = events(f.transport).find(item => item.ev.t === 'user-message-delivery-unknown');
    assert.ok(unknown); assert.equal(unknown.ev.ref, 'happy-user-1'); assert.equal(unknown.ev.commandId, commandId);
    await connector.close(); connector = await f.create(); await connector.start();
    f.transport.inject(user('late-confirmation')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 1);
    assert.deepEqual(events(f.transport).filter(item => item.ev.t === 'user-message-delivery-unknown'), [unknown]);
    f.adapter.view.rows.push({ id: 'original-late-row', role: 'user', text: 'late-confirmation', commandId, turnId: 'original-late-turn', status: 'completed' });
    await connector.project(f.adapter.view);
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'complete');
    const accepted = events(f.transport).filter(item => item.ev.t === 'user-message-accepted');
    assert.equal(accepted.length, 1); assert.equal(accepted[0].ev.ref, 'happy-user-1'); assert.equal(accepted[0].ev.runId, 'original-late-turn');
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('a failed pending user row without a turn ID never confirms input, including an old saved false confirmation', async () => {
  const f = await fixture(); let connector = await f.create();
  f.adapter.command = async (nativeId, action, payload, commandId) => {
    f.adapter.calls.push({ nativeId, action, payload, commandId });
    f.adapter.view.rows.push({ id: `pending-user:${commandId}`, role: 'user', text: payload.text, commandId, turnId: null, status: 'failed' });
    f.adapter.emit();
    throw new BridgeError('delivery-unknown', 'fixture cloud-only admission rejected before turn allocation');
  };
  try {
    await connector.start(); f.transport.inject(user('fixture pending input')); await connector.processInbox();
    const commandId = f.adapter.calls[0].commandId;
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    assert.equal(events(f.transport).filter(item => item.ev.t === 'user-message-accepted').length, 0);
    await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    const saved = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    saved.commands[0].admission = { confirmed: true, turnId: null, messageId: `pending-user:${commandId}`, queued: false };
    file.ciphertext = encryptRecord(saved, f.options.encryptionKey);
    await writeFile(f.options.statePath, JSON.stringify(file), { mode: 0o600 });
    connector = await f.create(); await connector.start();
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    assert.equal(f.adapter.calls.length, 1);
    assert.equal(events(f.transport).filter(item => item.ev.t === 'user-message-accepted').length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an acknowledged result with matching text but no native identity remains unknown; unrelated same-text rows are preserved', async () => {
  const f = await fixture(); f.adapter.noIdentity = true; const connector = await f.create();
  try { await connector.start(); f.transport.inject(user('same text')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 1);
    const receipt = await f.transport.rpc('bridge-receipt', { commandId: f.adapter.calls[0].commandId }); assert.equal(receipt.receipt.status, 'unknown');
    await connector.project(f.adapter.view); assert.equal(events(f.transport).filter(item => item.role === 'user' && item.ev.text === 'same text').length, 1);
    assert.equal(events(f.transport).some(item => item.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('epoch changes during fresh snapshot and lost lease fence native side effects', async () => {
  const f = await fixture(), connector = await f.create();
  try { await connector.start(); f.adapter.beforeSnapshot = () => f.epoch('owner-2'); f.transport.inject(user('fenced epoch')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
    f.adapter.beforeSnapshot = null; f.lease(false); f.transport.inject(user('fenced lease'), 'phone-second', 'happy-second'); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
    assert.ok(events(f.transport).some(item => item.ev.t === 'user-message-rejected'));
  } finally { await connector.close(); await f.dispose(); }
});

test('abort requires the foreground current turn, ignores background-running status, and repeats reuse original receipt', async () => {
  const f = await fixture({ status: 'running', currentTurnId: null }), connector = await f.create();
  try { await connector.start(); await assert.rejects(f.transport.rpc('abort', { commandId: 'abort-original-1', turnId: 'background-turn' }), { code: 'stale-turn' }); assert.equal(f.adapter.calls.length, 0);
    f.adapter.view.currentTurnId = 'foreground-turn'; await connector.project(f.adapter.view);
    const params = { commandId: 'abort-original-2', turnId: 'foreground-turn' }; await f.transport.rpc('abort', params); await f.transport.rpc('abort', params);
    const reply = await f.transport.rpc('abort', params); assert.equal(reply.receipt.id, params.commandId); assert.equal(reply.receipt.commandId, params.commandId);
    assert.equal(f.adapter.calls.length, 1); assert.deepEqual(f.adapter.calls[0].payload, { turnId: 'foreground-turn' });
  } finally { await connector.close(); await f.dispose(); }
});

test('permission mapping keeps typed original id and rejects unsupported grants; communication uses real question identity', async () => {
  const f = await fixture({ requests: [{ requestId: 8, kind: 'command', operable: true, command: 'fixture command', acceptSupported: false, allowedActions: ['decline', 'cancel'] }], rows: [{ id: 'question-row', role: 'assistant', text: '', turnId: 'turn-question', asyncQuestions: [{ questionItemId: 'original-question-item', title: 'Question?', options: ['A'], answered: false }] }] }), connector = await f.create();
  try { await connector.start(); const requestKey = Object.keys(f.transport.agentState.requests)[0];
    await assert.rejects(f.transport.rpc('permission', { commandId: 'permission-denied-1', id: requestKey, approved: true }), { code: 'unsupported-approval' }); assert.equal(f.adapter.calls.length, 0);
    await f.transport.rpc('permission', { commandId: 'permission-decline-1', id: requestKey, approved: false }); assert.equal(f.adapter.calls[0].payload.requestId, 8); assert.equal(typeof f.adapter.calls[0].payload.requestId, 'number');
    const questionKey = Object.keys(f.transport.agentState.communications)[0];
    await f.transport.rpc('communication', { commandId: 'question-answer-1', id: questionKey, status: 'answered', answers: { answer: { options: [], custom: '中文😀' } } });
    assert.deepEqual(f.adapter.calls[1].payload, { questionItemId: 'original-question-item', answer: '中文😀' });
    assert.deepEqual([...f.transport.handlers.keys()], ['abort', 'permission', 'communication', 'bridge-receipt', 'open-desktop', 'window-control']);
  } finally { await connector.close(); await f.dispose(); }
});

test('projection plans keep id/time/body across Happy ACK loss and reconnect', async () => {
  const f = await fixture({ rows: [{ id: 'stable-row', role: 'assistant', text: 'stable output', turnId: 'stable-turn', status: 'inProgress' }] }); let connector = await f.create(); f.transport.failPublication = true;
  try { await assert.rejects(connector.start()); const captured = structuredClone(f.transport.records[0]); await connector.close();
    connector = await f.create(); await connector.start(); assert.deepEqual(f.transport.records[0], captured); assert.equal(f.transport.records.filter(item => item.localId === captured.localId).length, 1); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('tool output is not marked complete while running; terminal output precedes native turn end', async () => {
  const f = await fixture({ currentTurnId: 'tool-turn', status: 'active', rows: [{ id: 'tool-row', role: 'tool', text: '', turnId: 'tool-turn', status: 'inProgress', tools: [{ id: 'original-tool-id', name: 'Fixture', output: '', status: 'inProgress' }] }] }), connector = await f.create();
  try { await connector.start(); f.adapter.view.rows[0].tools[0].output = 'partial'; await connector.project(f.adapter.view); assert.equal(events(f.transport).some(item => item.ev.t === 'tool-call-end'), false);
    f.adapter.view.rows[0].tools[0] = { id: 'original-tool-id', name: 'Fixture', output: 'complete output', status: 'completed' }; f.adapter.view.rows[0].status = 'completed'; f.adapter.view.currentTurnId = null; await connector.project(f.adapter.view);
    const stream = events(f.transport); assert.ok(stream.findIndex(item => item.ev.t === 'tool-call-end') < stream.findIndex(item => item.ev.t === 'turn-end')); assert.equal(stream.find(item => item.ev.t === 'tool-call-end').ev.result, 'complete output');
  } finally { await connector.close(); await f.dispose(); }
});

test('phone communications retire old turns and do not reopen history after the current answer', async () => {
  const currentQuestion = { questionItemId: 'current-question', title: 'Current question', options: ['A'], answered: false };
  const f = await fixture({ currentTurnId: 'current-turn', latestTurnId: 'current-turn', rows: [
    { id: 'old-row', role: 'assistant', text: '', turnId: 'old-turn', asyncQuestions: [{ questionItemId: 'old-question', title: 'Old question', answered: false }] },
    { id: 'current-row', role: 'assistant', text: '', turnId: 'current-turn', asyncQuestions: [currentQuestion] },
  ] }), connector = await f.create();
  try {
    await connector.start();
    const keys = Object.keys(f.transport.agentState.communications);
    assert.equal(keys.length, 1); assert.equal(f.transport.agentState.communications[keys[0]].title, 'Current question');
    currentQuestion.answered = true; f.adapter.emit();
    await connector.project(f.adapter.view);
    assert.equal(Object.keys(f.transport.agentState.communications).length, 0);
    assert.equal(f.adapter.view.rows[0].asyncQuestions[0].answered, false);
    await assert.rejects(f.transport.rpc('communication', { commandId: 'late-current-answer', id: keys[0], status: 'answered', answers: { answer: { options: ['A'], custom: '' } } }));
    assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('bootstrap observations survive initial source unavailable and seed later exact rows without double history', async () => {
  const row = { id: 'later-row', role: 'assistant', text: 'original history', turnId: 'old-turn', status: 'completed' }, f = await fixture({ status: 'owner-unavailable' });
  const bootstrap = 'ni' + createHash('sha256').update(`original-native-id:${row.id}:bootstrap`).digest('hex').slice(0, 28);
  f.transport.inbox.push({ id: 'bootstrap-later', localId: bootstrap + '-observed', record: { role: 'session', content: { id: bootstrap, time: 10, role: 'agent', turn: row.turnId, ev: { t: 'text', text: row.text } } } });
  const connector = await f.create();
  try { await connector.start(); assert.equal(f.transport.inbox.length, 0); f.adapter.view = { status: 'idle', currentTurnId: null, requests: [], rows: [row], revision: 5 }; await connector.project(f.adapter.view);
    assert.equal(events(f.transport).filter(item => item.ev.t === 'text').length, 0); assert.equal(f.adapter.calls.length, 0);
    const before = f.transport.records.length; await connector.project({ ...f.adapter.view, revision: 4, rows: [{ ...row, text: 'stale altered text' }] }); assert.equal(f.transport.records.length, before);
  } finally { await connector.close(); await f.dispose(); }
});

test('missing generation/lease and window-only sources expose honest capabilities and never native text admission', async () => {
  const f = await fixture({ kind: 'window', rows: [], requests: [], status: 'connected', currentTurnId: null }), connector = await f.create();
  try { await connector.start(); assert.equal(f.transport.metadata.bridge.controlMode, 'window'); assert.equal(f.transport.metadata.capabilities.abort, false); assert.equal(f.transport.metadata.capabilities.messageReceipts, true);
    f.transport.inject(user('do not turn this window into a fake native chat')); await connector.processInbox(); assert.equal(f.adapter.calls.length, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('an unknown RPC repeated with the same id remains unknown and never becomes a successful reply', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'live-turn' }), connector = await f.create(); f.adapter.fail = true;
  try { await connector.start(); const params = { commandId: 'unknown-abort-same-id', turnId: 'live-turn' };
    await assert.rejects(f.transport.rpc('abort', params), { code: 'delivery-unknown', effectMayHaveOccurred: true });
    await assert.rejects(f.transport.rpc('abort', params), { code: 'delivery-unknown', effectMayHaveOccurred: true });
    assert.equal(f.adapter.calls.length, 1);
  } finally { await connector.close(); await f.dispose(); }
});

test('source RPC keeps sanitized nativeCause in public receipt and reloads unknown without another effect', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'live-turn' }); let connector = await f.create(), effects = 0;
  f.adapter.command = async () => { effects++; throw Object.assign(new BridgeError('delivery-unknown', 'raw details never published'), { nativeCause: 'window_focus_unconfirmed' }); };
  const params = { commandId: 'cause-source-rpc-once', turnId: 'live-turn' };
  try {
    await connector.start();
    await assert.rejects(f.transport.rpc('abort', params), error => {
      const value = /** @type {Value} */ (error); assert.equal(value.code, 'delivery-unknown'); assert.equal(value.receipt.nativeCause, 'window_focus_unconfirmed'); return true;
    });
    const before = (await f.transport.rpc('bridge-receipt', { commandId: params.commandId })).receipt;
    assert.equal(before.nativeCause, 'window_focus_unconfirmed'); assert.equal(before.status, 'unknown');
    await connector.close(); connector = await f.create(); await connector.start();
    const after = (await f.transport.rpc('bridge-receipt', { commandId: params.commandId })).receipt;
    assert.deepEqual(after, before);
    await assert.rejects(f.transport.rpc('abort', params), { code: 'delivery-unknown' }); assert.equal(effects, 1);
    assert.ok(!JSON.stringify(after).includes('raw details'));
  } finally { await connector.close(); await f.dispose(); }
});

test('existing Root confirmed admission repairs a lost connector terminal write without native redispatch', async () => {
  const f = await fixture({ status: 'owner-unavailable' });
  const receipts = await CommandReceipts.load(join(f.directory, 'receipts.json'));
  const connector = new NativeHappyConnector({ ...f.options, receipts });
  const nativeCommandId = 'hc' + createHash('sha256').update(JSON.stringify(['fixture-binding', 'phone-local', 'send'])).digest('hex').slice(0, 62);
  await receipts.run(connector.receiptScope, nativeCommandId, { action: 'send', payload: { text: 'already admitted before connector crashed' }, epoch: 'owner-1', expectedTurnId: null }, async () => ({ nativeAdmission: { confirmed: true, turnId: 'previous-real-fixture-turn', messageId: 'previous-fixture-user' } }));
  try { await connector.start(); f.transport.inject(user('already admitted before connector crashed')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 0); const accepted = events(f.transport).find(item => item.ev.t === 'user-message-accepted'); assert.ok(accepted); assert.equal(accepted.ev.runId, 'previous-real-fixture-turn');
  } finally { await connector.close(); await f.dispose(); }
});

test('Root receipt payload conflict after connector journal loss cannot accept a different input under an old id', async () => {
  const f = await fixture(), receipts = await CommandReceipts.load(join(f.directory, 'receipts.json')), connector = new NativeHappyConnector({ ...f.options, receipts });
  const key = 'hc' + createHash('sha256').update(JSON.stringify(['fixture-binding', 'phone-local', 'send'])).digest('hex').slice(0, 62);
  await receipts.run(connector.receiptScope, key, { action: 'send', payload: { text: 'different old input' }, epoch: 'owner-1', expectedTurnId: null }, async () => ({ nativeAdmission: { confirmed: true, turnId: 'old-turn' } }));
  try { await connector.start(); f.transport.inject(user('new conflicting input')); await assert.rejects(connector.processInbox(), { code: 'command-conflict' });
    assert.equal(f.adapter.calls.length, 0); assert.equal(events(f.transport).some(item => item.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});

test('blocking communication answers preserve native question ids and permission scope is explicit, never silently changed', async () => {
  const f = await fixture({ requests: [
    { kind: 'user-input', requestId: 'original-blocking', operable: true, questions: [{ id: 'native-question-id', question: 'Choose', options: [{ label: 'A' }], secret: false }] },
    { kind: 'permissions', requestId: 'original-grant', operable: true, requestedPermissions: { network: { enabled: true } }, grantScopes: ['turn', 'session'] },
  ] }), connector = await f.create();
  try { await connector.start(); const question = Object.keys(f.transport.agentState.communications)[0];
    await f.transport.rpc('communication', { commandId: 'native-blocking-answer', id: question, kind: 'form', status: 'answered', answers: { 'native-question-id': { options: ['A'], custom: '中文' } } });
    assert.deepEqual(f.adapter.calls[0].payload, { kind: 'user-input', requestId: 'original-blocking', response: { answers: { 'native-question-id': { answers: ['A', '中文'] } } } });
    await connector.project(f.adapter.view); const permission = Object.keys(f.transport.agentState.requests)[0];
    await assert.rejects(f.transport.rpc('permission', { commandId: 'bad-permission-scope', id: permission, approved: true, scope: 'global' }), { code: 'unsupported-permission-mode' });
    await f.transport.rpc('permission', { commandId: 'native-session-grant', id: permission, approved: true, scope: 'session' });
    assert.deepEqual(f.adapter.calls[1].payload.response, { permissions: { network: { enabled: true } }, scope: 'session' });
  } finally { await connector.close(); await f.dispose(); }
});

test('close during transport startup does not leave a late SDK subscription or RPC handlers', async () => {
  const f = await fixture(); let releaseTransport = /** @type {()=>void} */ (() => {}), signalStarted = /** @type {()=>void} */ (() => {});
  const started = new Promise(resolveStarted => { signalStarted = () => resolveStarted(undefined); });
  f.transport.start = () => new Promise(resolveStart => { releaseTransport = () => resolveStart(undefined); signalStarted(); });
  const connector = await f.create();
  try { const opening = connector.start(), rejected = assert.rejects(opening, { code: 'connector-closed' }); await started;
    const closing = connector.close(); releaseTransport(); await closing; await rejected;
    assert.equal(f.adapter.callback, null); assert.equal(f.adapter.calls.length, 0); assert.equal(f.transport.handlers.size, 0);
  } finally { await connector.close(); await f.dispose(); }
});

test('a rejected second connector cannot release the first connector checkpoint ownership', async () => {
  const f = await fixture(), first = await f.create(), second = await f.create(), third = await f.create();
  try { await first.start(); await assert.rejects(second.start(), { code: 'connector-in-use' }); await second.close(); await assert.rejects(third.start(), { code: 'connector-in-use' });
    assert.equal(f.adapter.calls.length, 0);
  } finally { await Promise.allSettled([first.close(), second.close(), third.close()]); await f.dispose(); }
});

function gate() {
  let release = /** @type {()=>void} */ (() => {});
  const promise = /** @type {Promise<void>} */ (new Promise(resolve => { release = () => resolve(undefined); }));
  return { promise, release: () => release() };
}

test('idle retirement closes only observation and fences captured RPC/input entries without changing journals', async () => {
  const f = await fixture({ status: 'active', currentTurnId: 'original-running-turn' }), connector = await f.create();
  try {
    await connector.start(); await connector.project(f.adapter.view);
    const rpc = f.transport.handlers.get('open-desktop'); assert.ok(rpc);
    const before = await readFile(f.options.statePath, 'utf8');
    const retiring = connector.tryCloseIfIdle();
    await assert.rejects(rpc({ commandId: 'late-rpc-after-retirement' }), { code: 'source-unavailable' });
    f.transport.inject(user('late captured input'));
    await connector.processInbox(); assert.equal(await retiring, true);
    assert.equal(f.adapter.calls.length, 0); assert.equal(f.adapter.callback, null); assert.equal(f.transport.handlers.size, 0);
    assert.equal(f.transport.inbox.length, 1); assert.equal(await readFile(f.options.statePath, 'utf8'), before);
    assert.equal(f.adapter.view.currentTurnId, 'original-running-turn'); assert.equal(await connector.tryCloseIfIdle(), true);
  } finally { await connector.close(); await f.dispose(); }
});

test('an RPC awaiting epoch before its prepared plan pins the observer until the whole operation settles', async () => {
  const f = await fixture(), entered = gate(), resume = gate(); let paused = false;
  f.adapter.command = async (_id, action) => { f.adapter.calls.push({ action }); return { requested: true }; };
  const connector = new NativeHappyConnector({ ...f.options, receipts: await CommandReceipts.load(join(f.directory, 'receipts.json')),
    getGeneration: () => { if (!paused) return 'owner-1'; entered.release(); return resume.promise.then(() => 'owner-1'); } });
  try {
    await connector.start(); await connector.project(f.adapter.view); paused = true;
    const operation = f.transport.rpc('open-desktop', { commandId: 'held-before-prepared-plan' }); await entered.promise;
    assert.equal(connector.status().commands, 0); assert.equal(await connector.tryCloseIfIdle(), false);
    paused = false; resume.release(); await operation;
    assert.equal(f.adapter.calls.length, 1); assert.equal(await connector.tryCloseIfIdle(), true);
  } finally { paused = false; resume.release(); await connector.close(); await f.dispose(); }
});

test('native dispatch and input processing remain protected until admission and event publication settle', async () => {
  const f = await fixture(), entered = gate(), resume = gate(), connector = await f.create();
  f.adapter.command = async (_id, action) => {
    f.adapter.calls.push({ action }); entered.release(); await resume.promise;
    return { admitted: true, turnId: 'original-admitted-turn', messageId: 'original-message' };
  };
  try {
    await connector.start(); await connector.project(f.adapter.view); f.transport.inject(user('held admission'));
    const input = connector.processInbox(); await entered.promise;
    assert.equal(await connector.tryCloseIfIdle(), false); assert.equal(f.transport.inbox.length, 1);
    resume.release(); await input; assert.equal(f.adapter.calls.length, 1);
    assert.equal(await connector.tryCloseIfIdle(), true);
  } finally { resume.release(); await connector.close(); await f.dispose(); }
});

test('pending inbox, outbox and unsent events prevent LRU retirement while explicit close remains available', async () => {
  for (const pending of ['inbox', 'outbox', 'events']) {
    const f = await fixture(), connector = await f.create();
    try {
      await connector.start(); await connector.project(f.adapter.view);
      if (pending === 'inbox') f.transport.inbox.push({ id: 'captured-not-admitted', record: user('captured input') });
      if (pending === 'outbox') f.transport.pendingOutbox = 1;
      if (pending === 'events') {
        f.transport.failPublication = true;
        await assert.rejects(connector.project({ ...f.adapter.view, revision: 2, rows: [{ id: 'late-owner-row', role: 'assistant', text: 'queued event', turnId: 'old-turn' }] }));
        assert.ok(connector.status().pendingEvents > 0);
      }
      const before = await readFile(f.options.statePath, 'utf8');
      assert.equal(await connector.tryCloseIfIdle(), false); assert.equal(connector.status().closed, false);
      await connector.close(); assert.equal(await readFile(f.options.statePath, 'utf8'), before);
      if (pending === 'inbox') assert.equal(f.transport.inbox.length, 1);
      if (pending === 'outbox') assert.equal(f.transport.pendingOutbox, 1);
    } finally { await connector.close(); await f.dispose(); }
  }
});

test('a durable prepared command is not mistaken for idle history during retirement', async () => {
  const f = await fixture(); let connector = await f.create();
  try {
    await connector.start(); await connector.close();
    const file = JSON.parse(await readFile(f.options.statePath, 'utf8')), state = /** @type {Value} */ (decryptRecord(file.ciphertext, f.options.encryptionKey));
    state.commands.push({ id: 'prepared-original-command', key: 'rpc:prepared-original-command', origin: 'rpc', state: 'prepared', action: 'approval', payload: {}, epoch: 'owner-1' });
    file.ciphertext = encryptRecord(state, f.options.encryptionKey); await writeFile(f.options.statePath, JSON.stringify(file));
    connector = await f.create(); await connector.start(); await connector.project(f.adapter.view);
    assert.equal(await connector.tryCloseIfIdle(), false); assert.equal(f.adapter.calls.length, 0);
    await connector.close();
    const saved = /** @type {Value} */ (decryptRecord(JSON.parse(await readFile(f.options.statePath, 'utf8')).ciphertext, f.options.encryptionKey));
    assert.equal(saved.commands[0].state, 'prepared');
  } finally { await connector.close(); await f.dispose(); }
});

test('unknown command history survives idle retirement and reopening without native replay', async () => {
  const f = await fixture(); let connector = await f.create(); f.adapter.fail = true;
  try {
    await connector.start(); f.transport.inject(user('original unknown input')); await connector.processInbox(); await connector.project(f.adapter.view);
    const commandId = f.adapter.calls[0].commandId;
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    const projection = await readFile(f.options.statePath, 'utf8'), receipts = await readFile(join(f.directory, 'receipts.json'), 'utf8');
    assert.equal(await connector.tryCloseIfIdle(), true);
    assert.equal(await readFile(f.options.statePath, 'utf8'), projection); assert.equal(await readFile(join(f.directory, 'receipts.json'), 'utf8'), receipts);
    connector = await f.create(); await connector.start();
    assert.equal((await f.transport.rpc('bridge-receipt', { commandId })).receipt.status, 'unknown');
    f.transport.inject(user('original unknown input')); await connector.processInbox();
    assert.equal(f.adapter.calls.length, 1); assert.equal(events(f.transport).some(item => item.ev.t === 'user-message-accepted'), false);
  } finally { await connector.close(); await f.dispose(); }
});
