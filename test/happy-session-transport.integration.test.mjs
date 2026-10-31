import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HappySessionTransport, HappyTransportError, deriveContentKeyPair, encryptRecord, decryptRecord, sealDataKey } from '../src/happy/session-transport.mjs';

/** @typedef {Record<string, any>} Value */

const enabled = process.env.HAPPY_TRANSPORT_INTEGRATION === '1';
const accountPath = process.env.HAPPY_TRANSPORT_TEST_ACCOUNT;

test('real isolated Happy server: encrypted v3/cursor recovery, scoped RPC, state CAS and blob upload/download', { skip: !enabled || !accountPath }, async () => {
  assert.ok(accountPath);
  const account = JSON.parse(await readFile(accountPath, 'utf8'));
  assert.equal(typeof account.token, 'string'); assert.equal(typeof account.secret, 'string'); assert.equal(typeof account.serverUrl, 'string');
  const origin = new URL(account.serverUrl).origin;
  const accountSecret = new Uint8Array(Buffer.from(account.secret, 'base64'));
  const contentPair = deriveContentKeyPair(accountSecret), key = new Uint8Array(randomBytes(32));
  const metadata = { path: '', host: 'transport-test-only', name: 'Transport protocol verification (no native source)', client: { id: 'transport-fixture', name: 'Transport fixture', version: '1' }, testOnly: true };
  const headers = { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' };
  const creation = await fetch(`${origin}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ tag: `transport-test-${randomUUID()}`, metadata: encryptRecord(metadata, key), dataEncryptionKey: Buffer.from(sealDataKey(key, contentPair.publicKey)).toString('base64') }) });
  assert.equal(creation.status, 200);
  const session = (await creation.json()).session;
  assert.equal(typeof session.id, 'string');
  const directory = await mkdtemp(join(tmpdir(), 'happy-live-transport-'));
  const common = { serverOrigin: origin, token: account.token, sessionId: session.id, encryptionKey: key, pollMs: 0, requestTimeoutMs: 10000, initialMetadata: metadata, metadataVersion: session.metadataVersion };
  let a = new HappySessionTransport({ ...common, statePath: join(directory, 'a.json') });
  let b = new HappySessionTransport({ ...common, statePath: join(directory, 'b.json') });
  let rpcCalls = 0;
  /** @type {Value[]} */ const records = [];
  a.registerReceiptHandler(params => { rpcCalls++; assert.equal(/** @type {Value} */ (params).commandId, 'fixture-readonly'); return { ok: true, testOnly: true, value: 'receipt-lookup-no-native-dispatch' }; });
  a.registerRpc('fixture-error', () => { throw new HappyTransportError('fixture-failed', 'Synthetic transport error, not a native action.', false); });
  b.on('record', record => records.push(record));
  try {
    await Promise.all([a.start(), b.start()]); assert.equal(a.status().connected, true); assert.equal(b.status().connected, true);
    const record = { role: 'user', content: { type: 'text', text: 'Happy encrypted transport fixture 中文😀; no native source is attached.' }, meta: { sentFrom: 'transport-test', testOnly: true } };
    const first = await a.publish('live-stable-local-id', record), repeated = await a.publish('live-stable-local-id', record);
    assert.equal(first.id, repeated.id);
    await Promise.all([a.catchUp(), b.catchUp()]);
    const observed = b.listInbox().find((/** @type {Value} */ item) => item.localId === 'live-stable-local-id'); assert.ok(observed);
    assert.equal(observed.id, first.id); assert.equal(observed.seq, first.seq); assert.equal(observed.record.content.text, record.content.text); assert.equal(observed.publishedByThisTransport, false);
    assert.equal(a.listInbox().find((/** @type {Value} */ item) => item.localId === 'live-stable-local-id').publishedByThisTransport, true);
    const remote = await fetch(`${origin}/v3/sessions/${session.id}/messages?after_seq=0&limit=100`, { headers });
    const remotePage = await remote.json(); assert.equal(remotePage.messages.filter((/** @type {Value} */ message) => message.localId === 'live-stable-local-id').length, 1);
    const remoteRecord = remotePage.messages.find((/** @type {Value} */ message) => message.localId === 'live-stable-local-id');
    assert.ok(!remoteRecord.content.c.includes(record.content.text)); assert.deepEqual(decryptRecord(remoteRecord.content.c, key), record);
    const lookup = /** @type {Value} */ (await b.callRpc('bridge-receipt', { commandId: 'fixture-readonly' })); assert.equal(lookup.testOnly, true); assert.equal(rpcCalls, 1);
    const alias = /** @type {Value} */ (await b.callRpc('receipt', { commandId: 'fixture-readonly' })); assert.equal(alias.testOnly, true); assert.equal(rpcCalls, 2);
    await assert.rejects(b.callRpc('fixture-error', { testOnly: true }), { code: 'fixture-failed', effectMayHaveOccurred: false });
    const updated = await Promise.all([a.updateMetadata(current => ({ ...current, fixtureA: true })), b.updateMetadata(current => ({ ...current, fixtureB: true }))]);
    assert.ok(updated.every(value => typeof value === 'object'));
    const metadataRead = await fetch(`${origin}/v1/sessions`, { headers });
    const metadataRows = (await metadataRead.json()).sessions;
    const currentRow = metadataRows.find((/** @type {Value} */ row) => row.id === session.id);
    const finalMetadata = /** @type {Value} */ (decryptRecord(currentRow.metadata, key)); assert.equal(finalMetadata.fixtureA, true); assert.equal(finalMetadata.fixtureB, true); assert.equal(finalMetadata.client.id, 'transport-fixture');
    const state = /** @type {Value} */ (await a.updateAgentState({ testOnly: true, requests: {}, controlledByUser: false })); assert.equal(state.testOnly, true);
    const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'));
    const uploaded = await a.uploadAttachment(bytes, { filename: 'transport-fixture.png' }); assert.equal(uploaded.size, bytes.length);
    const downloaded = await b.downloadAttachment(uploaded.ref); assert.ok(Buffer.from(downloaded).equals(Buffer.from(bytes)));
    await assert.rejects(b.downloadAttachment('sessions/different-session/attachments/11111111-1111-1111-1111-111111111111.enc'), { code: 'invalid-attachment-ref' });
    await b.close(); b = new HappySessionTransport({ ...common, statePath: join(directory, 'b.json') });
    let replay = 0, recovered = 0; b.on('record', () => { replay++; }); b.on('recoverable-inbox', event => { recovered += event.count; });
    await b.start(); assert.equal(replay, 0); assert.ok(recovered >= 1); assert.equal(b.listInbox()[0].id, first.id);
    await b.ackInbox(first.id); assert.equal(b.listInbox().some((/** @type {Value} */ item) => item.id === first.id), false);
    assert.equal(a.keepAlive(false, 'local'), true);
    console.log(JSON.stringify({ happyTransportLive: true, encryptedV3Dedup: true, rpcCalls, stateCAS: true, blobBytes: bytes.length, replayedOnReconnect: replay, originalNativeActions: 0, modelCalls: 0 }));
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await fetch(`${origin}/v1/sessions/${session.id}`, { method: 'DELETE', headers }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
