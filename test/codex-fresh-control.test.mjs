import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { setTimeout as delay } from 'node:timers/promises';
/** @typedef {Record<string,any>} Value */

test('fresh reads coalesce and wait for an actual requested snapshot, then active answers steer', async () => {
  const id = 'fixture-thread';
  /** @type {(frame:Value)=>void} */ let callback = () => {};
  let refreshes = 0;
  /** @type {string[]} */ const actions = [];
  const question = JSON.stringify(['request_user_input_async', 'fixture-question', 0]);
  const state = { turns: [{ turnId: 'fixture-turn', status: 'inProgress', items: [{ id: 'fixture-question', type: 'agentMessage', text: 'Question', questions: [{ title: 'Choose', options: ['A'] }] }] }] };
  const frame = () => ({ type: 'broadcast', method: 'thread-stream-state-changed', params: { change: { type: 'snapshot', revision: 1, conversationState: state } } });
  const ipc = { generation: () => null,
    /** @param {string} _id @param {(frame:Value)=>void} cb */
    subscribe: async (_id, cb) => { callback = cb; callback(frame()); return () => {}; },
    /** @param {string} _id @param {()=>void} [requested] */
    refreshSnapshot: async (_id, requested) => { refreshes++; requested?.(); },
    send: async () => { actions.push('send'); return { result: {} }; },
    steer: async () => { actions.push('steer'); return { result: {} }; }, dispose() {} };
  const backend = new CodexBackend({ ipc: /** @type {import('../src/adapters/codex-ipc.mjs').CodexIpcAdapter} */ (/** @type {unknown} */ (ipc)), waitTimeoutMs: 1000, snapshotRefreshMs: 0 });
  try {
    const subscribe = await backend.subscribe(id, () => {});
    const first = backend.freshSnapshot(id), second = backend.freshSnapshot(id); assert.equal(first, second);
    await delay(5); assert.equal(refreshes, 1);
    let resolved = false; first.then(() => { resolved = true; }); await delay(5); assert.equal(resolved, false);
    callback(frame()); await first;
    const answer = backend.command(id, 'answer-question', { questionItemId: question, answer: 'A' }, 'fresh-answer-fixture');
    await delay(5); callback(frame()); await answer;
    assert.deepEqual(actions, ['steer']); subscribe();
  } finally { backend.dispose(); }
});
