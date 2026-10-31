import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { BridgeError } from '../src/errors.mjs';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** @typedef {Record<string, any>} Value */
class NativeFixture {
  hostId = 'local';
  /** @type {string|null} */ ownerGeneration = null;
  /** @param {string} _id */ generation(_id) { return this.ownerGeneration; }
  connects = 0;
  subscriptions = 0;
  releases = 0;
  /** @type {Map<string,Set<(frame:Value)=>void>>} */ listeners = new Map();
  /** @type {Value[]} */ actions = [];
  /** @type {string[]} */ refreshes = [];
  /** @type {Map<string,{state:Value,revision:number}>} */ ownerStates = new Map();
  /** @type {BridgeError|null} */ actionError = null;
  async connect() { this.connects += 1; }
  /** @param {string} id @param {(frame:Value)=>void} callback */
  async subscribe(id, callback) {
    this.subscriptions += 1;
    let callbacks = this.listeners.get(id);
    if (!callbacks) { callbacks = new Set(); this.listeners.set(id, callbacks); }
    callbacks.add(callback);
    let active = true;
    return () => { if (active) { active = false; this.releases += 1; callbacks.delete(callback); } };
  }
  /** @param {string} id @param {Value} frame */
  emit(id, frame) { for (const callback of [...this.listeners.get(id) ?? []]) callback(frame); }
  /** @param {string} id @param {Value} state @param {number} [revision] */
  snapshot(id, state, revision = 1) { this.ownerStates.set(id, { state, revision }); this.emit(id, { type: 'broadcast', method: 'thread-stream-state-changed', params: { change: { type: 'snapshot', revision, conversationState: state } } }); }
  /** @param {string} id */
  async refreshSnapshot(id) {
    this.refreshes.push(id);
    const owner = this.ownerStates.get(id);
    if (owner) this.snapshot(id, owner.state, owner.revision);
  }
  /** @param {string} id @param {Value[]} patches @param {number} baseRevision @param {number} revision */
  patch(id, patches, baseRevision, revision) { this.emit(id, { type: 'broadcast', method: 'thread-stream-state-changed', params: { change: { type: 'patches', patches, baseRevision, revision } } }); }
  /** @param {string} method @param {Value} payload @param {string} commandId */
  async action(method, payload, commandId) {
    this.actions.push({ method, payload, commandId });
    if (this.actionError) throw this.actionError;
    return { result: { result: { turnId: 'turn-2', ok: true, environment: 'never-export-native-result' } } };
  }
  /** @param {string} id @param {string} text @param {string} commandId */
  send(id, text, commandId) { return this.action('send', { id, text }, commandId); }
  /** @param {string} id @param {string} text @param {string} commandId */
  steer(id, text, commandId) { return this.action('steer', { id, text }, commandId); }
  /** @param {Value} target @param {string} commandId */
  interrupt(target, commandId) { return this.action('interrupt', target, commandId); }
  /** @param {Value} target @param {string} decision @param {string} commandId */
  respondApproval(target, decision, commandId) { return this.action('approval', { ...target, decision }, commandId); }
  /** @param {Value} target @param {Value} response @param {string} commandId */
  respondUserInput(target, response, commandId) { return this.action('user-input', { ...target, response }, commandId); }
  /** @param {Value} target @param {Value} response @param {string} commandId */
  respondPermissions(target, response, commandId) { return this.action('permissions', { ...target, response }, commandId); }
  /** @param {Value} target @param {Value} response @param {string} commandId */
  respondElicitation(target, response, commandId) { return this.action('elicitation', { ...target, response }, commandId); }
  dispose() { this.listeners.clear(); }
}

/** @param {import('node:test').TestContext} t @param {{snapshotRefreshMs?:number}} [options] */
function fixture(t, options = {}) {
  const native = new NativeFixture();
  const backend = new CodexBackend({ ipc: /** @type {import('../src/adapters/codex-ipc.mjs').CodexIpcAdapter} */ (/** @type {unknown} */ (native)), waitTimeoutMs: 100, snapshotRefreshMs: 0, ...options });
  t.after(() => backend.dispose());
  return { native, backend };
}
/** @param {()=>boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Test condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** @returns {Value} */
function ownerState() {
  return {
    developerInstructions: 'hidden-developer-value', config: { model: 'hidden-config-value' }, environment: { token: 'hidden-environment-value' },
    threadRuntimeStatus: { type: 'active', activeFlags: [] },
    turnHistory: { kind: 'canonical', history: { entitiesByKey: {
      old: { turnId: 'turn-1', status: 'completed', turnStartedAtMs: 100, items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'visible user' }] },
        { id: 'hidden-1', type: 'message', role: 'developer', content: [{ type: 'text', text: 'hidden-message-value' }] },
      ] },
      tail: { turnId: 'turn-2', status: 'inProgress', turnStartedAtMs: 200, items: [
        { id: 'assistant-1', type: 'agentMessage', text: 'visible assistant' },
        { id: 'tool-1', type: 'mcpToolCall', server: 'fixture', tool: 'read_fixture', arguments: { env: 'hidden-tool-input' }, status: 'completed', result: { content: [{ type: 'text', text: 'visible tool output' }], config: 'hidden-result-config' } },
      ] },
    }, islands: [{ entries: [{ key: 'a', value: 'old' }, { key: 'b', value: 'tail' }] }] } },
    requests: [
      { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { turnId: 'turn-2', reason: 'fixture approval', command: 'fixture command', environment: 'hidden-approval-env' } },
      { id: 8, method: 'item/tool/requestUserInput', params: { turnId: 'turn-2', questions: [{ id: 'q1', header: 'Choice', question: 'Pick one', isSecret: false, options: [{ label: 'A', description: 'First', secret: 'hidden-option-data' }] }], answers: 'hidden-answers-value' } },
      { id: 'unknown', method: 'account/chatgptAuthTokens/refresh', params: { token: 'hidden-token-value' } },
    ],
    turns: [{ turnId: 'fallback-turn', items: [{ id: 'fallback-item', type: 'agentMessage', text: 'wrong fallback row' }] }],
  };
}

