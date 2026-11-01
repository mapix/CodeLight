import { afterEach, expect, it, vi } from 'vitest';
import { abortBudget } from './abortBudget';
afterEach(() => { vi.useRealTimers(); });
it('uses native instance abort events and releases its timeout after completion', () => {
    vi.useFakeTimers(); const parent = new AbortController(), budget = abortBudget(parent.signal, 1000);
    parent.abort(); expect(budget.signal.aborted).toBe(true); budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
});
it('an unreachable read reaches its network budget without DOM static signal helpers', () => {
    vi.useFakeTimers(); const budget = abortBudget(undefined, 1000);
    expect(budget.signal.aborted).toBe(false); vi.advanceTimersByTime(1000);
    expect(budget.signal.aborted).toBe(true); budget.dispose();
});
