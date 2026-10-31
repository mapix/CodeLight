import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HappySessionTransport, encryptRecord, decryptRecord, deriveContentKeyPair, sealDataKey, unsealDataKey, deriveBlobKey, encryptBlob, decryptBlob } from '../src/happy/session-transport.mjs';

/** @typedef {Record<string, any>} Value */

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'happy-pure-transport-'));
  const key = new Uint8Array(32).fill(7), token = 'protocol-fixture-token-never-a-real-account';
  /** @type {Value[]} */ const messages = [];
  /** @type {Value[]} */ const posts = [];
  let loseNextAck = false, rejectPosts = false, getCount = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end('{}'); return; }
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (request.method === 'GET') {
      getCount += 1;
      const after = Number(url.searchParams.get('after_seq'));
      const available = messages.filter(m => m.seq > after);
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ messages: available.slice(0, 100), hasMore: available.length > 100 })); return;
    }
    if (request.method === 'POST') {
      /** @type {Buffer[]} */ const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); posts.push(body);
      if (rejectPosts) { response.writeHead(503); response.end('{}'); return; }
      const acks = body.messages.map((/** @type {Value} */ pending) => {
        let message = messages.find(m => m.localId === pending.localId);
        if (!message) { message = { id: `fixture-${messages.length + 1}`, localId: pending.localId, seq: messages.length + 1, content: { t: 'encrypted', c: pending.content }, createdAt: Date.now(), updatedAt: Date.now() }; messages.push(message); }
        return { id: message.id, localId: message.localId, seq: message.seq, createdAt: message.createdAt, updatedAt: message.updatedAt };
      });
      if (loseNextAck) { loseNextAck = false; response.destroy(); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ messages: acks })); return;
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const options = { serverOrigin: `http://127.0.0.1:${address.port}`, token, sessionId: 'fixture-session', encryptionKey: key, statePath: join(directory, 'checkpoint.json'), pollMs: 0, requestTimeoutMs: 1000 };
  return { directory, key, token, messages, posts, options, gets: () => getCount,
    loseAck: () => { loseNextAck = true; }, rejectPosts: () => { rejectPosts = true; }, allowPosts: () => { rejectPosts = false; },
    addPeer: (/** @type {unknown} */ record, /** @type {string|null} */ localId = 'peer-id') => messages.push({ id: `fixture-${messages.length + 1}`, seq: messages.length + 1, localId, content: { t: 'encrypted', c: encryptRecord(record, key) }, createdAt: 1000 + messages.length, updatedAt: 1000 + messages.length }),
    dispose: async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(() => resolveClose(undefined))); await rm(directory, { recursive: true, force: true }); } };
}

