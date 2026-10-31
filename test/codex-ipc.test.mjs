import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CodexIpcAdapter } from '../src/adapters/codex-ipc.mjs';

/** @typedef {Record<string, any>} Frame */
/** @param {Frame} value */
function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length); body.copy(frame, 4);
  return frame;
}

/** @param {import('node:test').TestContext} t @param {{hostId?:string,maxFrameBytes?:number,timeoutMs?:number}} [options]
 * @param {(frame:Frame,socket:net.Socket)=>boolean|void} [onRequest] */
async function fixture(t, options = {}, onRequest = () => false) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-ipc-test-'));
  const socketPath = join(directory, 'router.sock');
  /** @type {Frame[]} */ const frames = [];
  /** @type {Set<net.Socket>} */ const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (buffer.length < length + 4) return;
        const frame = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        frames.push(frame);
        if (onRequest(frame, socket)) continue;
        if (frame.type !== 'request') continue;
        if (frame.method === 'initialize') reply(socket, frame, { clientId: 'bridge-client' }, 'bridge-client');
        else if (frame.method === 'thread-owner-discovery') reply(socket, frame, { supportsUntrustedAppInput: true }, 'desktop-owner');
        else reply(socket, frame, { ok: true });
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const adapter = new CodexIpcAdapter({ socketPath, timeoutMs: 500, ...options });
  t.after(async () => {
    adapter.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { adapter, frames, sockets };
}

/** @param {net.Socket} socket @param {Frame} request @param {Frame} result @param {string} [owner] */
function reply(socket, request, result, owner = request.targetClientId ?? 'desktop-owner') {
  socket.write(encode({ type: 'response', requestId: request.requestId, method: request.method,
    resultType: 'success', handledByClientId: owner, result }));
}

test('generation is checked after dispatch discovery and never sends a stale plan to a new owner', async (t) => {
  let owner = 'desktop-owner';
  const f = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-owner-discovery') return false;
    reply(socket, frame, { supportsUntrustedAppInput: true }, owner); return true;
  });
  await f.adapter.discover('original-session');
  assert.equal(f.adapter.generation('original-session'), 'local:desktop-owner');
  owner = 'replacement-owner';
  await assert.rejects(f.adapter.send('original-session', 'fixture only', 'stale-owner-command', 'local:desktop-owner'), { code: 'source-epoch-changed' });
  assert.equal(f.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 0);
});

test('model settings read and update use the original follower versions and explicit CAS without starting a turn', async t => {
  const f = await fixture(t, {}, (frame, socket) => {
    if (frame.method === 'thread-follower-read-model-settings') { reply(socket, frame, { settings: { model: 'fixture-model', reasoningEffort: 'medium', modelProvider: 'fixture-provider' } }); return true; }
    if (frame.method === 'thread-follower-update-thread-settings') { reply(socket, frame, { applied: false }); return true; }
    return false;
  });
  assert.deepEqual(await f.adapter.readModelSettings('original-session'), { model: 'fixture-model', reasoningEffort: 'medium', modelProvider: 'fixture-provider' });
  const response = await f.adapter.updateModelSettings('original-session', { model: 'next-model', reasoningEffort: 'low', expectedModel: 'fixture-model', expectedReasoningEffort: 'medium' }, 'settings-id-stable', 'local:desktop-owner');
  assert.equal(response.result.applied, false);
  const read = f.frames.find(frame => frame.method === 'thread-follower-read-model-settings'), update = f.frames.find(frame => frame.method === 'thread-follower-update-thread-settings');
  assert.equal(read?.version, 1); assert.equal(update?.version, 2);
  assert.deepEqual(update?.params, { conversationId: 'original-session', threadSettings: { model: 'next-model', effort: 'low' }, activeTurnId: null, condition: { ifModelEquals: 'fixture-model', ifEffortEquals: 'medium' } });
  assert.equal(f.frames.some(frame => frame.method === 'thread-follower-start-turn'), false);
});

