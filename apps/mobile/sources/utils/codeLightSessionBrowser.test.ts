import { expect, it } from 'vitest';
import { buildCodeLightBrowserRows, codeLightProjectKey, isCodeLightCodexSession } from './codeLightSessionBrowser';
import type { Session } from '../sync/storageTypes';
const session = (id: string, nativeId: string, parentId: string | null, title: string, updatedAt: number) => ({ id, updatedAt: 99999, metadata: { path: '/fixture/project', summary: { text: title }, bridge: { controlMode: 'session', source: { id: nativeId, hostId: 'local', app: 'codex' } }, nativeSession: { title, updatedAt, parentId, agentName: title, preview: title, isPinned: false } } }) as Session;
it('groups native parent identities independently from relay ids and sorts by original recency', () => {
    const data = [session('relay-old', 'native-old', null, 'Old', 1), session('relay-new', 'native-new', null, 'New', 20), session('relay-child', 'native-child', 'native-new', 'Worker', 21)];
    const projects = buildCodeLightBrowserRows(data, '', new Set(), new Set()).map(row => row.key);
    const rows = buildCodeLightBrowserRows(data, '', new Set(projects), new Set(['relay-new']));
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['relay-new', 'relay-child', 'relay-old']);
    expect(rows.find(row => row.key === 'relay-child')).toMatchObject({ child: true });
});
it('folds one project across main, worktrees and nested directories, including cross-worktree children', () => {
    const data = [session('main', 'native-main', null, 'Main', 1), session('tree', 'native-tree', null, 'Worktree', 2), session('child', 'native-child', 'native-main', 'Worker', 3)];
    data.forEach((s, i) => { s.metadata!.path = ['/repo/app', '/worktrees/a/app', '/repo/app/src'][i]; Object.assign(s.metadata!.nativeSession!, { projectKey: 'canonical-project', projectPath: '/repo/app', projectLabel: 'app' }); });
    const folded = buildCodeLightBrowserRows(data, '', new Set(), new Set()); expect(folded).toHaveLength(1); expect(folded[0]).toMatchObject({ kind: 'project', count: 3 });
    const open = buildCodeLightBrowserRows(data, '', new Set([folded[0].key]), new Set(['main'])); expect(open.filter(r => r.kind === 'project')).toHaveLength(1);
    expect(open.find(r => r.key === 'child')).toMatchObject({ child: true });
    expect(new Set(open.map(r => r.key)).size).toBe(open.length);
});
it('does not merge same-name independent projects or sources on different Macs', () => {
    const data = [session('a', 'native-a', null, 'A', 1), session('b', 'native-b', null, 'B', 2)];
    data.forEach((s, i) => Object.assign(s.metadata!.nativeSession!, { projectKey: `project-${i}`, projectPath: `/repo-${i}/app`, projectLabel: 'app' }));
    expect(buildCodeLightBrowserRows(data, '', new Set(), new Set())).toHaveLength(2);
    data[1].metadata!.nativeSession!.projectKey = 'project-0'; data[1].metadata!.machineId = 'other-Mac';
    expect(buildCodeLightBrowserRows(data, '', new Set(), new Set())).toHaveLength(2);
});
it('search finds child sessions even while their project and parent are collapsed', () => {
    const rows = buildCodeLightBrowserRows([session('relay', 'native', 'parent', 'Feynman worker', 1)], 'feynman', new Set(), new Set());
    expect(rows.some(row => row.key === 'relay')).toBe(true);
});

it('exports the existing project row identity for lightweight status consumers', () => {
    const row = session('relay', 'native', null, 'Worker', 1);
    Object.assign(row.metadata!.bridge!.source, { hostId: 'local', app: 'codex' });
    row.metadata!.machineId = 'machine';
    row.metadata!.nativeSession!.projectKey = 'canonical';
    const key = codeLightProjectKey(row);
    expect(key).toBe('project:["machine","local","codex"]:canonical');
    expect(buildCodeLightBrowserRows([row], '', new Set(), new Set())[0].key).toBe(key);
});

it('reads native recency once per matched session while ordering a multi-project catalog', () => {
    let recencyReads = 0;
    const data = Array.from({ length: 800 }, (_, index) => {
        const row = session(`relay-${index}`, `native-${index}`, null, `Worker ${index}`, index);
        row.metadata!.nativeSession!.projectKey = `project-${Math.floor(index / 40)}`;
        Object.defineProperty(row.metadata!.nativeSession!, 'updatedAt', { get: () => { recencyReads++; return index; } });
        return row;
    });
    const rows = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(rows).toHaveLength(20);
    expect(rows[0].key.endsWith(':project-19')).toBe(true);
    expect(recencyReads).toBe(data.length);
});

it('folds a minimal large catalog without spreading a project into function arguments', () => {
    // Minimal records exercise the argument-count limit without allocating full
    // conversation metadata or rendering 150,000 rows on the host.
    const size = 150_000;
    const bridge = { source: { app: 'codex' } };
    const data = Array.from({ length: size }, (_, index) => ({ id: `large-${index}`, updatedAt: index, metadata: { path: '/fixture/large', bridge } }) as Session);
    data.push({ id: 'small', updatedAt: -1, metadata: { path: '/fixture/small', bridge } } as Session);
    const rows = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'project', count: size, label: 'large' });
});

it('search renders a deep valid parent chain without recursive stack growth', () => {
    const size = 12_000;
    const data = Array.from({ length: size }, (_, index) => session(`relay-${index}`, `native-${index}`, index ? `native-${index - 1}` : null, `Worker ${index}`, index));
    const rows = buildCodeLightBrowserRows(data, 'worker', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'session')).toHaveLength(size);
    expect(rows[1]).toMatchObject({ key: 'relay-0', child: false });
    expect(rows.at(-1)).toMatchObject({ key: `relay-${size - 1}`, child: true });
});