test('Happy JSON, key wrapping, content key derivation and blobs interoperate with original Happy crypto', async () => {
  const original = await import(new URL('./fixtures/happy-encryption.ts', import.meta.url).href);
  const key = new Uint8Array(32).fill(11), account = new Uint8Array(32).fill(3), value = { unicode: '完整中文😀', lines: ['first', 'second'], answer: false };
  assert.deepEqual(decryptRecord(Buffer.from(original.encryptWithDataKey(value, key)).toString('base64'), key), value);
  assert.deepEqual(original.decryptWithDataKey(Buffer.from(encryptRecord(value, key), 'base64'), key), value);
  assert.deepEqual(decryptRecord(Buffer.from(original.encryptLegacy(value, key)).toString('base64'), key, 'legacy'), value);
  assert.deepEqual(original.decryptLegacy(Buffer.from(encryptRecord(value, key, 'legacy'), 'base64'), key), value);
  const ours = deriveContentKeyPair(account), reference = original.deriveContentKeyPair(account);
  assert.ok(Buffer.from(ours.publicKey).equals(Buffer.from(reference.publicKey)));
  assert.ok(Buffer.from(ours.secretKey).equals(Buffer.from(reference.secretKey)));
  const wrapped = sealDataKey(key, ours.publicKey);
  assert.equal(wrapped.length, 105); assert.equal(wrapped[0], 0);
  assert.ok(Buffer.from(original.decryptBoxBundle(wrapped.subarray(1), reference.secretKey)).equals(Buffer.from(key)));
  const theirWrapped = Buffer.concat([Buffer.from([0]), Buffer.from(original.libsodiumEncryptForPublicKey(key, reference.publicKey))]);
  const decodedKey = unsealDataKey(theirWrapped, ours.secretKey); assert.ok(decodedKey);
  assert.ok(Buffer.from(decodedKey).equals(Buffer.from(key)));
  assert.ok(Buffer.from(deriveBlobKey(key)).equals(Buffer.from(original.deriveKey(key, 'Happy Blobs', ['session']))));
  const blob = new Uint8Array([0, 255, 12, 87]);
  assert.deepEqual(decryptBlob(encryptBlob(blob, deriveBlobKey(key)), deriveBlobKey(key)), blob);
  assert.equal(decryptRecord(encryptRecord(value, key), new Uint8Array(32)), null);
  const corrupted = Buffer.from(encryptRecord(value, key), 'base64'); corrupted[corrupted.length - 1] ^= 1;
  assert.equal(decryptRecord(corrupted.toString('base64'), key), null);
  assert.equal(unsealDataKey(new Uint8Array(81), ours.secretKey), null);
  assert.equal(decryptBlob(new Uint8Array(39), key), null);
  // 公开固定fixture：显式nonce的Happy box/GCM/secretbox格式，避免随未来实现一同漂移。
  const fixedWrapped = Buffer.from('AFfbSzWfI65eFG5OJRIFZwRyJQY0jBUMFHU9DJM9BNQhBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE+5MgHHQXD2M2vDoovZMbWsgeVrFF+lEQ9eRJpSegJiLu2R1HOx9wwH17aE4sqmMI', 'base64');
  const fixedDecoded = unsealDataKey(fixedWrapped, ours.secretKey); assert.ok(fixedDecoded);
  assert.ok(Buffer.from(fixedDecoded).equals(Buffer.from(key)));
  assert.ok(Buffer.from(original.decryptBoxBundle(fixedWrapped.subarray(1), reference.secretKey)).equals(Buffer.from(key)));
  assert.deepEqual(decryptRecord('AAQEBAQEBAQEBAQEBLBwiCC3t0dcIBuvg73iyZ7gdVgJ7KlMrgrarhDfybR/pw/9y/BJGohmDYBQZPM=', key), { fixture: 'Happy 中文😀' });
  assert.deepEqual(decryptBlob(Buffer.from('BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEKjbRgaxOdWDpsafKujBaT+GMNks=', 'base64'), key), blob);
  assert.equal(Buffer.from(deriveBlobKey(key)).toString('hex'), 'e3929404162377f05f4811e895f9c1beb56f4b22c0a7ec75b1306672c7586acc');
});

test('ordered batch delivery amortizes requests and keeps exact IDs through lost ACKs', async () => {
  const f = await fixture(); let transport = new HappySessionTransport(f.options);
  const records = Array.from({ length: 120 }, (_, index) => ({ localId: `batch-${index}`, record: { value: index } }));
  try {
    await transport.start({ connectSocket: false }); f.loseAck();
    await assert.rejects(transport.publishBatch(records), { code: 'sync-network-error' });
    const checkpoint = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    assert.equal(checkpoint.outbox.length, 120);
    const ciphertext = checkpoint.outbox.map((/** @type {Value} */ item) => item.content);
    await transport.close(); transport = new HappySessionTransport(f.options);
    await transport.start({ connectSocket: false });
    const acks = await transport.publishBatch(records);
    assert.equal(acks.length, 120); assert.equal(f.messages.length, 120);
    assert.deepEqual(f.messages.map((/** @type {Value} */ item) => item.localId), records.map(item => item.localId));
    assert.deepEqual(f.posts.slice(1).flatMap((/** @type {Value} */ post) => post.messages.map((/** @type {Value} */ item) => item.content)), ciphertext);
    assert.equal(f.posts.length, 4, 'One lost request plus three batches, rather than 120 POSTs');
    const posts = f.posts.length;
    await transport.publishBatch(records); assert.equal(f.posts.length, posts);
    await assert.rejects(transport.publishBatch([{ ...records[0], record: { value: 'changed' } }]), { code: 'record-conflict' });
  } finally { await transport.close(); await f.dispose(); }
});

test('constructor is inert and options/key checkpoint identity are explicit', async () => {
  const f = await fixture(); const transport = new HappySessionTransport(f.options);
  try {
    assert.equal(f.gets(), 0); await assert.rejects(readFile(f.options.statePath), { code: 'ENOENT' });
    assert.equal(transport.status().started, false); assert.deepEqual(transport.status().registeredRpcMethods, []);
    await assert.rejects(transport.publish('before-start', { role: 'user' }), { code: 'transport-not-started' });
    await transport.start({ connectSocket: false });
    assert.equal((await stat(f.options.statePath)).mode & 0o777, 0o600);
    await transport.close();
    const wrongKey = new HappySessionTransport({ ...f.options, encryptionKey: new Uint8Array(32).fill(8) });
    await assert.rejects(wrongKey.start({ connectSocket: false }), { code: 'checkpoint-identity-mismatch' }); await wrongKey.close();
    assert.throws(() => new HappySessionTransport({ ...f.options, serverOrigin: 'https://user:password@example.test' }), { code: 'invalid-transport-options' });
    assert.throws(() => new HappySessionTransport({ ...f.options, encryptionKey: new Uint8Array(31) }), { code: 'invalid-encryption-key' });
  } finally { await transport.close(); await f.dispose(); }
});

