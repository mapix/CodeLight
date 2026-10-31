import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingNativeAsyncQuestions } from '../src/native-question-scope.mjs';

test('only the current turn can prompt and resolving it never reopens an older question', () => {
  const old = { questionItemId: 'old', answered: false }, current = { questionItemId: 'current', answered: false };
  const view = { currentTurnId: 'new-turn', latestTurnId: 'new-turn', rows: [
    { turnId: 'old-turn', asyncQuestions: [old] }, { turnId: 'new-turn', asyncQuestions: [current] },
  ] };
  assert.deepEqual(pendingNativeAsyncQuestions(view), [current]);
  current.answered = true;
  assert.deepEqual(pendingNativeAsyncQuestions(view), []);
});
test('an empty newer turn retires older prompts while the latest idle turn can still ask', () => {
  const question = { questionItemId: 'old', answered: false };
  const rows = [{ turnId: 'old-turn', asyncQuestions: [question] }];
  assert.deepEqual(pendingNativeAsyncQuestions({ currentTurnId: null, latestTurnId: 'empty-new-turn', rows }), []);
  assert.deepEqual(pendingNativeAsyncQuestions({ currentTurnId: null, latestTurnId: 'old-turn', rows }), [question]);
  assert.deepEqual(pendingNativeAsyncQuestions({ currentTurnId: null, latestTurnId: null, rows }), []);
});
