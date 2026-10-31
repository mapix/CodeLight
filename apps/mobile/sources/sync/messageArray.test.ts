import { expect, it } from 'vitest';
import { mergeMessageArray, selectCatalog } from './messageArray';
it('retains references for lifecycle-only changes and sorts pending edits, removals and history correctly', () => {
    const previous = [{ id: 'new', at: 9 }, { id: 'old', at: 1 }];
    expect(mergeMessageArray(previous, [], [], m => m.at)).toBe(previous);
    expect(mergeMessageArray(previous, [previous[0]], [], m => m.at)).toBe(previous);
    const changed = { id: 'old', at: 11 };
    const next = mergeMessageArray(previous, [changed, { id: 'history', at: 0 }], [], m => m.at);
    expect(next.map(m => m.id)).toEqual(['old', 'new', 'history']);
    expect(next[1]).toBe(previous[0]);
    expect(mergeMessageArray(next, [], ['old'], m => m.at).map(m => m.id)).toEqual(['new', 'history']);
});
it('preserves stable tie order and gives the last replacement ownership', () => {
    const previous = [{ id: 'a', at: 4 }, { id: 'b', at: 4 }];
    expect(mergeMessageArray(previous, [{ id: 'b', at: 3 }, { id: 'b', at: 4 }, { id: 'c', at: 4 }], [], m => m.at).map(m => m.id)).toEqual(['a', 'b', 'c']);
});
it('does not re-sort a 10,000-session catalog after unrelated message writes', () => {
    const sessions = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [String(i), { id: String(i), updatedAt: i }]));
    const first = selectCatalog(sessions);
    for (let i = 0; i < 200; i++) expect(selectCatalog(sessions)).toBe(first);
    expect(first[0].id).toBe('9999');
});
