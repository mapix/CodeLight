import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { renderRequests } from '../public/requests.js';
import { validateNativeResponse, validateFormResponse } from '../src/adapters/codex-response-schema.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {import('node:test').TestContext} t @param {Value[]} requests @param {Value[]} [rows] */
function fixture(t, requests, rows = []) {
  const window = new Window();
  const oldDocument = globalThis.document;
  /** @type {any} */ (globalThis).document = window.document;
  t.after(() => { /** @type {any} */ (globalThis).document = oldDocument; window.happyDOM.abort(); });
  const root = window.document.createElement('div'); window.document.body.append(root);
  /** @type {Array<{action:string,payload:Value}>} */ const calls = [];
  renderRequests(/** @type {any} */ (root), requests, async (action, payload) => { calls.push({ action, payload }); return true; }, rows);
  return { window, root, calls };
}
/** @param {Value} schema */
const formRequest = (schema) => ({ kind: 'elicitation', mode: 'form', requestId: 'native-fixture', operable: true, acceptSupported: true, allowedActions: ['accept', 'decline', 'cancel'], requestedSchema: schema });
/** @param {ReturnType<typeof fixture>} fixture */
async function submit(fixture) {
  fixture.root.querySelector('form')?.requestSubmit();
  await fixture.window.happyDOM.whenAsyncComplete();
  return fixture.calls.at(-1)?.payload;
}

test('real DOM assembles local-ref nested objects, titled enum arrays, decimals, defaults and null into valid native content', async (t) => {
  const schema = { type: 'object', $defs: { decimal: { type: 'number', minimum: 0, default: 1.5 } },
    properties: {
      profile: { type: 'object', properties: { count: { $ref: '#/$defs/decimal' }, enabled: { type: 'boolean', default: true } }, required: ['count', 'enabled'] },
      variant: { type: 'string', oneOf: [{ const: 'alpha', title: 'Alpha label' }, { const: 'beta', title: 'Beta label' }] },
      tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'Tag A' }, { const: 'b', title: 'Tag B' }] }, minItems: 1 },
      nullable: { type: ['integer', 'null'], default: null },
    }, required: ['profile', 'variant', 'tags', 'nullable'] };
  const f = fixture(t, [formRequest(schema)]);
  const decimal = f.root.querySelector('input[data-field-name=count]'); assert.equal(decimal?.getAttribute('step'), 'any');
  const select = /** @type {any} */ (f.root.querySelector('select[data-field-name=variant]')); assert.ok(select); select.value = '1';
  const tag = [...f.root.querySelectorAll('label')].find((label) => label.textContent === 'Tag B')?.querySelector('input'); assert.ok(tag); tag.click();
  const payload = await submit(f); assert.ok(payload);
  await validateNativeResponse('elicitation', payload.response);
  validateFormResponse({ mode: 'form', requestedSchema: schema }, payload.response);
  assert.deepEqual(payload.response.content, { profile: { count: 1.5, enabled: true }, variant: 'beta', tags: ['b'], nullable: null });
});

test('typed array DOM add/remove produces native arrays rather than text and preserves item requirements', async (t) => {
  const schema = { type: 'object', properties: { values: { type: 'array', minItems: 1, items: { type: 'integer', default: 2 } } }, required: ['values'] };
  const f = fixture(t, [formRequest(schema)]);
  const add = [...f.root.querySelectorAll('button')].find((button) => button.textContent === '新增一项'); assert.ok(add); add.click();
  const values = /** @type {any} */ (f.root.querySelectorAll('input[type=number]')); assert.equal(values.length, 2); values[1].value = '3';
  const payload = await submit(f); assert.ok(payload); validateFormResponse({ mode: 'form', requestedSchema: schema }, payload.response);
  assert.deepEqual(payload.response.content.values, [2, 3]);
});

test('blocking questions always allow free-text Other and submit the native question-ID mapping', async (t) => {
  const f = fixture(t, [{ kind: 'user-input', requestId: 'native-question', operable: true, questions: [
    { id: 'choice', question: 'Choose a label', other: false, secret: false, options: [{ label: 'A', description: 'First choice' }, { label: 'B', description: 'Second choice' }] },
  ] }]);
  const other = f.root.querySelector('input'); assert.ok(other); other.value = 'User supplied alternative';
  const payload = await submit(f); assert.ok(payload); await validateNativeResponse('user-input', payload.response);
  assert.deepEqual(payload.response, { answers: { choice: { answers: ['User supplied alternative'] } } });
  assert.ok(f.root.textContent.includes('First choice'));
});