test('a discovery owner change cannot reuse the prior owner cached snapshot as a fresh view', async (t) => {
  const { native, backend } = fixture(t);
  native.ownerGeneration = 'local:owner-one';
  const emit = (/** @type {string} */ owner, /** @type {Value} */ state) => native.emit('session-owner-change', { type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: owner,
    params: { hostId: 'local', change: { type: 'snapshot', revision: 1, conversationState: state } } });
  const observing = backend.subscribe('session-owner-change', () => {});
  await until(() => native.subscriptions === 1); emit('owner-one', ownerState()); const release = await observing;
  const original = await backend.snapshot('session-owner-change'); assert.equal(original.ownerGeneration, 'local:owner-one');
  native.ownerGeneration = 'local:owner-two';
  const fresh = backend.snapshot('session-owner-change');
  await until(() => native.subscriptions === 2);
  const replacement = ownerState(); replacement.turnHistory.history.entitiesByKey.tail.items[0].text = 'replacement owner snapshot';
  emit('owner-two', replacement);
  const received = await fresh;
  assert.equal(received.ownerGeneration, 'local:owner-two');
  assert.ok(received.rows.some(row => row.text === 'replacement owner snapshot'));
  assert.equal(native.actions.length, 0); release();
});

test('first snapshot waits for native state and releases its temporary subscription', async (t) => {
  const { native, backend } = fixture(t);
  let complete = false;
  const pending = backend.snapshot('session-1').then((view) => { complete = true; return view; });
  await until(() => native.subscriptions === 1);
  assert.equal(complete, false);
  native.snapshot('session-1', ownerState(), 12);
  const view = await pending;
  assert.equal(view.revision, 12);
  assert.equal(view.currentTurnId, 'turn-2');
  assert.equal(native.releases, 1);
  assert.equal(backend.sessions.size, 0);
});

test('two consumers share one native subscription and get independent allowlisted views', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const a = [];
  /** @type {Value[]} */ const b = [];
  const first = backend.subscribe('session-1', (view) => a.push(view));
  const second = backend.subscribe('session-1', (view) => b.push(view));
  await until(() => native.subscriptions === 1);
  native.snapshot('session-1', ownerState());
  const [releaseA, releaseB] = await Promise.all([first, second]);
  assert.deepEqual(a[0].rows.map((/** @type {Value} */ row) => row.id), ['user-1', 'assistant-1', 'tool-1']);
  assert.equal(a[0].rows[2].tools[0].output, 'visible tool output');
  for (const hidden of ['hidden-developer-value', 'hidden-config-value', 'hidden-environment-value', 'hidden-message-value', 'hidden-tool-input', 'hidden-result-config', 'hidden-approval-env', 'hidden-option-data', 'hidden-answers-value', 'hidden-token-value']) assert.equal(JSON.stringify(a[0]).includes(hidden), false);
  assert.equal(a[0].requests[0].kind, 'command');
  assert.equal(a[0].requests[0].operable, true);
  assert.equal(a[0].requests[1].kind, 'user-input');
  assert.equal(a[0].requests[1].operable, true);
  assert.deepEqual(a[0].requests[1].questions[0].options, [{ label: 'A', description: 'First' }]);
  assert.equal(a[0].requests[2].operable, false);
  a[0].rows[0].text = 'changed by consumer A';
  assert.equal(b[0].rows[0].text, 'visible user');
  releaseA(); releaseA();
  assert.equal(native.releases, 0);
  native.patch('session-1', [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 0, 'text'], value: 'next text' }], 1, 2);
  assert.equal(b.at(-1)?.rows[1].text, 'next text');
  assert.equal(b[0].rows[1].text, 'visible assistant');
  releaseB();
  assert.equal(native.releases, 1);
});

