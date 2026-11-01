import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveObserverCheckpointPayload, readArchivedObserverRows, readObserverHistoryArchives } from '../src/happy/observer-history.mjs';
import { BridgeError } from '../src/errors.mjs';

const key = new Uint8Array(32).fill(4);
function fixtureState() {
  return { identity: { happySessionId: 'fixture', nativeId: 'original', bindingId: 'fixture-binding', source: { app: 'codex', id: 'original', hostId: 'local' }, keyFingerprint: 'fixture' },
    activeRowIds: ['current'], rows: [{ id: 'old', text: 'retained prefix', digest: 'prefix-digest', eventIds: ['old-event'], revision: 2 }, { id: 'current', text: 'current prefix' }],
    events: [{ id: 'old-event', localId: 'original-local-id', sent: true, ciphertext: 'original-acknowledged-body' }, { id: 'pending', sent: false, ciphertext: 'pending-original-body' }],
    commands: [{ id: 'unknown-original-id', state: 'unknown', payload: { answer: 'retained draft' } }] };
}

test('interrupted archive-before-checkpoint migration is idempotent and retains pending bodies, aliases and commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-history-')), path = join(directory, 'projection.json'), original = fixtureState();
  try {
    const first = structuredClone(original); await archiveObserverCheckpointPayload(first, path, key, 0);
    const files = await readdir(path + '.history'), before = await readFile(join(path + '.history', files[0]), 'utf8');
    const restarted = structuredClone(original); await archiveObserverCheckpointPayload(restarted, path, key, 0);
    assert.deepEqual(await readdir(path + '.history'), files); assert.equal(await readFile(join(path + '.history', files[0]), 'utf8'), before);
    assert.deepEqual(first, restarted); assert.deepEqual(first.commands, original.commands); assert.deepEqual(first.events[1], original.events[1]);
    assert.deepEqual(first.rows[0].eventIds, original.rows[0].eventIds); assert.equal(first.rows[1].text, original.rows[1].text);
    const history = await readObserverHistoryArchives(first, path, key);
    assert.deepEqual(history.events, [original.events[0]]); assert.deepEqual(history.rows, [original.rows[0]]);
    const restored = await readArchivedObserverRows(first, path, key, new Set(['old'])), oldRow = restored.get('old'); assert.ok(oldRow); assert.equal(oldRow.text, original.rows[0].text);
    await assert.rejects(readObserverHistoryArchives({ ...first, identity: { ...first.identity, nativeId: 'different' } }, path, key), error => error instanceof BridgeError && error.code === 'observer-history-invalid');
    await assert.rejects(readObserverHistoryArchives(first, path, new Uint8Array(32).fill(8)), error => error instanceof BridgeError && error.code === 'observer-history-invalid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an archive write failure preserves every active body and operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-history-failure-')), path = join(directory, 'projection.json'), state = fixtureState(), before = structuredClone(state);
  try {
    await writeFile(path + '.history', 'blocking file');
    await assert.rejects(archiveObserverCheckpointPayload(state, path, key, 0)); assert.deepEqual(state, before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