it('a parent cycle keeps a stable visible root and renders each matching session once', () => {
    const data = [session('a', 'native-a', 'native-b', 'Worker A', 1), session('b', 'native-b', 'native-a', 'Worker B', 2), session('c', 'native-c', 'native-b', 'Worker C', 3)];
    const folded = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    const open = buildCodeLightBrowserRows(data, '', new Set([folded[0].key]), new Set());
    expect(open.filter(row => row.kind === 'session')).toEqual([expect.objectContaining({ key: 'a', child: false, children: 1 })]);
    const searched = buildCodeLightBrowserRows(data, 'worker', new Set(), new Set());
    expect(searched.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['a', 'b', 'c']);
    expect(new Set(searched.map(row => row.key)).size).toBe(searched.length);
    expect(data[0].metadata!.nativeSession!.parentId).toBe('native-b');
});

it('self-parent facts remain visible as a root with no phantom child', () => {
    const rows = buildCodeLightBrowserRows([session('self', 'native-self', 'native-self', 'Worker', 1)], 'worker', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'session')).toEqual([expect.objectContaining({ key: 'self', child: false, children: 0 })]);
});

it('a repeated native ID in another project cannot take over a parent link', () => {
    const data = [session('parent-a', 'shared-native', null, 'Parent A', 1), session('child-a', 'native-child', 'shared-native', 'Child A', 2), session('parent-b', 'shared-native', null, 'Parent B', 3)];
    data.forEach((row, index) => { row.metadata!.nativeSession!.projectKey = index === 2 ? 'project-b' : 'project-a'; });
    const groups = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    const rows = buildCodeLightBrowserRows(data, '', new Set(groups.map(row => row.key)), new Set(['parent-a']));
    expect(rows.find(row => row.key === 'child-a')).toMatchObject({ child: true });
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['parent-b', 'parent-a', 'child-a']);
});

it('missing or ambiguous native identities do not invent parent links', () => {
    const missing = session('missing', 'missing-native', null, 'Missing', 1);
    (missing.metadata!.bridge!.source as any).id = undefined;
    const missingRows = buildCodeLightBrowserRows([missing, session('child', 'native-child', 'undefined', 'Child', 2)], 'i', new Set(), new Set());
    expect(missingRows.find(row => row.key === 'child')).toMatchObject({ child: false });

    const ambiguous = [session('alias-a', 'shared', null, 'Alias A', 1), session('alias-b', 'shared', null, 'Alias B', 2), session('child', 'native-child', 'shared', 'Child', 3)];
    const rows = buildCodeLightBrowserRows(ambiguous, 'i', new Set(), new Set());
    expect(rows.find(row => row.key === 'child')).toMatchObject({ child: false });
});

it('native parent IDs remain isolated by host and foreign source app records are excluded', () => {
    const parent = session('parent', 'shared-native', null, 'Parent', 1);
    const child = session('child', 'child-native', 'shared-native', 'Child', 2);
    Object.assign(parent.metadata!.bridge!.source, { hostId: 'local', app: 'codex' });
    Object.assign(child.metadata!.bridge!.source, { hostId: 'remote', app: 'codex' });
    let rows = buildCodeLightBrowserRows([parent, child], 'a', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'project')).toHaveLength(2);
    expect(rows.find(row => row.key === 'child')).toMatchObject({ child: false });
    Object.assign(child.metadata!.bridge!.source, { hostId: 'local', app: 'zcode' });
    rows = buildCodeLightBrowserRows([parent, child], 'a', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'project')).toHaveLength(1);
    expect(rows.find(row => row.key === 'child')).toBeUndefined();
});

it('the viewer excludes foreign and window caches without deleting or changing them', () => {
    const codex = session('codex', 'native-codex', null, 'ZCode project work', 1);
    const foreign = session('foreign', 'native-foreign', null, 'Other harness', 2);
    foreign.metadata!.bridge!.source.app = 'claude-desktop';
    const window = session('window', 'native-window', null, 'Codex window', 3);
    window.metadata!.bridge!.controlMode = 'window';
    const absent = { id: 'absent', updatedAt: 4, metadata: { path: '/fixture/project', flavor: 'codex' } } as Session;
    const missingSource = { id: 'missing-source', updatedAt: 5, metadata: { path: '/fixture/project', bridge: {} } } as Session;
    const data = [codex, foreign, window, absent, missingSource];
    const before = JSON.stringify(data);
    expect(data.filter(isCodeLightCodexSession)).toEqual([codex]);
    const rows = buildCodeLightBrowserRows(data, 'window', new Set(), new Set());
    expect(rows).toHaveLength(0);
    expect(buildCodeLightBrowserRows(data, 'other harness', new Set(), new Set())).toHaveLength(0);
    const groups = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 1 });
    expect(JSON.stringify(data)).toBe(before);
});

it('legacy Codex records without controlMode remain compatible but unknown modes are not native sessions', () => {
    const legacy = session('legacy', 'native-legacy', null, 'Legacy Codex', 1);
    delete (legacy.metadata!.bridge as any).controlMode;
    const unknown = session('unknown', 'native-unknown', null, 'Unknown mode', 2);
    (unknown.metadata!.bridge as any).controlMode = 'unverified-mode';
    expect(isCodeLightCodexSession(legacy)).toBe(true);
    expect(isCodeLightCodexSession(unknown)).toBe(false);
    const rows = buildCodeLightBrowserRows([legacy, unknown], 'codex', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['legacy']);
});