test('Immer array add/remove and base mismatch renew only read subscriptions', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  native.snapshot('session-1', ownerState(), 4);
  await subscription;
  native.patch('session-1', [
    { op: 'remove', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 1] },
    { op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 1], value: { id: 'added', type: 'agentMessage', text: 'array addition' } },
  ], 4, 5);
  assert.deepEqual(views.at(-1)?.rows.map((/** @type {Value} */ row) => row.id), ['user-1', 'assistant-1', 'added']);
  native.patch('session-1', [{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }], 3, 6);
  assert.equal(views.at(-1)?.revision, null);
  assert.equal(views.at(-1)?.currentTurnId, null);
  await until(() => native.subscriptions === 2);
  assert.equal(native.releases, 1);
  assert.equal(native.actions.length, 0);
  native.snapshot('session-1', ownerState(), 9);
  assert.equal(views.at(-1)?.revision, 9);
});

test('unsafe prototype paths invalidate atomically without polluting other snapshots', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  native.snapshot('session-1', ownerState()); await subscription;
  native.patch('session-1', [
    { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 0, 'text'], value: 'must not publish partial batch' },
    { op: 'add', path: ['__proto__', 'polluted'], value: true },
  ], 1, 2);
  assert.equal(Object.hasOwn({}, 'polluted'), false);
  assert.equal(views.some((view) => view.rows.some((/** @type {Value} */ row) => row.text === 'must not publish partial batch')), false);
  await until(() => native.subscriptions === 2);
  native.snapshot('session-1', ownerState(), 3);
  assert.equal(views.at(-1)?.rows[1].text, 'visible assistant');
});

test('disconnect clears current run and approvals; snapshot waits for a new base', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1); native.snapshot('session-1', ownerState()); await subscription;
  native.emit('session-1', { type: 'bridge/status', status: 'disconnected' });
  assert.deepEqual(views.at(-1)?.requests, []);
  assert.equal(views.at(-1)?.currentTurnId, null);
  assert.equal(views.at(-1)?.status, 'disconnected');
  const pending = backend.snapshot('session-1');
  await until(() => native.subscriptions === 2);
  native.snapshot('session-1', ownerState(), 8);
  assert.equal((await pending).revision, 8);
});

test('commands require exact input and pending native approval, and return no raw state', async (t) => {
  const { native, backend } = fixture(t);
  assert.deepEqual(await backend.command('session-1', 'send', { text: 'fixture input' }, 'command-1'), { action: 'send', acknowledged: true, turnId: 'turn-2', ok: true });
  await assert.rejects(backend.command('session-1', 'send', { text: 'fixture', config: {} }, 'command-2'), { code: 'invalid-payload' });
  await assert.rejects(backend.command('session-1', 'interrupt', {}, 'command-3'), { code: 'invalid-payload' });
  await backend.command('session-1', 'interrupt', { turnId: 'expected-turn' }, 'command-4');
  assert.deepEqual(native.actions.at(-1)?.payload, { sessionId: 'session-1', hostId: 'local', turnId: 'expected-turn' });
  const subscription = backend.subscribe('session-1', () => {});
  await until(() => native.subscriptions === 1); native.snapshot('session-1', ownerState()); await subscription;
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 'not-pending', kind: 'command', decision: 'accept' }, 'command-5'), { code: 'stale-approval' });
  await backend.command('session-1', 'approval', { requestId: 'approval-1', kind: 'command', decision: 'decline' }, 'command-6');
  assert.equal(native.actions.at(-1)?.payload.requestId, 'approval-1');
  assert.equal(native.actions.at(-1)?.payload.decision, 'decline');
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 8, kind: 'user-input', decision: 'accept' }, 'command-7'), { code: 'invalid-payload' });
});

test('native mutation disconnect and timeout become unknown delivery receipts', async (t) => {
  const { native, backend } = fixture(t);
  for (const code of ['codex-outcome-unknown', 'codex-disconnected', 'codex-protocol-error']) {
    native.actionError = new BridgeError(code, 'fixture failure');
    await assert.rejects(backend.command('session-1', 'send', { text: 'fixture input' }, `command-${code}`), { code: 'delivery-unknown' });
  }
  native.actionError = new BridgeError('codex-owner-unavailable', 'fixture no owner');
  await assert.rejects(backend.command('session-1', 'send', { text: 'fixture input' }, 'no-owner'), { code: 'codex-owner-unavailable' });
  assert.equal(native.actions.length, 4);
});

test('user question answers cover the exact pending identities and are forwarded natively', async (t) => {
  const { native, backend } = fixture(t);
  const subscription = backend.subscribe('session-1', () => {});
  await until(() => native.subscriptions === 1); native.snapshot('session-1', ownerState()); await subscription;
  const response = { answers: { q1: { answers: ['A'] } } };
  await backend.command('session-1', 'approval', { requestId: 8, kind: 'user-input', response }, 'answer-command');
  assert.deepEqual(native.actions.at(-1), { method: 'user-input', commandId: 'answer-command', payload: { sessionId: 'session-1', hostId: 'local', requestId: 8, response } });
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 8, kind: 'user-input', response: { answers: { wrong: { answers: ['A'] } } } }, 'wrong-question'), { code: 'invalid-answer-identity' });
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 8, kind: 'user-input', response: { answers: { q1: { answers: [42] } } } }, 'wrong-answer-type'), { code: 'invalid-response' });
  assert.equal(native.actions.length, 1);
});