test('validated generation fixes the actual frame target and remains part of command identity', async (t) => {
  const f = await fixture(t);
  await f.adapter.send('original-session', 'fixture only', 'pinned-owner-command', 'local:desktop-owner');
  const call = f.frames.find(frame => frame.method === 'thread-follower-start-turn');
  assert.equal(call?.targetClientId, 'desktop-owner');
  await assert.rejects(f.adapter.send('original-session', 'fixture only', 'pinned-owner-command', 'local:another-owner'), { code: 'command-conflict' });
  assert.equal(f.frames.filter(frame => frame.method === 'thread-follower-start-turn').length, 1);
});

test('local send uses ordinary owner turn start without requesting cloud-only admission', async (t) => {
  const f = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-follower-start-turn') return false;
    if (frame.params.turnStart.context?.useUserMessageAdmission) {
      socket.write(encode({ type: 'response', requestId: frame.requestId, method: frame.method,
        resultType: 'error', error: 'User-message admission requires a cloud app-server host' }));
    } else reply(socket, frame, { result: { turn: { id: 'original-turn', status: 'inProgress' } } });
    return true;
  });
  const response = await f.adapter.send('original-session', 'fixture input', 'local-send-command', 'local:desktop-owner');
  assert.equal(response.result.result.turn.id, 'original-turn');
  const call = f.frames.find(frame => frame.method === 'thread-follower-start-turn');
  assert.ok(call);
  assert.deepEqual(call.params.turnStart.context, { inheritThreadSettings: true });
  assert.equal(call.params.turnStart.request.clientUserMessageId, 'local-send-command');
  assert.equal(call.targetClientId, 'desktop-owner');
});

