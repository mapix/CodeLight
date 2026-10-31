import { serverEndpoint } from '../utils/serverOrigin';

export async function fetchCodeLightSessionPages(origin: string, headers: Record<string, string>, request: typeof fetch = fetch, signal?: AbortSignal,
    onPage?: (sessions: unknown[], progress: { page: number; found: number; hasNext: boolean }) => Promise<void> | void, options?: { changedSince?: number }) {
    const sessions: unknown[] = [], cursors = new Set<string>(); let cursor: string | null = null, count = 0, watermark = options?.changedSince;
    do {
        const url = serverEndpoint(origin, '/v2/sessions'); url.searchParams.set('limit', '200'); if (cursor) url.searchParams.set('cursor', cursor);
        if (options?.changedSince && options.changedSince > 1) url.searchParams.set('changedSince', String(options.changedSince - 1));
        const response = await request(url.toString(), { headers, signal }); if (!response.ok) throw Error(`Session discovery failed: ${response.status}`);
        const page = await response.json() as { sessions: unknown[]; hasNext: boolean; nextCursor: string | null; scanWatermark?: number };
        if (count === 0 && Number.isSafeInteger(page.scanWatermark) && page.scanWatermark! > 1) watermark = page.scanWatermark;
        if (!Array.isArray(page.sessions)) throw Error('Invalid session page'); sessions.push(...page.sessions);
        cursor = page.hasNext ? page.nextCursor : null;
        if (page.hasNext && (!cursor || cursors.has(cursor))) throw Error('Invalid repeated session cursor'); if (cursor) cursors.add(cursor);
        count++;
        await onPage?.(page.sessions, { page: count, found: sessions.length, hasNext: page.hasNext });
    } while (cursor);
    return { sessions, watermark };
}

export function mergeCodeLightCatalog(previous: unknown[], changed: unknown[]) {
    const rows = new Map(previous.map(row => [(row as { id: string }).id, row]));
    for (const row of changed) rows.set((row as { id: string }).id, row);
    return [...rows.values()];
}
