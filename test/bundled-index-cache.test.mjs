import test from 'node:test';
import assert from 'node:assert/strict';
import { BundledCodexStorage } from '../src/happy/bundled-codex-storage.mjs';

test('unchanged index reuses work, returns isolated rows, and changes/TTL refresh safely', async () => {
  let signature = 'one', now = 0, calls = 0;
  const storage = new BundledCodexStorage({ signature: async () => signature, now: () => now, loadIndex: async () => { calls++; return [{ id: 'native', project: { label: 'one' } }]; } });
  const first = await storage.list('codex'); first[0].project.label = 'consumer-edit';
  assert.equal((await storage.list('codex'))[0].project.label, 'one'); assert.equal(calls, 1);
  signature = 'two'; await storage.list('codex'); assert.equal(calls, 2);
  now = 60001; await storage.list('codex'); assert.equal(calls, 3);
});

test('concurrent reads share one flight and a failed read never publishes an empty catalog', async () => {
  let calls = 0, fail = true;
  const storage = new BundledCodexStorage({ signature: async () => 'same', loadIndex: async () => { calls++; if (fail) throw Error('read failed'); return [{ id: 'native' }]; } });
  await assert.rejects(storage.list('codex')); assert.equal(storage.cache.size, 0);
  fail = false; const results = await Promise.all([storage.list('codex'), storage.list('codex')]);
  assert.equal(calls, 2); assert.notEqual(results[0], results[1]); assert.equal(storage.cache.size, 1);
});