/** @param {()=>boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Test condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('capability discovery declines owner and unknown requests without claiming a handler', async t => {
  const f = await fixture(t);
  await f.adapter.connect();
  const socket = [...f.sockets][0];
  for (const [index, method] of ['thread-owner-discovery', 'thread-follower-start-turn', 'unknown-method'].entries()) {
    socket.write(encode({ type: 'client-discovery-request', requestId: `capability-${index}`, request: {
      type: 'request', requestId: `original-${index}`, method, version: 99, params: {},
    } }));
  }
  await until(() => f.frames.filter(frame => frame.type === 'client-discovery-response').length === 3);
  assert.deepEqual(f.frames.filter(frame => frame.type === 'client-discovery-response'), [0, 1, 2].map(index => ({
    type: 'client-discovery-response', requestId: `capability-${index}`, response: { canHandle: false },
  })));
  assert.equal(f.adapter.owners.size, 0);
  assert.equal(f.adapter.subscriptions.size, 0);
});

test('forwarded requests receive native error envelopes without any session admission', async t => {
  const f = await fixture(t);
  await f.adapter.connect();
  const socket = [...f.sockets][0];
  const cases = [
    { method: 'thread-owner-discovery', version: 1, error: 'no-handler-for-request' },
    { method: 'thread-owner-discovery', version: 0, error: 'request-version-mismatch' },
    { method: 'unknown-method', version: 0, error: 'no-handler-for-request' },
    { method: 'unknown-method', version: 1, error: 'request-version-mismatch' },
    { method: 'thread-follower-start-turn', version: 2, error: 'no-handler-for-request' },
    { method: 'thread-follower-interrupt-turn', version: 3, error: 'no-handler-for-request' },
    { method: 'thread-follower-interrupt-turn', version: 4, error: 'no-handler-for-request' },
    { method: 'thread-follower-interrupt-turn', version: 5, hostId: 'remote', error: 'no-handler-for-request' },
    { method: 'thread-follower-interrupt-turn', version: 4, hostId: 'remote', error: 'request-version-mismatch' },
    { method: 'thread-follower-interrupt-turn', version: 5, hostId: 'local', error: 'no-handler-for-request' },
    { method: 'thread-follower-interrupt-turn', version: 3, hostId: 'local', error: 'request-version-mismatch' },
    { method: 'thread-follower-load-complete-history', version: 1, error: 'no-handler-for-request' },
    { method: 'thread-follower-remove-queued-message', version: 2, hostId: 'remote', error: 'no-handler-for-request' },
    { method: 'thread-follower-future-method', version: 1, hostId: 'remote', error: 'no-handler-for-request' },
  ];
  for (const [index, entry] of cases.entries()) {
    const request = { method: entry.method, version: entry.version, ...(entry.hostId ? { hostId: entry.hostId } : {}) };
    socket.write(encode({ type: 'request', requestId: `incoming-${index}`, ...request,
      params: { conversationId: 'fixture-session' }, sourceClientId: 'fixture-requester', targetClientId: 'bridge-client' }));
  }
  await until(() => f.frames.filter(frame => frame.type === 'response').length === cases.length);
  assert.deepEqual(f.frames.filter(frame => frame.type === 'response'), cases.map((entry, index) => ({
    type: 'response', requestId: `incoming-${index}`, resultType: 'error', error: entry.error,
  })));
  assert.equal(f.adapter.owners.size, 0);
  assert.equal(f.adapter.subscriptions.size, 0);
  assert.equal(f.adapter.commands.size, 0);
  assert.equal(f.frames.some(frame => frame.type === 'request' && frame.method !== 'initialize'), false);
});

test('a discovery timeout remains unconfirmed and is classified independently from mutation outcomes', async t => {
  const f = await fixture(t, { timeoutMs: 30 }, frame => frame.method === 'thread-owner-discovery');
  await assert.rejects(f.adapter.discover('fixture-cold-session'), { code: 'codex-discovery-timeout', status: 504 });
  assert.equal(f.adapter.owners.size, 0);
  assert.equal(f.adapter.subscriptions.size, 0);
  assert.equal(f.adapter.commands.size, 0);
  assert.equal(new CodexIpcAdapter().timeoutMs, 10000);
});

test('a malformed forwarded request fails protocol validation without inventing an acknowledgment', async t => {
  const f = await fixture(t);
  await f.adapter.connect();
  [...f.sockets][0].write(encode({ type: 'request', method: 'thread-owner-discovery', version: 1, params: {} }));
  await until(() => f.adapter.socket === null);
  assert.equal(f.frames.some(frame => frame.type === 'response'), false);
  assert.equal(f.adapter.owners.size, 0);
});

test('router request-timeout cannot become an idle or verified no-owner result', async t => {
  const f = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-owner-discovery') return false;
    socket.write(encode({ type: 'response', requestId: frame.requestId, resultType: 'error', error: 'request-timeout' }));
    return true;
  });
  await assert.rejects(f.adapter.discover('fixture-cold-session'), { code: 'codex-discovery-timeout', status: 504 });
  assert.equal(f.adapter.owners.has('fixture-cold-session'), false);
});

test('no-client-found removes stale owner evidence but only means no owner was verified', async t => {
  const f = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-owner-discovery') return false;
    socket.write(encode({ type: 'response', requestId: frame.requestId, resultType: 'error', error: 'no-client-found' }));
    return true;
  });
  f.adapter.owners.set('fixture-cold-session', { sessionId: 'fixture-cold-session', hostId: 'local', ownerClientId: 'stale-owner', supportsUntrustedAppInput: true });
  assert.equal(await f.adapter.discover('fixture-cold-session'), null);
  assert.equal(f.adapter.owners.has('fixture-cold-session'), false);
  assert.equal(f.frames.some(frame => frame.method?.startsWith('thread-follower-')), false);
});

test('honest initialize, owner discovery and fragmented targeted subscription', async (t) => {
  const { adapter, frames, sockets } = await fixture(t);
  await adapter.connect();
  assert.equal(frames[0].method, 'initialize');
  assert.equal(frames[0].version, 0);
  assert.equal(frames[0].params.clientType, 'agent-session-bridge');
  assert.equal(adapter.clientId, 'bridge-client');
  assert.deepEqual(await adapter.discover('test-session'), { sessionId: 'test-session', hostId: 'local',
    ownerClientId: 'desktop-owner', supportsUntrustedAppInput: true });
  /** @type {Frame[]} */ const received = [];
  const dispose = await adapter.subscribe('test-session', (frame) => received.push(frame));
  await until(() => frames.some((frame) => frame.method === 'thread-stream-following-changed'));
  const follow = frames.find((frame) => frame.method === 'thread-stream-following-changed');
  assert.equal(follow?.version, 1);
  assert.deepEqual(follow?.targetClientIds, ['desktop-owner']);
  assert.deepEqual(follow?.params, { conversationId: 'test-session', hostId: 'local', following: true });
  const socket = [...sockets][0];
  const state = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11,
    sourceClientId: 'desktop-owner', targetClientIds: ['bridge-client'], params: { conversationId: 'test-session',
      hostId: 'local', change: { type: 'snapshot', revision: 1, conversationState: { title: 'Fixture' } } } };
  // Other sessions and unexpected owners must never reach a selected-session callback.
  socket.write(encode({ ...state, params: { ...state.params, conversationId: 'unselected-session' } }));
  socket.write(encode({ ...state, sourceClientId: 'other-owner' }));
  const bytes = encode(state);
  socket.write(bytes.subarray(0, 2));
  socket.write(bytes.subarray(2, 7));
  socket.write(bytes.subarray(7));
  await until(() => received.some((frame) => frame.type === 'broadcast'));
  assert.deepEqual(received.filter((frame) => frame.type === 'broadcast'), [state]);
  dispose(); dispose();
  await until(() => frames.some((frame) => frame.params?.following === false));
  assert.equal(frames.filter((frame) => frame.params?.following === false).length, 1);
});