test('async question DOM preselects but never auto-submits and routes free text as a native ordinary reply command', async (t) => {
  const id = JSON.stringify(['request_user_input_async', 'call_original', 0]);
  const f = fixture(t, [], [{ id: 'call_original', asyncQuestions: [{ questionItemId: id, sourceItemId: 'call_original', questionIndex: 0, title: 'Native async choice', options: ['A', 'B'], answered: false }] }]);
  assert.equal(f.calls.length, 0); assert.equal(f.root.querySelector('select')?.value, 'A');
  const input = f.root.querySelector('input'); assert.ok(input); input.value = 'Custom answer';
  await submit(f);
  assert.deepEqual(f.calls, [{ action: 'answer-question', payload: { questionItemId: id, answer: 'Custom answer' } }]);
});

test('permission summary preserves native special paths, subpaths and depth while payload remains schema-valid', async (t) => {
  const permissions = { network: { enabled: true }, fileSystem: { globScanMaxDepth: 2, entries: [
    { access: 'read', path: { type: 'special', value: { kind: 'root' } } },
    { access: 'write', path: { type: 'special', value: { kind: 'project_roots', subpath: 'docs' } } },
    { access: 'read', path: { type: 'special', value: { kind: 'tmpdir' } } },
  ] } };
  const f = fixture(t, [{ kind: 'permissions', requestId: 'permission-fixture', operable: true, requestedPermissions: permissions }]);
  assert.ok(f.root.textContent.includes('整个文件系统')); assert.ok(f.root.textContent.includes('项目根目录 / docs')); assert.ok(f.root.textContent.includes('匹配扫描深度：2'));
  const payload = await submit(f); assert.ok(payload); await validateNativeResponse('permissions', payload.response);
  assert.deepEqual(payload.response, { permissions, scope: 'turn' });
});

test('invalid URL does not crash sibling forms, and unsupported local-ref cycles never show false acceptance', async (t) => {
  const f = fixture(t, [
    { kind: 'elicitation', requestId: 'bad-url', operable: true, acceptSupported: true, mode: 'url', url: 'not a url' },
    formRequest({ $ref: '#' }),
    { kind: 'command', requestId: 'stdin', operable: true, acceptSupported: true, nativeKind: 'writeStdin', command: 'terminal input' },
    { kind: 'file', requestId: 'file', operable: true, acceptSupported: true, grantRoot: '/fixture', grantRootHonored: 'unverified', changes: [] },
  ]);
  assert.equal(f.root.querySelectorAll('section').length, 4);
  assert.ok(f.root.textContent.includes('验证链接无效')); assert.ok(f.root.textContent.includes('向终端发送')); assert.ok(f.root.textContent.includes('申请写入范围：/fixture'));
  assert.equal(f.root.querySelectorAll('form')[0].querySelector('button[type=submit]'), null);
  assert.equal(f.root.querySelectorAll('form')[1].querySelector('button[type=submit]'), null);
});

test('operable and allowedActions guards apply even to programmatic form submission', async (t) => {
  const f = fixture(t, [
    { kind: 'user-input', requestId: 'blocked-question', operable: false, questions: [{ id: 'q', question: 'Question', options: [] }] },
    { ...formRequest({ type: 'object', properties: {} }), allowedActions: ['cancel'] },
  ]);
  const input = f.root.querySelector('input'); assert.ok(input); input.value = 'attempted';
  f.root.querySelectorAll('form')[0].dispatchEvent(new f.window.Event('submit', { cancelable: true }));
  f.root.querySelectorAll('form')[1].dispatchEvent(new f.window.Event('submit', { cancelable: true }));
  await f.window.happyDOM.whenAsyncComplete(); assert.equal(f.calls.length, 0);
  assert.equal(/** @type {any} */ (f.root.querySelector('button[type=submit]'))?.disabled, true);
});
