import { expect, it } from 'vitest';
import { fetchCodeLightSessionPages, mergeCodeLightCatalog } from './codeLightSessionPages';
it('keeps the first server scan watermark when a later page has newer rows', async () => {
    let calls = 0;
    const request = (async () => new Response(JSON.stringify(++calls === 1
        ? { sessions: [{ id: 'a', updatedAt: 100 }], scanWatermark: 110, hasNext: true, nextCursor: 'next' }
        : { sessions: [{ id: 'b', updatedAt: 140 }], scanWatermark: 150, hasNext: false }))) as typeof fetch;
    const page = await fetchCodeLightSessionPages('https://fixture.example', {}, request);
    expect(page.watermark).toBe(110); // A changes at 120 after its first page; the next delta must include it.
});
it('warm catalogs overlap the server watermark and replace only changed IDs', async () => {
    const previous = [{ id: 'a', updatedAt: 200 }, { id: 'b', updatedAt: 300 }];
    const request = (async url => {
        expect(new URL(String(url)).searchParams.get('changedSince')).toBe('299');
        return new Response(JSON.stringify({ sessions: [{ id: 'a', updatedAt: 400 }], hasNext: false }));
    }) as typeof fetch;
    const data = await fetchCodeLightSessionPages('https://fixture.example', {}, request, undefined, undefined, { changedSince: 300 });
    const merged = mergeCodeLightCatalog(previous, data.sessions);
    expect(merged).toEqual([{ id: 'a', updatedAt: 400 }, previous[1]]);
    expect(merged[1]).toBe(previous[1]);
    expect(data.watermark).toBe(300);
});
it('loads every encrypted descriptor page instead of the legacy 150-session snapshot', async () => {
    const paths: string[] = [];
    const request = async (url: RequestInfo | URL) => {
        paths.push(String(url)); const last = paths.length === 3;
        return new Response(JSON.stringify({ sessions: Array.from({ length: last ? 37 : 200 }, (_, i) => ({ id: `${paths.length}-${i}` })), hasNext: !last, nextCursor: last ? null : `cursor-${paths.length}` }));
    };
    expect((await fetchCodeLightSessionPages('https://fixture.example', {}, request as typeof fetch)).sessions).toHaveLength(437);
    expect(paths[1]).toContain('cursor=cursor-1'); expect(paths[2]).toContain('cursor=cursor-2');
});
it('publishes the first metadata page before a delayed later page completes', async () => {
    let finish!: (response: Response) => void; let calls = 0;
    const published: number[] = [];
    const later = new Promise<Response>(resolve => { finish = resolve; });
    const request = (async () => ++calls === 1 ? new Response(JSON.stringify({ sessions: [{ id: 'first' }], hasNext: true, nextCursor: 'next' })) : later) as typeof fetch;
    const all = fetchCodeLightSessionPages('https://fixture.example', {}, request, undefined, (rows, progress) => { published.push(progress.found); expect(rows).toHaveLength(1); });
    await new Promise(resolve => setTimeout(resolve, 0)); expect(published).toEqual([1]); expect(calls).toBe(2);
    finish(new Response(JSON.stringify({ sessions: [{ id: 'second' }], hasNext: false, nextCursor: null })));
    expect((await all).sessions).toHaveLength(2); expect(published).toEqual([1, 2]);
});
it('retains already published rows when a subsequent page fails', async () => {
    let calls = 0, visible = 0;
    const request = (async () => ++calls === 1 ? new Response(JSON.stringify({ sessions: [{ id: 'first' }], hasNext: true, nextCursor: 'next' })) : new Response('', { status: 503 })) as typeof fetch;
    await expect(fetchCodeLightSessionPages('https://fixture.example', {}, request, undefined, rows => { visible += rows.length; })).rejects.toThrow('503');
    expect(visible).toBe(1);
});