test('commands preserve native input and never submit a duplicate command ID', async (t) => {
  const { adapter, frames } = await fixture(t);
  const first = adapter.send('test-session', 'fixture input', 'command-1');
  assert.equal(adapter.send('test-session', 'fixture input', 'command-1'), first);
  await first;
  await assert.rejects(adapter.send('test-session', 'different input', 'command-1'), { code: 'command-conflict' });
  const request = frames.find((frame) => frame.method === 'thread-follower-start-turn');
  assert.equal(request?.version, 2);
  assert.equal(request?.sourceClientId, 'bridge-client');
  assert.equal(request?.targetClientId, 'desktop-owner');
  assert.equal(request?.hostId, undefined);
  assert.deepEqual(request?.params, { conversationId: 'test-session', turnStart: {
    request: { threadId: 'test-session', input: [{ type: 'text', text: 'fixture input', text_elements: [] }], clientUserMessageId: 'command-1' },
    context: { inheritThreadSettings: true } } });
  assert.equal(frames.filter((frame) => frame.method === 'thread-follower-start-turn').length, 1);
});

test('lost response and reconnect never replay an uncertain mutation', async (t) => {
  const { adapter, frames, sockets } = await fixture(t, { timeoutMs: 40 }, (frame) => frame.method === 'thread-follower-start-turn');
  const promise = adapter.send('test-session', 'fixture input', 'lost-command');
  await assert.rejects(promise, { code: 'codex-outcome-unknown' });
  for (const socket of sockets) socket.destroy();
  await until(() => adapter.socket === null);
  await adapter.connect();
  assert.equal(adapter.send('test-session', 'fixture input', 'lost-command'), promise);
  await assert.rejects(adapter.send('test-session', 'fixture input', 'lost-command'), { code: 'codex-outcome-unknown' });
  assert.equal(frames.filter((frame) => frame.method === 'thread-follower-start-turn').length, 1);
});

