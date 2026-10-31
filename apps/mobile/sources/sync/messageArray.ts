/** Merge only changed rows into a newest-first array; lifecycle events keep the exact reference. */
export function mergeMessageArray<T extends { id: string }>(previous: T[], changed: T[], removed: readonly string[], key: (value: T) => number): T[] {
    if (!changed.length && !removed.length) return previous;
    const deleted = new Set(removed), updates = new Map(changed.map(row => [row.id, row]));
    const ordinals = new Map<string, number>();
    const retained: T[] = []; let dirty = false;
    for (let index = 0; index < previous.length; index++) {
        const row = previous[index]; ordinals.set(row.id, index);
        if (deleted.has(row.id) && !updates.has(row.id)) { dirty = true; continue; }
        if (updates.has(row.id)) {
            if (updates.get(row.id) === row) { updates.delete(row.id); retained.push(row); }
            else dirty = true;
        } else retained.push(row);
    }
    if (!dirty && !updates.size) return previous;
    let ordinal = previous.length;
    for (const row of updates.values()) if (!ordinals.has(row.id)) ordinals.set(row.id, ordinal++);
    const compare = (a: T, b: T) => key(b) - key(a) || ordinals.get(a.id)! - ordinals.get(b.id)!;
    const sorted = [...updates.values()].sort(compare), result: T[] = [];
    let i = 0, j = 0;
    while (i < retained.length && j < sorted.length) result.push(compare(retained[i], sorted[j]) <= 0 ? retained[i++] : sorted[j++]);
    return result.concat(retained.slice(i), sorted.slice(j));
}

type CatalogRow = { updatedAt: number; metadata?: { isSideChat?: boolean } | null };
const catalogs = new WeakMap<object, CatalogRow[]>();
/** Unrelated message writes must not repeatedly allocate/sort the whole encrypted catalog. */
export function selectCatalog<T extends CatalogRow>(sessions: Record<string, T>): T[] {
    let result = catalogs.get(sessions);
    if (!result) { result = Object.values(sessions).filter(row => !row.metadata?.isSideChat).sort((a, b) => b.updatedAt - a.updatedAt); catalogs.set(sessions, result); }
    return result as T[];
}
