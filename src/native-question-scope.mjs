/** @typedef {Record<string, any>} Value */

/** Current-turn prompts only; the native history remains the answer evidence owner.
 * @param {Value} view @returns {Value[]} */
export function pendingNativeAsyncQuestions(view) {
  // 没有 foreground turn 时采用原 owner 明确公布的最后一轮；显式空值不能退回旧行重新催答。
  const turnId = view.currentTurnId ?? (Object.hasOwn(view, 'latestTurnId') ? view.latestTurnId : view.rows?.at(-1)?.turnId);
  if (typeof turnId !== 'string' || !turnId) return [];
  return (view.rows ?? []).filter((/** @type {Value} */ row) => row.turnId === turnId)
    .flatMap((/** @type {Value} */ row) => row.asyncQuestions ?? [])
    .filter((/** @type {Value} */ question) => !question.answered && typeof question.questionItemId === 'string');
}