test('permission responses validate their full shape and cannot expand pending grants', async (t) => {
  const { native, backend } = fixture(t);
  const subscription = backend.subscribe('session-1', () => {});
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.requests.push({ id: 'permissions-1', method: 'item/permissions/requestApproval', params: { turnId: 'turn-2', permissions: { network: { enabled: true }, fileSystem: { read: ['/fixture'] } } } });
  native.snapshot('session-1', state); await subscription;
  await backend.command('session-1', 'approval', { requestId: 'permissions-1', kind: 'permissions', response: { permissions: { network: { enabled: true }, fileSystem: { read: ['/fixture'] } }, scope: 'turn' } }, 'grant-command');
  assert.equal(native.actions.at(-1)?.method, 'permissions');
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 'permissions-1', kind: 'permissions', response: { permissions: { fileSystem: { write: ['/unrequested'] } } } }, 'expanded-grant'), { code: 'permission-expansion' });
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 'permissions-1', kind: 'permissions', response: { permissions: {}, scope: 'forever' } }, 'bad-scope'), { code: 'invalid-response' });
  assert.equal(native.actions.length, 1);
});

test('MCP form content follows the current schema and OS verification cannot be forged', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.requests.push({ id: 'form-1', method: 'mcpServer/elicitation/request', params: { turnId: 'turn-2', mode: 'form', message: 'Enter fixture name',
    requestedSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false }, _meta: { token: 'hidden-mcp-metadata' } } });
  state.requests.push({ id: 'verification-1', method: 'mcpServer/elicitation/request', params: { turnId: 'turn-2', mode: 'openai/userVerification', message: 'Verify', challenge: 'hidden-verification-challenge' } });
  native.snapshot('session-1', state); await subscription;
  assert.equal(JSON.stringify(views.at(-1)).includes('hidden-mcp-metadata'), false);
  assert.equal(JSON.stringify(views.at(-1)).includes('hidden-verification-challenge'), false);
  assert.equal(views.at(-1)?.requests.find((/** @type {Value} */ request) => request.requestId === 'form-1').acceptSupported, true);
  await backend.command('session-1', 'approval', { requestId: 'form-1', kind: 'elicitation', response: { action: 'accept', content: { name: 'Fixture' } } }, 'form-command');
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 'form-1', kind: 'elicitation', response: { action: 'accept', content: { name: '' } } }, 'invalid-form'), { code: 'invalid-form-response' });
  await assert.rejects(backend.command('session-1', 'approval', { requestId: 'verification-1', kind: 'elicitation', response: { action: 'accept' } }, 'forged-verification'), { code: 'native-verification-required' });
  await backend.command('session-1', 'approval', { requestId: 'verification-1', kind: 'elicitation', response: { action: 'cancel' } }, 'cancel-verification');
  assert.equal(native.actions.length, 2);
});

test('independent native schema fixtures preserve every permission path variant and nullable profile', async (t) => {
  const { native, backend } = fixture(t);
  const schema = JSON.parse(await readFile(new URL('../src/adapters/codex-schemas/PermissionsRequestApprovalResponse.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strictTypes: false });
  ajv.addFormat('uint', { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 });
  const validate = ajv.compile(schema);
  // Hand-authored fixtures come from the installed schema's variants, not from projector output.
  const paths = [
    { type: 'path', path: '/fixture/plain' },
    { type: 'glob_pattern', pattern: '/fixture/**/*.md' },
    { type: 'special', value: { kind: 'root' } },
    { type: 'special', value: { kind: 'minimal' } },
    { type: 'special', value: { kind: 'project_roots' } },
    { type: 'special', value: { kind: 'project_roots', subpath: null } },
    { type: 'special', value: { kind: 'project_roots', subpath: 'docs' } },
    { type: 'special', value: { kind: 'tmpdir' } },
    { type: 'special', value: { kind: 'slash_tmp' } },
    { type: 'special', value: { kind: 'unknown', path: 'future-root' } },
    { type: 'special', value: { kind: 'unknown', path: 'future-root', subpath: null } },
    { type: 'special', value: { kind: 'unknown', path: 'future-root', subpath: 'child' } },
  ];
  const profiles = [
    {}, { network: null, fileSystem: null }, { network: {} }, { network: { enabled: null } },
    { network: { enabled: false } }, { network: { enabled: true } }, { fileSystem: {} },
    { fileSystem: { entries: null, read: null, write: null, globScanMaxDepth: null } },
    { fileSystem: { entries: [], read: [], write: [] } },
    { network: { enabled: true }, fileSystem: { read: ['/fixture/read'], write: ['/fixture/write'], globScanMaxDepth: 2,
      entries: paths.map((path, index) => ({ access: ['read', 'write', 'deny'][index % 3], path })) } },
  ];
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.requests = profiles.map((permissions, index) => ({ id: `profile-${index}`, method: 'item/permissions/requestApproval', params: {
    turnId: 'turn-2', permissions, environment: 'excluded-permission-environment', token: 'excluded-permission-token' } }));
  native.snapshot('session-1', state); await subscription;
  const requests = views.at(-1)?.requests ?? [];
  for (const [index, profile] of profiles.entries()) {
    assert.equal(validate({ permissions: profile, scope: 'turn' }), true, JSON.stringify(validate.errors));
    assert.deepEqual(requests[index].requestedPermissions, profile);
    assert.equal(requests[index].operable, true);
    assert.deepEqual(requests[index].grantScopes, ['turn', 'session']);
    assert.equal(requests[index].defaultGrantScope, 'turn');
    const response = { permissions: requests[index].requestedPermissions, scope: 'turn' };
    assert.equal(validate(response), true, JSON.stringify(validate.errors));
    await backend.command('session-1', 'approval', { kind: 'permissions', requestId: `profile-${index}`, response }, `profile-command-${index}`);
    assert.deepEqual(native.actions.at(-1)?.payload.response.permissions, profile);
  }
  assert.equal(JSON.stringify(requests).includes('excluded-permission-environment'), false);
  assert.equal(JSON.stringify(requests).includes('excluded-permission-token'), false);
  assert.equal(validate({ permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'special', value: 'root' } }] } } }), false);
});

