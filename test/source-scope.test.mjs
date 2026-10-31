import test from 'node:test';
import assert from 'node:assert/strict';
import { isCodeLightCodexSource } from '../src/happy/source-scope.mjs';

test('current CodeLight scope accepts native Codex descriptors and legacy missing mode', () => {
  const source = { app: 'codex', kind: 'session', id: 'original-id', hostId: 'local' };
  assert.equal(isCodeLightCodexSource(source), true);
  assert.equal(isCodeLightCodexSource(source, {}), true);
  assert.equal(isCodeLightCodexSource(source, { bridge: { controlMode: 'session' } }), true);
  assert.equal(isCodeLightCodexSource({ app: 'codex' }, { controlMode: 'session' }), true);
});

test('window and unknown modes cannot promote a preserved descriptor into Codex support', () => {
  const source = { app: 'codex', kind: 'session' };
  for (const controlMode of ['window', 'unknown', '', null, false]) {
    assert.equal(isCodeLightCodexSource(source, { bridge: { controlMode } }), false);
    assert.equal(isCodeLightCodexSource(source, { controlMode }), false);
  }
  assert.equal(isCodeLightCodexSource(source, { bridge: { controlMode: 'session' }, controlMode: 'window' }), false);
  assert.equal(isCodeLightCodexSource({ ...source, kind: 'window' }, { bridge: { controlMode: 'session' } }), false);
  for (const app of ['zcode', 'claude-desktop', 'cursor', 'terminal', 'Codex', '']) assert.equal(isCodeLightCodexSource({ app }), false);
  for (const value of [null, undefined, [], 'codex']) assert.equal(isCodeLightCodexSource(value), false);
});
