import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexBackend, loadNativeCodexModelCatalog } from '../src/adapters/codex-backend.mjs';
/** @typedef {Record<string,any>} Value */
const models = [{ id: 'model-A', label: 'A', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'low' }, { id: 'model-B', label: 'B', reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }];
function nativeFixture() {
  let current = { model: 'model-A', reasoningEffort: 'medium', modelProvider: 'fixture-provider' }, applied = true, readbackChanged = false;
  const writes = /** @type {Value[]} */ ([]);
  const ipc = { hostId: 'local', readModelSettings: async () => ({ ...current }), updateModelSettings: async (/** @type {string} */ id, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
    writes.push({ id, payload, commandId }); if (applied) current = { ...current, model: readbackChanged ? 'different' : payload.model, reasoningEffort: payload.reasoningEffort }; return { result: { applied } };
  }, dispose: () => {} };
  const backend = new CodexBackend({ ipc: /** @type {any} */ (ipc), loadModelCatalog: async () => ({ models, catalogSource: 'fixture-provider' }) });
  return { backend, writes, change: (/** @type {Value} */ value) => { current = { ...current, ...value }; }, reject: () => { applied = false; }, unconfirmed: () => { readbackChanged = true; } };
}
const selection = { model: 'model-B', reasoningEffort: 'low', expectedModel: 'model-A', expectedReasoningEffort: 'medium' };
test('updates only original settings and confirms readback without sending or replacing a runtime', async () => {
  const f = nativeFixture();
  const result = await f.backend.command('native-session', 'update-settings', selection, 'model-settings-once');
  assert.equal(result.applied, true); assert.equal(result.controls.model.current.model, 'model-B'); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].id, 'native-session');
});
test('a stale UI snapshot and applied=false are definite conflicts, not successful changes', async () => {
  const stale = nativeFixture(); stale.change({ reasoningEffort: 'low' });
  await assert.rejects(stale.backend.command('native-session', 'update-settings', selection, 'stale-settings'), { code: 'settings-conflict' }); assert.equal(stale.writes.length, 0);
  const rejected = nativeFixture(); rejected.reject();
  await assert.rejects(rejected.backend.command('native-session', 'update-settings', selection, 'rejected-settings'), { code: 'settings-conflict' }); assert.equal(rejected.writes.length, 1);
});
test('unsupported choices and failed readback cannot be presented as applied', async () => {
  const unsupported = nativeFixture();
  await assert.rejects(unsupported.backend.command('native-session', 'update-settings', { ...selection, reasoningEffort: 'ultra' }, 'unsupported-settings'), { code: 'unsupported-model-settings' }); assert.equal(unsupported.writes.length, 0);
  const unknown = nativeFixture(); unknown.unconfirmed();
  const pending = await unknown.backend.command('native-session', 'update-settings', selection, 'unconfirmed-settings');
  assert.equal(pending.applied, true); assert.equal(pending.settingsReadbackConfirmed, false); assert.equal(pending.acknowledged, false); assert.equal(unknown.writes.length, 1);
});
test('provider IDs gate cached capabilities, so foreign account candidates cannot become available', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codelight-native-catalog-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), 'model_provider="own-provider"\n[model_providers.own-provider]\nmodel_catalog_url="https://fixture.example/models"\nexperimental_bearer_token="fixture-only"\n');
  await writeFile(join(home, 'models_cache.json'), JSON.stringify({ client_version: '0.165.0', identity: 'foreign-account-identity', models: [
    { slug: 'allowed-model', display_name: 'Allowed', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' },
    { slug: 'foreign-model', display_name: 'Foreign', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high' }
  ] }));
  const catalog = await loadNativeCodexModelCatalog('own-provider', 'allowed-model', { home, fetch: /** @type {typeof fetch} */ (async (_url, options) => {
    assert.equal(/** @type {Value} */ (options?.headers).Authorization, 'Bearer fixture-only');
    return new Response(JSON.stringify({ data: [{ id: 'allowed-model' }] }));
  }) });
  assert.deepEqual(catalog.models.map((/** @type {Value} */ m) => m.id), ['allowed-model']); assert.equal(catalog.catalogSource, 'provider-models+desktop-capabilities');
});