test('malformed or future permission variants are visible as unsupported rather than silently normalized', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.requests = [{ id: 'bad-path', method: 'item/permissions/requestApproval', params: { permissions: {
    fileSystem: { entries: [{ access: 'read', path: { type: 'special', value: 'root' } }] } } } }];
  native.snapshot('session-1', state); await subscription;
  const request = views.at(-1)?.requests[0];
  assert.equal(request.operable, false);
  assert.equal(request.requestedPermissions, null);
  assert.equal(request.unsupportedReason, 'permission-schema-mismatch');
  await assert.rejects(backend.command('session-1', 'approval', { kind: 'permissions', requestId: 'bad-path', response: { permissions: {} } }, 'bad-permission-request'), { code: 'stale-approval' });
  assert.equal(native.actions.length, 0);
});

test('file approvals join the exact item and expose add/update/delete/rename diffs without arbitrary metadata', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.turnHistory.history.entitiesByKey.old.items.push({ id: 'file-item', type: 'fileChange', changes: [{ path: '/fixture/wrong-old-turn', kind: { type: 'delete' }, diff: '- old' }] });
  state.turnHistory.history.entitiesByKey.tail.items.push({ id: 'file-item', type: 'fileChange', status: 'inProgress', changes: [
    { path: '/fixture/new.txt', kind: { type: 'add' }, diff: '+ new', environment: 'hidden-file-change-env' },
    { path: '/fixture/old.txt', kind: { type: 'delete' }, diff: '- old' },
    { path: '/fixture/change.txt', kind: { type: 'update', move_path: null }, diff: '- before\n+ after' },
    { path: '/fixture/source.txt', kind: { type: 'update', move_path: '/fixture/destination.txt', token: 'hidden-kind-token' }, diff: '- source\n+ destination' },
  ] });
  state.requests = [
    { id: 'file-approval', method: 'item/fileChange/requestApproval', params: { turnId: 'turn-2', itemId: 'file-item', grantRoot: '/fixture', reason: 'File fixture', env: 'hidden-request-env' } },
    { id: 'missing-file', method: 'item/fileChange/requestApproval', params: { turnId: 'turn-2', itemId: 'not-loaded', reason: 'Missing details' } },
  ];
  native.snapshot('session-1', state); await subscription;
  const request = views.at(-1)?.requests[0];
  assert.deepEqual(request.changes, [
    { path: '/fixture/new.txt', kind: 'add', movePath: null, diff: '+ new' },
    { path: '/fixture/old.txt', kind: 'delete', movePath: null, diff: '- old' },
    { path: '/fixture/change.txt', kind: 'update', movePath: null, diff: '- before\n+ after' },
    { path: '/fixture/source.txt', kind: 'update', movePath: '/fixture/destination.txt', diff: '- source\n+ destination' },
  ]);
  assert.equal(request.acceptSupported, true);
  assert.equal(request.grantScope, 'requested-session-root');
  assert.equal(request.grantRootHonored, 'unverified');
  assert.equal(JSON.stringify(request).includes('hidden-'), false);
  const unavailable = views.at(-1)?.requests[1];
  assert.equal(unavailable.acceptSupported, false);
  assert.deepEqual(unavailable.allowedActions, ['decline', 'cancel']);
  await assert.rejects(backend.command('session-1', 'approval', { kind: 'file', requestId: 'missing-file', decision: 'accept' }, 'missing-file-accept'), { code: 'approval-details-unavailable' });
  await backend.command('session-1', 'approval', { kind: 'file', requestId: 'missing-file', decision: 'decline' }, 'missing-file-decline');
});