test('disconnect rejects pending mutation without a second submission', async (t) => {
  const { adapter, frames } = await fixture(t, {}, (frame, socket) => {
    if (frame.method === 'thread-follower-start-turn') { socket.destroy(); return true; }
    return false;
  });
  const promise = adapter.send('test-session', 'fixture input', 'disconnect-command');
  await assert.rejects(promise, { code: 'codex-disconnected' });
  await adapter.connect();
  assert.equal(adapter.send('test-session', 'fixture input', 'disconnect-command'), promise);
  await assert.rejects(promise);
  assert.equal(frames.filter((frame) => frame.method === 'thread-follower-start-turn').length, 1);
});

test('remote host version, explicit stale-turn interruption and approval identity', async (t) => {
  const { adapter, frames } = await fixture(t, { hostId: 'remote-host' });
  await adapter.interrupt({ sessionId: 'test-session', hostId: 'remote-host', turnId: 'expected-turn' }, 'interrupt-command');
  const request = frames.find((frame) => frame.method === 'thread-follower-interrupt-turn');
  assert.equal(request?.version, 5);
  assert.equal(request?.hostId, 'remote-host');
  assert.deepEqual(request?.params, { conversationId: 'test-session', mode: 'user-stop', expectedTurnId: 'expected-turn' });
  assert.throws(() => adapter.interrupt({ sessionId: 'test-session', hostId: 'local', turnId: 'expected-turn' }, 'wrong-host'), { code: 'host-mismatch' });
  assert.throws(() => adapter.interrupt({ sessionId: 'test-session', hostId: 'remote-host', turnId: '' }, 'missing-turn'), { code: 'invalid-input' });
  await adapter.respondApproval({ sessionId: 'test-session', hostId: 'remote-host', requestId: 'request-1', kind: 'command' }, 'decline', 'approval-command');
  const approval = frames.find((frame) => frame.method === 'thread-follower-command-approval-decision');
  assert.equal(approval?.version, 2);
  assert.deepEqual(approval?.params, { conversationId: 'test-session', requestId: 'request-1', decision: 'decline' });
});

test('response method and owner mismatch are rejected', async (t) => {
  const { adapter } = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-follower-start-turn') return false;
    socket.write(encode({ type: 'response', requestId: frame.requestId, resultType: 'success',
      method: 'thread-follower-steer-turn', handledByClientId: 'wrong-owner', result: {} }));
    return true;
  });
  await assert.rejects(adapter.send('test-session', 'fixture input', 'wrong-response'), { code: 'codex-protocol-error' });
});

test('unsupported selected-session stream version closes connection', async (t) => {
  const { adapter, sockets } = await fixture(t);
  await adapter.subscribe('test-session', () => {});
  [...sockets][0].write(encode({ type: 'broadcast', method: 'thread-stream-state-changed', version: 12,
    sourceClientId: 'desktop-owner', params: { conversationId: 'test-session', hostId: 'local',
      change: { type: 'snapshot', revision: 1, conversationState: {} } } }));
  await until(() => adapter.socket === null);
});

test('announced oversized frame is rejected before allocating its payload', async (t) => {
  const { adapter, sockets } = await fixture(t, { maxFrameBytes: 512 });
  await adapter.connect();
  const header = Buffer.alloc(4); header.writeUInt32LE(513);
  [...sockets][0].write(header);
  await until(() => adapter.socket === null);
  assert.equal(adapter.buffer.length, 0);
});

test('owner disconnection rediscovers and subscribes to the new existing owner', async (t) => {
  let owner = 'desktop-owner';
  const { adapter, frames, sockets } = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-owner-discovery') return false;
    reply(socket, frame, { supportsUntrustedAppInput: true }, owner);
    return true;
  });
  await adapter.subscribe('test-session', () => {});
  await until(() => frames.some((frame) => frame.params?.following === true));
  owner = 'new-desktop-owner';
  [...sockets][0].write(encode({ type: 'broadcast', method: 'client-status-changed', version: 0,
    sourceClientId: 'desktop-owner', params: { clientId: 'desktop-owner', status: 'disconnected', clientType: 'desktop' } }));
  await until(() => frames.some((frame) => frame.params?.following === true && frame.targetClientIds?.includes(owner)));
  assert.equal(adapter.owners.get('test-session')?.ownerClientId, owner);
  assert.equal(frames.some((frame) => frame.method?.startsWith('thread-follower-')), false);
});