test('lost Happy ACK reload resends exactly the persisted ciphertext/localId and creates one log record', async () => {
  const f = await fixture(); let transport = new HappySessionTransport(f.options);
  try {
    await transport.start({ connectSocket: false }); f.loseAck();
    const record = { role: 'user', content: { type: 'text', text: 'UNIQUE_PRIVATE_TRANSPORT_FIXTURE_中文😀' } };
    await assert.rejects(transport.publish('stable-ack-loss', record), { code: 'sync-network-error' });
    const checkpoint = await readFile(f.options.statePath, 'utf8'), pending = JSON.parse(checkpoint).outbox[0];
    assert.equal(transport.status().receiveCursor, 0); assert.equal(f.messages.length, 1);
    assert.ok(!checkpoint.includes(record.content.text)); assert.ok(!checkpoint.includes(f.token)); assert.ok(!checkpoint.includes(Buffer.from(f.key).toString('base64')));
    await transport.close(); transport = new HappySessionTransport(f.options);
    await transport.start({ connectSocket: false });
    const ack = await transport.publish('stable-ack-loss', record);
    assert.equal(ack.id, f.messages[0].id); assert.equal(f.messages.length, 1);
    assert.equal(f.posts[0].messages[0].content, pending.content); assert.equal(f.posts[1].messages[0].content, pending.content);
    assert.equal(transport.status().pendingOutbox, 0);
    await assert.rejects(transport.publish('stable-ack-loss', { ...record, content: { type: 'text', text: 'changed' } }), { code: 'record-conflict' });
  } finally { await transport.close(); await f.dispose(); }
});

test('durable outbox retries FIFO and POST acknowledgments never skip an earlier peer input', async () => {
  const f = await fixture(); let transport = new HappySessionTransport(f.options);
  try {
    await transport.start({ connectSocket: false }); f.rejectPosts();
    await assert.rejects(transport.publish('first', { value: 1 }), { code: 'sync-http-error' });
    await assert.rejects(transport.publish('second', { value: 2 }), { code: 'sync-http-error' });
    f.addPeer({ role: 'user', content: { type: 'text', text: 'peer before producer ack' } }, 'phone-id');
    assert.equal(transport.status().receiveCursor, 0); await transport.close(); f.allowPosts();
    transport = new HappySessionTransport(f.options); await transport.start({ connectSocket: false }); await transport.catchUp();
    const lastPost = f.posts.at(-1); assert.ok(lastPost);
    assert.deepEqual(lastPost.messages.map((/** @type {Value} */ item) => item.localId), ['first', 'second']);
    const inbox = transport.listInbox(); assert.equal(inbox[0].localId, 'phone-id'); assert.equal(inbox[0].seq, 1); assert.equal(inbox[0].publishedByThisTransport, false);
    assert.equal(inbox[1].publishedByThisTransport, true); assert.equal(inbox[2].publishedByThisTransport, true);
    assert.equal(transport.status().receiveCursor, 3);
  } finally { await transport.close(); await f.dispose(); }
});

test('persisted inbox retains full outer identity and is not automatically replayed on restart', async () => {
  const f = await fixture(); let transport = new HappySessionTransport(f.options);
  try {
    f.addPeer({ role: 'user', content: { type: 'text', text: 'only a transport fixture' } }, null);
    /** @type {Value[]} */ const events = []; transport.on('record', record => events.push(record)); await transport.start({ connectSocket: false });
    assert.equal(events.length, 1); assert.equal(events[0].id, 'fixture-1'); assert.equal(events[0].localId, null); assert.equal(events[0].seq, 1); assert.equal(events[0].createdAt, 1000);
    await transport.close(); transport = new HappySessionTransport(f.options);
    let replay = 0, recoverable = 0; transport.on('record', () => { replay++; }); transport.on('recoverable-inbox', event => { recoverable += event.count; });
    await transport.start({ connectSocket: false }); assert.equal(replay, 0); assert.equal(recoverable, 1); assert.equal(transport.listInbox().length, 1);
    assert.equal(await transport.ackInbox('fixture-1'), true); assert.equal(await transport.ackInbox('fixture-1'), false);
    assert.equal(transport.listInbox().length, 0);
  } finally { await transport.close(); await f.dispose(); }
});