test('command approval context keeps network protocols and terminal-input distinction without hidden params', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.requests = ['http', 'https', 'socks5Tcp', 'socks5Udp'].map((protocol, index) => ({ id: `network-${index}`, method: 'item/commandExecution/requestApproval', params: {
    command: null, turnId: 'turn-2', itemId: 'network-item', networkApprovalContext: { host: 'fixture.example', protocol, token: 'hidden-network-token' },
    cwd: '/fixture', proposedNetworkPolicyAmendments: [{ host: 'fixture.example', action: 'allow', secret: 'hidden-rule' }],
    environment: 'hidden-environment-params' } }));
  state.requests.push({ id: 'stdin', method: 'item/commandExecution/requestApproval', params: { kind: 'writeStdin', command: 'fixture terminal input', approvalId: 'callback-fixture' } });
  native.snapshot('session-1', state); await subscription;
  const requests = views.at(-1)?.requests;
  for (const [index, protocol] of ['http', 'https', 'socks5Tcp', 'socks5Udp'].entries()) {
    assert.deepEqual(requests[index].networkApprovalContext, { host: 'fixture.example', protocol });
    assert.equal(requests[index].acceptSupported, true);
    assert.deepEqual(requests[index].proposedNetworkPolicyAmendments, [{ host: 'fixture.example', action: 'allow' }]);
  }
  assert.equal(requests[4].nativeKind, 'writeStdin');
  assert.equal(requests[4].grantScope, 'terminal-input');
  assert.equal(requests[4].approvalId, 'callback-fixture');
  assert.equal(JSON.stringify(requests).includes('hidden-'), false);
});

test('reasoning exposes only native public summary, never raw content or text fallback', async (t) => {
  const { native, backend } = fixture(t);
  const snapshot = backend.snapshot('session-1');
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.turnHistory.history.entitiesByKey.tail.items.push(
    { id: 'public-reasoning', type: 'reasoning', summary: ['Public overview'], content: ['hidden-raw-content'], text: 'hidden-raw-text' },
    { id: 'private-reasoning', type: 'reasoning', summary: [], content: ['hidden-only-content'], text: 'hidden-only-text' },
  );
  native.snapshot('session-1', state);
  const view = await snapshot;
  assert.equal(view.rows.find((row) => row.id === 'public-reasoning')?.text, 'Public overview');
  assert.equal(view.rows.some((row) => row.id === 'private-reasoning'), false);
  assert.equal(JSON.stringify(view).includes('hidden-raw-'), false);
  assert.equal(JSON.stringify(view).includes('hidden-only-'), false);
});

test('public turn input fills the opening user row only until its explicit native message arrives', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.turnHistory.history.entitiesByKey.tail.params = { clientUserMessageId: 'client-fixture', input: [{ type: 'text', text: 'Public user input' }], developerInstructions: 'hidden-turn-developer', toolOutput: 'hidden-bootstrap-output' };
  native.snapshot('session-1', state); await subscription;
  const pending = views.at(-1)?.rows.find((/** @type {Value} */ row) => row.id === 'pending-user:client-fixture');
  assert.equal(pending.text, 'Public user input');
  native.patch('session-1', [{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 0], value: { id: 'native-user-message', clientId: 'client-fixture', type: 'userMessage', content: [{ type: 'text', text: 'Public user input' }] } }], 1, 2);
  const latest = views.at(-1)?.rows ?? [];
  assert.equal(latest.filter((/** @type {Value} */ row) => row.text === 'Public user input').length, 1);
  assert.equal(latest.some((/** @type {Value} */ row) => row.id === 'pending-user:client-fixture'), false);
  assert.equal(JSON.stringify(latest).includes('hidden-turn-developer'), false);
  assert.equal(JSON.stringify(latest).includes('hidden-bootstrap-output'), false);
});

test('empty bootstrap input and uncorrelated functionCallOutput are never invented as user or public tool rows', async (t) => {
  const { native, backend } = fixture(t);
  const snapshot = backend.snapshot('session-1');
  await until(() => native.subscriptions === 1);
  native.snapshot('session-1', { turns: [{ turnId: 'bootstrap', params: { clientUserMessageId: 'bootstrap-client', input: [], toolOutput: 'hidden-bootstrap-tool-output' },
    items: [{ id: 'bootstrap-output', type: 'functionCallOutput', name: 'bootstrap', output: 'hidden-bootstrap-context' }, { id: 'ready', type: 'agentMessage', text: 'BRIDGE_READY' }] }] });
  const view = await snapshot;
  assert.deepEqual(view.rows.map((row) => ({ id: row.id, role: row.role, text: row.text })), [{ id: 'ready', role: 'assistant', text: 'BRIDGE_READY' }]);
});

test('public steering input is visible and deduplicates its accepted server message without exposing restore context', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */ const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view));
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.turnHistory.history.entitiesByKey.tail.items.push({ id: 'optimistic-steer', type: 'steeringUserMessage', status: 'accepted', clientUserMessageId: 'steer-client',
    input: [{ type: 'text', text: 'Public steering input' }], restoreMessage: { context: { developerInstructions: 'hidden-steer-context' } } });
  native.snapshot('session-1', state); await subscription;
  assert.equal(views.at(-1)?.rows.filter((/** @type {Value} */ row) => row.text === 'Public steering input').length, 1);
  native.patch('session-1', [{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'tail', 'items', 3], value: { id: 'server-steer', clientId: 'steer-client', type: 'userMessage', content: [{ type: 'text', text: 'Public steering input' }] } }], 1, 2);
  const rows = views.at(-1)?.rows ?? [];
  assert.equal(rows.filter((/** @type {Value} */ row) => row.text === 'Public steering input').length, 1);
  assert.equal(rows.some((/** @type {Value} */ row) => row.id === 'server-steer'), true);
  assert.equal(JSON.stringify(rows).includes('hidden-steer-context'), false);
});

