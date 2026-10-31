import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneAuth } from '../src/auth.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { parseAddress } from '../src/address.mjs';

test('session addresses reject traversal and distinguish applications', () => {
  assert.deepEqual(parseAddress({ app: 'zcode', id: 'ses_123' }), { app: 'zcode', id: 'ses_123' });
  assert.throws(() => parseAddress({ app: 'codex', id: '../secret' }));
  assert.throws(() => parseAddress({ app: 'other', id: 'safe' }));
});

test('pairing is single use, expires and authenticates only the full secret', () => {
  let now = 1000;
  const auth = new PhoneAuth({ now: () => now, ttl: 100 });
  const { cookie } = auth.pair(auth.pairCode, 'peer');
  assert.ok(auth.authorize(`bridge_session=${cookie}`));
  assert.throws(() => auth.authorize(`bridge_session=${cookie.slice(0, -1)}x`));
  assert.throws(() => auth.pair(auth.pairCode, 'other'));
  now += 101;
  assert.throws(() => auth.authorize(`bridge_session=${cookie}`));
});

test('wrong pairing codes are rate limited', () => {
  const auth = new PhoneAuth({ maxAttempts: 2 });
  assert.throws(() => auth.pair('wrong', 'peer'));
  assert.throws(() => auth.pair('wrong', 'peer'));
  assert.throws(() => auth.pair(auth.pairCode, 'peer'), { code: 'pair-rate-limited' });
});

test('lost response retries join the original command and conflicts fail', async () => {
  const registry = new CommandReceipts();
  let count = 0;
  const execute = async () => { count++; await new Promise((resolve) => setTimeout(resolve, 10)); return 'accepted'; };
  const [one, two] = await Promise.all([
    registry.run('phone:codex:id', 'command_123', { text: 'hello' }, execute),
    registry.run('phone:codex:id', 'command_123', { text: 'hello' }, execute)
  ]);
  assert.equal(count, 1);
  assert.equal(one, two);
  assert.equal(registry.query('phone:codex:id', 'command_123')?.status, 'complete');
  await assert.rejects(registry.run('phone:codex:id', 'command_123', { text: 'different' }, execute), { code: 'command-conflict' });
});

test('same application commands execute in order after native failure', async () => {
  const registry = new CommandReceipts();
  /** @type {number[]} */
  const order = [];
  const first = registry.run('codex', 'command_one', {}, async () => { order.push(1); throw Error('fail'); });
  const second = registry.run('codex', 'command_two', {}, async () => { order.push(2); });
  assert.equal((await first).status, 'failed');
  assert.equal((await second).status, 'complete');
  assert.deepEqual(order, [1, 2]);
});