test('parallel publish operations persist stable IDs once and checkpoint conflicts fail before network dispatch', async () => {
  const f = await fixture(), transport = new HappySessionTransport(f.options);
  try {
    await transport.start({ connectSocket: false });
    const [a, b] = await Promise.all([transport.publish('parallel', { value: 'same' }), transport.publish('parallel', { value: 'same' })]);
    assert.equal(a.id, b.id); assert.equal(f.messages.length, 1);
    const secondOwner = new HappySessionTransport(f.options); await assert.rejects(secondOwner.start({ connectSocket: false }), { code: 'transport-in-use' }); await secondOwner.close();
    const checkpoint = await readFile(f.options.statePath, 'utf8'); await writeFile(f.options.statePath, checkpoint + '\n'); const before = f.posts.length;
    await assert.rejects(transport.publish('external-change', { value: 'not sent' }), { code: 'checkpoint-conflict' }); assert.equal(f.posts.length, before);
  } finally { await transport.close(); await f.dispose(); }
});

test('RPC registration is explicit, scoped and absent by default; disconnected calls cannot buffer side effects', async () => {
  const f = await fixture(), transport = new HappySessionTransport(f.options);
  try {
    assert.deepEqual(transport.status().registeredRpcMethods, []);
    assert.throws(() => transport.registerRpc('other:abort', () => {}), { code: 'invalid-rpc-method' });
    const remove = transport.registerReceiptHandler(() => ({ testOnly: true }));
    assert.deepEqual(transport.status().registeredRpcMethods, ['bridge-receipt', 'receipt']);
    await transport.start({ connectSocket: false }); await assert.rejects(transport.callRpc('bridge-receipt', { commandId: 'not-native' }), { code: 'rpc-disconnected', effectMayHaveOccurred: false });
    remove(); assert.deepEqual(transport.status().registeredRpcMethods, []);
    assert.ok(!JSON.stringify(transport).includes(f.token));
  } finally { await transport.close(); await f.dispose(); }
});

test('an ACK returned to a caller is isolated and repeated publication does not rewrite its durable state', async () => {
  const f = await fixture(), transport = new HappySessionTransport(f.options);
  try {
    await transport.start({ connectSocket: false });
    const ack = await transport.publish('immutable-ack', { value: 'original' });
    const actualId = ack.id, checkpoint = await readFile(f.options.statePath, 'utf8'), postCount = f.posts.length;
    ack.id = 'caller-mutation';
    const repeated = await transport.publish('immutable-ack', { value: 'original' });
    assert.equal(repeated.id, actualId); assert.equal(f.posts.length, postCount);
    assert.equal(await readFile(f.options.statePath, 'utf8'), checkpoint);
  } finally { await transport.close(); await f.dispose(); }
});

test('a malformed outer sequence cannot advance cursor and unreadable ciphertext remains an explicit captured inbox item', async () => {
  const f = await fixture(); let transport = new HappySessionTransport(f.options);
  try {
    f.addPeer({ value: 'gap' }); f.messages[0].seq = 2;
    await transport.start({ connectSocket: false });
    await assert.rejects(transport.catchUp(), { code: 'receive-gap-or-malformed-record' });
    assert.equal(transport.status().receiveCursor, 0); assert.equal(transport.listInbox().length, 0);
    f.messages[0].seq = 1; f.messages[0].content.c = 'not-valid-ciphertext';
    await transport.catchUp();
    const captured = transport.listInbox()[0]; assert.equal(captured.record, null); assert.equal(captured.decodeError, 'invalid-encrypted-record');
    assert.equal(captured.id, 'fixture-1'); assert.equal(transport.status().receiveCursor, 1);
  } finally { await transport.close(); await f.dispose(); }
});

test('close during startup releases the state owner without creating a late socket or record callback', async () => {
  const f = await fixture(), first = new HappySessionTransport(f.options);
  try {
    let records = 0; first.on('record', () => { records++; });
    const starting = first.start({ connectSocket: false }); const rejected = assert.rejects(starting, { code: 'transport-closed' });
    await first.close(); await rejected; assert.equal(records, 0); assert.equal(first.status().connected, false);
    const next = new HappySessionTransport(f.options); await next.start({ connectSocket: false }); await next.close();
  } finally { await first.close(); await f.dispose(); }
});