test('one shared active-only read timer publishes changed stdout at the same native revision and stops on idle', async (t) => {
  const { native, backend } = fixture(t, { snapshotRefreshMs: 1000 });
  /** @type {Value[]} */ const views = [];
  const first = backend.subscribe('session-1', (view) => views.push(view));
  const second = backend.subscribe('session-1', () => {});
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.turnHistory.history.entitiesByKey.tail.items.push({ id: 'live-command', type: 'commandExecution', status: 'inProgress', command: 'fixture', aggregatedOutput: '' });
  native.snapshot('session-1', state, 7);
  await Promise.all([first, second]);
  const beforeStamp = views.at(-1)?.contentStamp;
  const updated = structuredClone(state);
  updated.turnHistory.history.entitiesByKey.tail.items.at(-1).aggregatedOutput = 'BRIDGE_REFRESH_MARKER';
  native.ownerStates.set('session-1', { state: updated, revision: 7 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(native.refreshes, ['session-1']);
  assert.equal(views.at(-1)?.revision, 7);
  assert.notEqual(views.at(-1)?.contentStamp, beforeStamp);
  assert.equal(views.at(-1)?.rows.at(-1).tools[0].output, 'BRIDGE_REFRESH_MARKER');
  assert.equal(native.actions.length, 0);
  assert.equal(native.subscriptions, 1);
  updated.threadRuntimeStatus.type = 'idle'; updated.turnHistory.history.entitiesByKey.tail.status = 'completed';
  native.snapshot('session-1', updated, 8);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(native.refreshes.length, 1);
  assert.equal(backend.sessions.get('session-1')?.refreshTimer, null);
});

test('owner generation changes cancel old read timers and resume only after a fresh active snapshot', async (t) => {
  const { native, backend } = fixture(t, { snapshotRefreshMs: 1000 });
  const pending = backend.subscribe('session-1', () => {});
  await until(() => native.subscriptions === 1);
  const state = ownerState();
  state.turnHistory.history.entitiesByKey.tail.items.push({ id: 'live-file', type: 'fileChange', status: 'inProgress', changes: [] });
  native.snapshot('session-1', state, 3); await pending;
  native.emit('session-1', { type: 'bridge/status', status: 'owner-disconnected' });
  assert.equal(backend.sessions.get('session-1')?.refreshTimer, null);
  await until(() => native.subscriptions === 2);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(native.refreshes.length, 0);
  native.snapshot('session-1', state, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(native.refreshes.length, 1);
  assert.equal(native.actions.length, 0);
});

test('background runtime activity cannot manufacture a foreground turn identity from completed history', async (t) => {
  const { native, backend } = fixture(t);
  const pending = backend.snapshot('session-1');
  await until(() => native.subscriptions === 1);
  native.snapshot('session-1', { threadRuntimeStatus: { type: 'active', activeFlags: ['background'] }, turns: [
    { turnId: 'completed-turn', status: 'completed', items: [{ id: 'background-command', type: 'commandExecution', status: 'inProgress', command: 'fixture', aggregatedOutput: '' }] },
  ] });
  const view = await pending;
  assert.equal(view.status, 'active');
  assert.equal(view.currentTurnId, null);
});

test('opt-in native error diagnostics are private, bounded, redacted and restricted to the explicit test scope', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-native-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = new NativeFixture();
  const path = join(directory, 'private/errors.json');
  const backend = new CodexBackend({ ipc: /** @type {import('../src/adapters/codex-ipc.mjs').CodexIpcAdapter} */ (/** @type {unknown} */ (native)),
    nativeErrorThread: 'test-only', nativeErrorFile: path, snapshotRefreshMs: 0 });
  t.after(() => backend.dispose());
  native.actionError = new BridgeError('codex-request-rejected', 'missing field context; Bearer privateBearer token=privateToken https://private.example/v1/response ' + 'x'.repeat(5000));
  await assert.rejects(backend.command('test-only', 'send', { text: 'never-record-request-payload' }, 'test-error-command'));
  await assert.rejects(backend.command('different-scope', 'send', { text: 'unrelated-payload' }, 'other-error-command'));
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].threadId, 'test-only');
  assert.ok(saved[0].message.length <= 4096);
  for (const secret of ['privateBearer', 'privateToken', 'private.example', 'never-record-request-payload', 'unrelated-payload']) assert.equal(JSON.stringify(saved).includes(secret), false);
});