test('explicit reconnect restores subscriptions and does not claim ownership', async (t) => {
  const { adapter, frames, sockets } = await fixture(t);
  await adapter.subscribe('test-session', () => {});
  await until(() => frames.some((frame) => frame.params?.following === true));
  const before = frames.filter((frame) => frame.params?.following === true).length;
  for (const socket of sockets) socket.destroy();
  await until(() => adapter.socket === null);
  await adapter.connect();
  await until(() => frames.filter((frame) => frame.params?.following === true).length > before);
  assert.equal(frames.some((frame) => frame.method === 'set-thread-ownership'), false);
  assert.equal(frames.some((frame) => frame.method?.startsWith('thread-follower-')), false);
});

test('temporary owner gap recovers when the replacement IPC client connects', async (t) => {
  /** @type {string|null} */ let owner = 'desktop-owner';
  const { adapter, frames, sockets } = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-owner-discovery') return false;
    if (owner) reply(socket, frame, { supportsUntrustedAppInput: true }, owner);
    else socket.write(encode({ type: 'response', requestId: frame.requestId, resultType: 'error', error: 'no-client-found' }));
    return true;
  });
  await adapter.subscribe('test-session', () => {});
  await until(() => frames.some((frame) => frame.params?.following === true));
  owner = null;
  [...sockets][0].write(encode({ type: 'broadcast', method: 'client-status-changed', version: 0,
    sourceClientId: 'desktop-owner', params: { clientId: 'desktop-owner', status: 'disconnected', clientType: 'desktop' } }));
  await until(() => frames.filter((frame) => frame.method === 'thread-owner-discovery').length >= 3);
  owner = 'replacement-owner';
  [...sockets][0].write(encode({ type: 'broadcast', method: 'client-status-changed', version: 0,
    sourceClientId: owner, params: { clientId: owner, status: 'connected', clientType: 'desktop' } }));
  await until(() => frames.some((frame) => frame.params?.following === true && frame.targetClientIds?.includes(owner)));
  assert.equal(adapter.owners.get('test-session')?.ownerClientId, owner);
});

test('all three typed native response contracts retain host and request identity', async (t) => {
  const { adapter, frames } = await fixture(t, { hostId: 'remote-host' });
  const target = { sessionId: 'test-session', hostId: 'remote-host', requestId: 'request-typed' };
  const answers = { answers: { question: { answers: ['Fixture'] } } };
  await adapter.respondUserInput(target, answers, 'typed-question');
  const userInput = frames.find((frame) => frame.method === 'thread-follower-submit-user-input');
  assert.equal(userInput?.version, 2);
  assert.deepEqual(userInput?.params, { conversationId: 'test-session', requestId: 'request-typed', response: answers });
  const permissions = { permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'path', path: '/fixture' } }] }, network: { enabled: false } }, scope: 'turn', strictAutoReview: true };
  await adapter.respondPermissions(target, permissions, 'typed-permission');
  const permission = frames.find((frame) => frame.method === 'thread-follower-permissions-request-approval-response');
  assert.equal(permission?.version, 2);
  assert.deepEqual(permission?.params.response, permissions);
  await adapter.respondElicitation(target, { action: 'cancel' }, 'typed-elicitation');
  assert.equal(frames.find((frame) => frame.method === 'thread-follower-submit-mcp-server-elicitation-response')?.version, 2);
  await assert.rejects(adapter.respondUserInput({ ...target, hostId: 'local' }, answers, 'wrong-host-answer'), { code: 'host-mismatch' });
  await assert.rejects(adapter.respondUserInput({ ...target, requestId: '' }, answers, 'missing-request-answer'), { code: 'invalid-request-id' });
});

