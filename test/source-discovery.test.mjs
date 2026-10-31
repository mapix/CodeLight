import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSourceDiscovery } from '../src/happy/discovery.mjs';

/** @typedef {Record<string,any>} Value */
function fixture(allowDeferredSources = false, failIndex = false) {
  const source = { app: 'zcode', id: 'preserved-window', hostId: 'local', kind: 'window' };
  let windows = 0, adapters = 0, disposed = 0;
  const backend = { dispose: async () => {}, marker: 'original-codex-adapter' };
  const discovery = new LocalSourceDiscovery({
    allowDeferredSources,
    storage: { list: async (app) => { assert.equal(app, 'codex'); if (failIndex) throw Error('fixture unreadable index'); return [{ id: 'original-session', title: 'Fixture' }]; } },
    codexBackend: /** @type {import('../src/adapters/codex-backend.mjs').CodexBackend} */ (/** @type {unknown} */ (backend)),
    localWindows: async () => { windows++; return [source]; },
    createWindowAdapter: () => { adapters++; return { dispose: async () => { disposed++; } }; },
  });
  return { source, backend, discovery, counts: () => ({ windows, adapters, disposed }) };
}

test('default discovery reads only Codex and does not invoke the window scanner or adapter', async () => {
  const f = fixture();
  try {
    const result = await f.discovery.discover();
    assert.deepEqual(result.errors, []); assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].app, 'codex'); assert.equal(result.sources[0].kind, 'session');
    assert.equal(f.discovery.adapter(result.sources[0]), f.backend);
    assert.throws(() => f.discovery.adapter(f.source), { code: 'unsupported-source' });
    assert.deepEqual(f.counts(), { windows: 0, adapters: 0, disposed: 0 });
  } finally { await f.discovery.close(); }
});

test('index failure stays explicit and cannot be mistaken for a successful empty catalogue', async () => {
  const f = fixture(false, true);
  try {
    const result = await f.discovery.discover();
    assert.deepEqual(result.sources, []); assert.deepEqual(result.errors, ['codex-index-unavailable']);
    assert.equal(f.counts().windows, 0);
  } finally { await f.discovery.close(); }
});

test('historical window research requires an explicit constructor option and retains adapter ownership', async () => {
  const f = fixture(true);
  try {
    const result = await f.discovery.discover(); assert.equal(result.sources.length, 2);
    assert.equal(f.discovery.adapter(f.source), f.discovery.adapter(f.source));
    assert.deepEqual(f.counts(), { windows: 1, adapters: 1, disposed: 0 });
  } finally { await f.discovery.close(); }
  assert.equal(f.counts().disposed, 1);
});
