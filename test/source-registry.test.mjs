import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SourceRegistry, sourceKey } from '../src/happy/source-registry.mjs';
import { encryptRecord, decryptRecord } from '../src/happy/session-transport.mjs';

/** @typedef {Record<string,any>} Value */

test('source identity includes host and never collapses sources with equal paths', () => {
  assert.notEqual(sourceKey({ app: 'codex', hostId: 'local', id: 'one', workspace: '/same' }), sourceKey({ app: 'codex', hostId: 'remote', id: 'one', workspace: '/same' }));
  assert.notEqual(sourceKey({ app: 'codex', hostId: 'local', id: 'one' }), sourceKey({ app: 'zcode', hostId: 'local', id: 'one' }));
});

test('lost registration ACK reuses the durable data key and returns one source binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-registry-'));
  let stored, attempts = 0;
  const fakeFetch = /** @type {typeof fetch} */ (async (_url, request) => {
    const body = JSON.parse(/** @type {string} */ (request?.body));
    stored ??= { id: 'server-source', ...body };
    if (++attempts === 1) throw Error('ACK lost after server registration');
    return new Response(JSON.stringify({ session: stored }), { status: 200 });
  });
  const registry = new SourceRegistry({ directory: dir, account: { serverUrl: 'http://127.0.0.1:1', token: 'test-token', secret: randomBytes(32).toString('base64') }, fetch: fakeFetch });
  const source = { app: 'codex', hostId: 'local', id: 'existing-owner-source', title: 'Test only' };
  try {
    await assert.rejects(registry.register(source, 'test-machine'));
    const before = JSON.parse(await readFile(join(dir, `${sourceKey(source)}.json`), 'utf8'));
    const binding = await registry.register(source, 'test-machine');
    assert.equal(binding.happySessionId, 'server-source'); assert.equal(binding.sessionKey, before.sessionKey);
    assert.equal(binding.metadata.nativeSession.catalogueAvailable, true);
    await registry.register(source, 'test-machine'); assert.equal(attempts, 2);
    const other = new SourceRegistry({ directory: dir, account: { serverUrl: 'http://127.0.0.1:1', token: 'other-test-token', secret: randomBytes(32).toString('base64') }, fetch: fakeFetch });
    await assert.rejects(other.register(source, 'test-machine'), /another CodeLight account/); assert.equal(attempts, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('product registration rejects deferred sources before writes; research registration is explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-registry-scope-')), path = join(dir, 'product');
  const account = { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token', secret: randomBytes(32).toString('base64') };
  let calls = 0;
  const fetch = /** @type {typeof globalThis.fetch} */ (async (_url, request) => {
    calls++; const body = JSON.parse(/** @type {string} */ (request?.body));
    return new Response(JSON.stringify({ session: { id: 'research-source', ...body } }));
  });
  const source = { app: 'zcode', hostId: 'local', id: 'window-only', kind: 'window' };
  try {
    const product = new SourceRegistry({ directory: path, account, fetch });
    for (const rejected of [source, { ...source, app: 'codex' },
      { ...source, app: 'codex', kind: 'session', metadata: { bridge: { controlMode: null } } },
      { ...source, app: 'codex', kind: 'session', metadata: { controlMode: 'unknown' } }]) {
      assert.throws(() => product.register(rejected, 'machine'), { code: 'unsupported-source' });
    }
    await assert.rejects(stat(path), { code: 'ENOENT' }); assert.equal(calls, 0);
    const research = new SourceRegistry({ directory: join(dir, 'research'), account, fetch, allowDeferredSources: true });
    const binding = await research.register(source, 'machine');
    assert.equal(binding.metadata.bridge.controlMode, 'window'); assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('machine declares the Codex summary capability while every runner remains unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-machine-scope-')), secret = randomBytes(32);
  const fakeFetch = /** @type {typeof fetch} */ (async (_url, request) => {
    const body = JSON.parse(/** @type {string} */ (request?.body));
    const metadata = /** @type {Value} */ (decryptRecord(body.metadata, new Uint8Array(secret), 'legacy'));
    assert.deepEqual(metadata.codeLight, { codexOnly: true, projectActivityVersion: 1 });
    for (const runner of ['codex', 'claude', 'gemini', 'openclaw', 'rig']) assert.equal(metadata.cliAvailability[runner], false);
    return new Response(JSON.stringify({ machine: { id: body.id } }));
  });
  try {
    const registry = new SourceRegistry({ directory: dir, account: { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token', secret: secret.toString('base64') }, fetch: fakeFetch });
    const machine = await registry.machine();
    assert.deepEqual(machine.metadata.codeLight, { codexOnly: true, projectActivityVersion: 1 });
    const saved = JSON.parse(await readFile(join(dir, 'machine.json'), 'utf8'));
    assert.deepEqual(saved.metadata.codeLight, machine.metadata.codeLight);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a saved Codex window binding remains historical and cannot bypass product registration scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-saved-scope-'));
  const account = { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token', secret: randomBytes(32).toString('base64') };
  const source = { app: 'codex', hostId: 'local', id: 'historical-window', kind: 'window' }; let calls = 0;
  const fakeFetch = /** @type {typeof fetch} */ (async (_url, request) => {
    calls++; const body = JSON.parse(/** @type {string} */ (request?.body));
    return new Response(JSON.stringify({ session: { id: 'historical-record', ...body } }));
  });
  try {
    const research = new SourceRegistry({ directory: dir, account, fetch: fakeFetch, allowDeferredSources: true });
    const old = await research.register(source, 'machine'), before = await readFile(old.bindingPath, 'utf8');
    const product = new SourceRegistry({ directory: dir, account, fetch: fakeFetch });
    await assert.rejects(product.register({ ...source, kind: 'session' }, 'machine'), { code: 'unsupported-source' });
    assert.equal(calls, 1); assert.equal(await readFile(old.bindingPath, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cold-start saved bindings include only registered owned Codex records with matching source hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-saved-bindings-'));
  const account = { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token', secret: randomBytes(32).toString('base64') };
  const registry = new SourceRegistry({ directory: dir, account }), before = new Map();
  /** @param {string} id @param {string} [app] @returns {Value} */
  function binding(id, app = 'codex') {
    const source = { app, id, hostId: 'local', kind: 'session' }, key = sourceKey(source);
    return { source, happySessionId: `record-${id}`, accountFingerprint: registry.fingerprint(), serverUrl: account.serverUrl, machineId: 'fixture-machine',
      sessionKey: randomBytes(32).toString('base64'), bindingPath: '/fixture/untrusted-path',
      metadata: { bridge: { source, controlMode: 'session', sourceKey: key }, nativeSession: { catalogueAvailable: true } } };
  }
  /** @param {Value} saved @param {string} [name] @param {string} [raw] */
  async function save(saved, name = `${sourceKey(saved.source)}.json`, raw = JSON.stringify(saved)) {
    const path = join(dir, name); before.set(path, raw); await writeFile(path, raw);
  }
  try {
    const current = binding('current'), legacy = binding('legacy'); delete legacy.metadata.bridge.controlMode;
    await save(current); await save(legacy);
    const pending = binding('pending'); delete pending.happySessionId; await save(pending);
    const foreignAccount = binding('foreign-account'); foreignAccount.accountFingerprint = 'another-account'; await save(foreignAccount);
    const foreignServer = binding('foreign-server'); foreignServer.serverUrl = 'http://127.0.0.1:2'; await save(foreignServer);
    const foreignSource = binding('foreign-source'); foreignSource.metadata.bridge.source = { ...foreignSource.source, id: 'different-owner' }; await save(foreignSource);
    const mismatchedBridgeHash = binding('wrong-bridge-hash'); mismatchedBridgeHash.metadata.bridge.sourceKey = 'f'.repeat(64); await save(mismatchedBridgeHash);
    const missingMetadata = binding('missing-metadata'); delete missingMetadata.metadata; await save(missingMetadata);
    const malformedKey = binding('malformed-key'); malformedKey.sessionKey = 'not-a-data-key'; await save(malformedKey);
    const malformedVersion = binding('malformed-version'); malformedVersion.metadataVersion = -1; await save(malformedVersion);
    const window = binding('window'); window.metadata.bridge.controlMode = 'window'; await save(window);
    const sourceWindow = binding('source-window'); sourceWindow.source.kind = 'window'; await save(sourceWindow);
    await save(binding('deferred-harness', 'zcode'));
    await save(binding('wrong-file-hash'), `${'0'.repeat(64)}.json`);
    await save(binding('malformed'), undefined, '{'); await save(binding('array'), undefined, '[]');
    await save(current, 'machine.json'); await save(current, `${sourceKey(current.source)}.json.pending.tmp`);
    await mkdir(join(dir, `${sourceKey(binding('directory').source)}.json`));
    await symlink(join(dir, `${sourceKey(current.source)}.json`), join(dir, `${sourceKey(binding('symlink').source)}.json`));
    const result = await registry.savedBindings();
    assert.deepEqual(result.map(value => value.source.id).sort(), ['current', 'legacy']);
    for (const saved of result) {
      assert.equal(saved.bindingPath, join(dir, `${sourceKey(saved.source)}.json`));
      assert.equal(saved.machineId, 'fixture-machine'); assert.equal(saved.accountFingerprint, registry.fingerprint());
    }
    for (const [path, content] of before) assert.equal(await readFile(path, 'utf8'), content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('saved bindings from a missing profile are empty without creating a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-saved-missing-')), path = join(dir, 'not-created');
  try {
    const registry = new SourceRegistry({ directory: path, account: { serverUrl: 'http://127.0.0.1:1', secret: randomBytes(32).toString('base64') } });
    assert.deepEqual(await registry.savedBindings(), []); await assert.rejects(stat(path), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function metadataFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codelight-catalogue-')), key = new Uint8Array(randomBytes(32));
  const source = { app: 'codex', hostId: 'local', id: 'fixture-native', kind: 'session', title: 'Fixture', updatedAt: 100, preview: 'Fixture history' };
  const metadata = { path: '/fixture', nativeSession: { title: source.title, updatedAt: source.updatedAt, parentId: null, agentName: '', preview: source.preview, isPinned: false, catalogueAvailable: true, preserved: 'old history evidence' },
    capabilities: { abort: false, steering: false }, nativeControls: { current: 'old-model' }, bridge: { source, controlMode: 'session', currentTurnId: 'original-turn' } };
  const binding = { source, metadata, metadataVersion: 4, happySessionId: 'fixture-record', sessionKey: Buffer.from(key).toString('base64'), bindingPath: join(dir, 'binding.json'),
    commands: [{ id: 'original-command', status: 'unknown' }], history: { untouched: true } };
  await writeFile(binding.bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const registry = new SourceRegistry({ directory: dir, account: { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token', secret: randomBytes(32).toString('base64') } });
  return { dir, key, source, metadata, binding, registry, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** @param {(event:string,request:Value)=>Promise<Value>} handler */
function socket(handler) {
  return /** @type {import('socket.io-client').Socket} */ (/** @type {unknown} */ ({ timeout: () => ({ emitWithAck: handler }) }));
}

test('catalogue removal rebases CAS, preserves owner controls/history and reappearance restores the same binding', async () => {
  const f = await metadataFixture(); let version = 5, calls = 0;
  let serverMetadata = { ...f.metadata, capabilities: { abort: true, steering: true }, nativeControls: { current: 'new-model' } };
  const peer = socket(async (event, request) => {
    assert.equal(event, 'update-metadata'); assert.equal(request.sid, f.binding.happySessionId); calls++;
    if (request.expectedVersion !== version) return { result: 'version-mismatch', version, metadata: encryptRecord(serverMetadata, f.key) };
    serverMetadata = /** @type {typeof serverMetadata} */ (decryptRecord(request.metadata, f.key)); version++;
    return { result: 'success', version, metadata: encryptRecord(serverMetadata, f.key) };
  });
  try {
    await f.registry.markUnavailable(f.binding, peer);
    assert.equal(calls, 2); assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, false);
    assert.deepEqual(f.binding.metadata.capabilities, { abort: true, steering: true });
    assert.deepEqual(f.binding.metadata.nativeControls, { current: 'new-model' });
    assert.equal(f.binding.metadata.nativeSession.preserved, 'old history evidence');
    const saved = JSON.parse(await readFile(f.binding.bindingPath, 'utf8'));
    assert.deepEqual(saved.commands, f.binding.commands); assert.deepEqual(saved.history, f.binding.history);
    assert.equal(saved.metadata.nativeSession.catalogueAvailable, false); assert.equal(saved.metadataVersion, 6);
    await f.registry.markUnavailable(f.binding, peer); assert.equal(calls, 2);
    await f.registry.refreshMetadata(f.binding, { ...f.source, title: 'Current title', workspace: '/fixture' }, peer);
    assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, true); assert.equal(calls, 3);
    assert.equal(f.binding.metadata.nativeSession.preserved, 'old history evidence');
    assert.deepEqual(f.binding.metadata.capabilities, { abort: true, steering: true });
    assert.equal(f.binding.happySessionId, 'fixture-record'); assert.equal(f.binding.sessionKey, Buffer.from(f.key).toString('base64'));
  } finally { await f.dispose(); }
});

test('invalid CAS metadata cannot replace an owned binding or its availability', async () => {
  const f = await metadataFixture();
  try {
    const foreign = { ...f.metadata, bridge: { ...f.metadata.bridge, source: { ...f.source, id: 'another-source' } } };
    for (const metadata of ['invalid-ciphertext', encryptRecord(null, f.key), encryptRecord([], f.key), encryptRecord(foreign, f.key)]) {
      await assert.rejects(f.registry.markUnavailable(f.binding, socket(async () => ({ result: 'version-mismatch', version: 5, metadata }))));
      assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, true); assert.equal(f.binding.metadataVersion, 4);
      assert.equal(JSON.parse(await readFile(f.binding.bindingPath, 'utf8')).metadata.nativeSession.catalogueAvailable, true);
    }
  } finally { await f.dispose(); }
});

test('rediscovery clears removed index project membership while retaining native owner fields', async () => {
  const f = await metadataFixture();
  Object.assign(f.binding.metadata.nativeSession, { projectKey: 'old-project', projectPath: '/old', projectLabel: 'Old project' });
  try {
    await f.registry.refreshMetadata(f.binding, { ...f.source, workspace: '/fixture' }, socket(async (_event, request) => ({
      result: 'success', version: request.expectedVersion + 1, metadata: request.metadata,
    })));
    for (const field of ['projectKey', 'projectPath', 'projectLabel']) assert.equal(Object.hasOwn(f.binding.metadata.nativeSession, field), false);
    assert.equal(f.binding.metadata.nativeSession.preserved, 'old history evidence');
    assert.equal(f.binding.metadata.bridge.currentTurnId, 'original-turn');
  } finally { await f.dispose(); }
});

test('lost binding persistence retries from server evidence without forgetting the catalogue change', async () => {
  const f = await metadataFixture(); const originalPath = f.binding.bindingPath;
  let version = 4, metadata = f.metadata, calls = 0;
  const peer = socket(async (_event, request) => {
    calls++;
    if (request.expectedVersion !== version) return { result: 'version-mismatch', version, metadata: encryptRecord(metadata, f.key) };
    metadata = /** @type {typeof metadata} */ (decryptRecord(request.metadata, f.key)); version++;
    return { result: 'success', version, metadata: encryptRecord(metadata, f.key) };
  });
  try {
    f.binding.bindingPath = f.dir;
    await assert.rejects(f.registry.markUnavailable(f.binding, peer));
    assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, true); assert.equal(f.binding.metadataVersion, 4);
    f.binding.bindingPath = originalPath;
    await f.registry.markUnavailable(f.binding, peer);
    const saved = JSON.parse(await readFile(originalPath, 'utf8'));
    assert.equal(saved.metadata.nativeSession.catalogueAvailable, false); assert.equal(saved.metadataVersion, 5); assert.equal(calls, 2);
  } finally { f.binding.bindingPath = originalPath; await f.dispose(); }
});

test('concurrent removal and rediscovery serialize their metadata writes for one owned binding', async () => {
  const f = await metadataFixture(); let version = 4, inFlight = 0, maximum = 0, calls = 0;
  let release = () => {}, entered = () => {};
  const hold = new Promise(resolve => { release = () => resolve(undefined); }), first = new Promise(resolve => { entered = () => resolve(undefined); });
  const peer = socket(async (_event, request) => {
    inFlight++; maximum = Math.max(maximum, inFlight); calls++;
    if (calls === 1) { entered(); await hold; }
    assert.equal(request.expectedVersion, version); version++;
    const metadata = decryptRecord(request.metadata, f.key); inFlight--;
    return { result: 'success', version, metadata: encryptRecord(metadata, f.key) };
  });
  try {
    const removed = f.registry.markUnavailable(f.binding, peer); await first;
    const rediscovered = f.registry.refreshMetadata(f.binding, { ...f.source, title: 'Rediscovered', workspace: '/fixture' }, peer);
    await Promise.resolve(); release(); await Promise.all([removed, rediscovered]);
    assert.equal(maximum, 1); assert.equal(calls, 2);
    assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, true); assert.equal(f.binding.metadata.nativeSession.title, 'Rediscovered');
    const saved = JSON.parse(await readFile(f.binding.bindingPath, 'utf8')); assert.equal(saved.metadataVersion, 6);
  } finally { release(); await f.dispose(); }
});