test('invalid response schemas and prototype-bearing data never reach the native owner', async (t) => {
  const { adapter, frames } = await fixture(t);
  const target = { sessionId: 'test-session', hostId: 'local', requestId: 4 };
  await assert.rejects(adapter.respondUserInput(target, { answers: { question: { answers: [1] } } }, 'bad-answer'), { code: 'invalid-response' });
  await assert.rejects(adapter.respondUserInput(target, { answers: {}, extra: true }, 'extra-answer'), { code: 'invalid-response' });
  await assert.rejects(adapter.respondPermissions(target, { permissions: { network: { enabled: 'yes' } } }, 'bad-network'), { code: 'invalid-response' });
  await assert.rejects(adapter.respondPermissions(target, { permissions: { fileSystem: { entries: [{ access: 'admin', path: { type: 'path', path: '/fixture' } }] } } }, 'bad-access'), { code: 'invalid-response' });
  await assert.rejects(adapter.respondElicitation(target, { action: 'approve' }, 'bad-elicitation'), { code: 'invalid-response' });
  await assert.rejects(adapter.respondElicitation(target, JSON.parse('{"action":"accept","content":{"__proto__":{"polluted":true}}}'), 'proto-elicitation'), { code: 'invalid-response' });
  assert.equal(frames.length, 0);
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('steer supplies the restore context required by the real desktop owner without overriding execution settings', async (t) => {
  const { adapter, frames } = await fixture(t, {}, (frame, socket) => {
    if (frame.method !== 'thread-follower-steer-turn') return false;
    if (!frame.params.restoreMessage?.context) {
      socket.write(encode({ type: 'response', requestId: frame.requestId, resultType: 'error', error: 'missing-restore-context' }));
    } else {
      try {
        // The installed desktop's rr(input) performs this exact direct read before native steer admission.
        const input = frame.params.input[0];
        assert.equal(input.type, 'text');
        assert.equal(input.text_elements.length, 0);
        reply(socket, frame, { turnId: 'active-turn' });
      } catch {
        socket.write(encode({ type: 'response', requestId: frame.requestId, resultType: 'error', error: 'missing-text-elements-default' }));
      }
    }
    return true;
  });
  await adapter.steer('test-session', 'fixture steering input', 'steer-context-command');
  const params = frames.find((frame) => frame.method === 'thread-follower-steer-turn')?.params;
  assert.deepEqual(params.restoreMessage, { context: { prompt: 'fixture steering input', commentAttachments: [] } });
  assert.deepEqual(params.input, [{ type: 'text', text: 'fixture steering input', text_elements: [] }]);
  assert.equal(params.restoreMessage.cwd, undefined);
  assert.equal(params.restoreMessage.context.workspaceRoots, undefined);
  assert.equal(params.model, undefined);
  assert.equal(params.permissions, undefined);
});

test('snapshot refresh reuses the existing follower and owner without new initialization or business requests', async (t) => {
  const { adapter, frames } = await fixture(t);
  await adapter.subscribe('test-session', () => {});
  await until(() => frames.some((frame) => frame.method === 'thread-stream-following-changed'));
  const prior = frames.length;
  await adapter.refreshSnapshot('test-session');
  await until(() => frames.length > prior);
  assert.deepEqual(frames.at(-1), { type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: 'bridge-client',
    version: 1, targetClientIds: ['desktop-owner'], params: { conversationId: 'test-session', hostId: 'local', following: true } });
  assert.equal(frames.filter((frame) => frame.method === 'initialize').length, 1);
  assert.equal(frames.some((frame) => frame.method?.startsWith('thread-follower-')), false);
  await assert.rejects(adapter.refreshSnapshot('unsubscribed'), { code: 'codex-owner-unavailable' });
});