test('native async message questions retain source identity and never become pending tool requests', async (t) => {
  const { native, backend } = fixture(t);
  const pending = backend.snapshot('session-1'); await until(() => native.subscriptions === 1);
  native.snapshot('session-1', { turns: [{ turnId: 'async-turn', status: 'completed', items: [{ id: 'call_original', type: 'agentMessage', text: '', questions: [
    { title: 'Choose a native marker', options: ['A', 'B'], extra: 'hidden-question-metadata' }, { title: 'Free text', options: null },
  ] }] }] });
  const view = await pending;
  assert.equal(view.rows.length, 1); assert.equal(view.rows[0].id, 'call_original'); assert.deepEqual(view.requests, []);
  assert.deepEqual(view.rows[0].asyncQuestions, [
    { questionItemId: JSON.stringify(['request_user_input_async', 'call_original', 0]), sourceItemId: 'call_original', questionIndex: 0, title: 'Choose a native marker', options: ['A', 'B'], answered: false },
    { questionItemId: JSON.stringify(['request_user_input_async', 'call_original', 1]), sourceItemId: 'call_original', questionIndex: 1, title: 'Free text', options: [], answered: false },
  ]);
  assert.equal(JSON.stringify(view).includes('hidden-question-metadata'), false);
});

test('native marker replies mark only accepted matching questions and render no protocol wrapper', async (t) => {
  const { native, backend } = fixture(t);
  /** @type {Value[]} */
  const views = [];
  const subscription = backend.subscribe('session-1', (view) => views.push(view)); await until(() => native.subscriptions === 1);
  const id = JSON.stringify(['request_user_input_async', 'call_original', 0]);
  const text = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: id, question: 'Question', answer: 'Free answer' }])}\n</send_user_message_question_reply>`;
  native.snapshot('session-1', { turns: [{ turnId: 'async-turn', status: 'inProgress', items: [
    { id: 'call_original', type: 'agentMessage', text: 'Question', questions: [{ title: 'Question', options: ['A'] }] },
    { id: 'pending', type: 'steeringUserMessage', status: 'pending', input: [{ type: 'text', text }] },
  ] }] }); await subscription;
  assert.equal(views.at(-1)?.rows[0].asyncQuestions[0].answered, false);
  native.patch('session-1', [{ op: 'add', path: ['turns', 0, 'items', 2], value: { id: 'accepted', type: 'userMessage', content: [{ type: 'text', text }] } }], 1, 2);
  assert.equal(views.at(-1)?.rows[0].asyncQuestions[0].answered, true);
  assert.equal(views.at(-1)?.rows[0].asyncQuestions[0].answer, 'Free answer');
  assert.equal(views.at(-1)?.rows.find((/** @type {Value} */ row) => row.id === 'accepted').text, 'Question\nFree answer');
  assert.equal(views.at(-1)?.rows.some((/** @type {Value} */ row) => row.text.includes('<send_user_message_question_reply>')), false);
});

test('answer-question validates the native question and enters ordinary send admission with the packaged marker format', async (t) => {
  const { native, backend } = fixture(t); const id = JSON.stringify(['request_user_input_async', 'call_original', 0]);
  const subscription = backend.subscribe('session-1', () => {}); await until(() => native.subscriptions === 1);
  native.snapshot('session-1', { turns: [{ turnId: 'async-turn', status: 'completed', items: [{ id: 'call_original', type: 'agentMessage', text: 'Native question', questions: [{ title: 'Native question', options: ['A', 'B'] }] }] }] }); await subscription;
  await backend.command('session-1', 'answer-question', { questionItemId: id, answer: 'Other free text' }, 'native-async-answer');
  const action = native.actions.at(-1); assert.equal(action?.method, 'send'); assert.equal(action?.payload.id, 'session-1');
  const packet = action?.payload.text; assert.ok(packet.startsWith('<send_user_message_question_reply>\n')); assert.ok(packet.endsWith('\n</send_user_message_question_reply>'));
  assert.deepEqual(JSON.parse(packet.slice(34, -35)), [{ questionItemId: id, question: 'Native question', answer: 'Other free text' }]);
  const view = await backend.snapshot('session-1'); assert.equal(view.rows[0].asyncQuestions?.[0].answered, false);
  await assert.rejects(backend.command('session-1', 'answer-question', { questionItemId: 'another-session-question', answer: 'A' }, 'bad-async-answer'), { code: 'stale-question' });
  assert.equal(native.actions.length, 1);
});

test('explicit open-desktop uses normal URL navigation and never creates owner or sends a turn', async(t)=>{
  /** @type {string[]} */ const uris=[];const native=new NativeFixture();const backend=new CodexBackend({ipc:/** @type {import('../src/adapters/codex-ipc.mjs').CodexIpcAdapter} */(/** @type {unknown} */(native)),openDesktop:async(uri)=>{uris.push(uri);}});t.after(()=>backend.dispose());
  const id='00000000-1111-2222-3333-444444444444';
  assert.deepEqual(await backend.command(id,'open-desktop',{},'open-fixture'),{action:'open-desktop',requested:true,ownerReady:false});
  assert.deepEqual(uris,[`codex://threads/${id}`]);assert.equal(native.actions.length,0);assert.equal(native.subscriptions,0);
  await assert.rejects(backend.command(id,'open-desktop',{prompt:'forbidden'},'bad-payload'),{code:'invalid-payload'});
  await assert.rejects(backend.command('not-a-real-id','open-desktop',{},'bad-id'),{code:'unsupported-desktop-open'});
  native.hostId='remote';await assert.rejects(backend.command(id,'open-desktop',{},'remote-open'),{code:'unsupported-desktop-open'});
});
