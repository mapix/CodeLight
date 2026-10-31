import type { Session } from '../sync/storageTypes';

export type CodeLightBrowserRow = { kind: 'project'; key: string; path: string; label: string; count: number } | { kind: 'session'; key: string; session: Session; title: string; child: boolean; children: number; at: number };

/** A field-only boundary shared by the browser and its catalog total. */
export function isCodeLightCodexSession(session: Session): boolean {
    const bridge = session.metadata?.bridge;
    // 旧窗口/其他 harness 缓存不能继续冒充 Codex 会话；仅为缺少 mode 的旧 Codex 会话保留本地兼容。
    return session.metadata?.nativeSession?.catalogueAvailable !== false && bridge?.source?.app === 'codex' && (bridge.controlMode === 'session' || bridge.controlMode === undefined);
}

/** The catalog and lightweight project status use the same scoped identity. */
export function codeLightProjectKey(session: Session): string {
    const data = session.metadata;
    const scope = JSON.stringify([data?.machineId, data?.bridge?.source?.hostId, data?.bridge?.source?.app]);
    return `project:${scope}:${data?.nativeSession?.projectKey || data?.path || '/'}`;
}

type Entry = {
    session: Session;
    order: number;
    at: number;
    pinned: boolean;
    nativeId: string | undefined;
    parentId: string | null | undefined;
    title: string | undefined;
};
type Group = { key: string; entries: Entry[]; latestAt: number; order: number };

function sessionTitle(session: Session): string {
    return session.metadata?.nativeSession?.title || session.metadata?.summary?.text || session.metadata?.name || session.id.slice(0, 8);
}

function matchesSearch(session: Session, title: string, needle: string): boolean {
    if (title.toLocaleLowerCase().includes(needle)) return true;
    const data = session.metadata;
    for (const value of [data?.path, data?.nativeSession?.projectLabel, data?.nativeSession?.projectPath, data?.nativeSession?.agentName, data?.nativeSession?.preview, data?.bridge?.source.id]) {
        if (value?.toLocaleLowerCase().includes(needle)) return true;
    }
    return false;
}

const byRecency = (a: Entry, b: Entry) => b.at - a.at || a.order - b.order;
const byRootOrder = (a: Entry, b: Entry) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b);

/** Build a display forest without changing the original parent's evidence. */
function hierarchy(entries: Entry[]): { roots: Entry[]; children: Map<string, Entry[]> } {
    const nativeIndex = new Map<string, Entry>();
    const ambiguous = new Set<string>();
    for (const entry of entries) {
        if (!entry.nativeId || ambiguous.has(entry.nativeId)) continue;
        if (nativeIndex.has(entry.nativeId)) {
            nativeIndex.delete(entry.nativeId);
            ambiguous.add(entry.nativeId);
        } else nativeIndex.set(entry.nativeId, entry);
    }

    const parentById = new Map<string, string>();
    for (const entry of entries) {
        const parent = entry.parentId ? nativeIndex.get(entry.parentId) : undefined;
        if (parent) parentById.set(entry.session.id, parent.session.id);
    }

    // 原实现纯父子环没有 root，整组会话会消失；只断开稳定 ID 最小节点的展示边，保留原始父归属。
    const states = new Map<string, 1 | 2>();
    for (const entry of entries) {
        if (states.has(entry.session.id)) continue;
        const path: string[] = [];
        let current: string | undefined = entry.session.id;
        while (current && states.get(current) !== 2) {
            if (states.get(current) === 1) {
                const start = path.indexOf(current);
                let anchor = current;
                for (let index = start + 1; index < path.length; index++) if (path[index] < anchor) anchor = path[index];
                parentById.delete(anchor);
                break;
            }
            states.set(current, 1);
            path.push(current);
            current = parentById.get(current);
        }
        for (const id of path) states.set(id, 2);
    }

    const roots: Entry[] = [];
    const children = new Map<string, Entry[]>();
    for (const entry of entries) {
        const parent = parentById.get(entry.session.id);
        if (!parent) { roots.push(entry); continue; }
        let bucket = children.get(parent);
        if (!bucket) { bucket = []; children.set(parent, bucket); }
        bucket.push(entry);
    }
    roots.sort(byRootOrder);
    for (const bucket of children.values()) bucket.sort(byRecency);
    return { roots, children };
}

export function buildCodeLightBrowserRows(sessions: Session[], query: string, projects: Set<string>, parents: Set<string>): CodeLightBrowserRow[] {
    const needle = query.trim().toLocaleLowerCase();
    const groups = new Map<string, Group>();
    for (let order = 0; order < sessions.length; order++) {
        const session = sessions[order];
        if (!isCodeLightCodexSession(session)) continue;
        const data = session.metadata;
        const title = needle ? sessionTitle(session) : undefined;
        if (needle && !matchesSearch(session, title!, needle)) continue;
        const entry: Entry = {
            session, order, title,
            at: data?.nativeSession?.updatedAt ?? session.updatedAt,
            pinned: data?.nativeSession?.isPinned === true,
            nativeId: data?.bridge?.source.id,
            parentId: data?.nativeSession?.parentId,
        };
        const key = codeLightProjectKey(session);
        let group = groups.get(key);
        if (!group) { group = { key, entries: [], latestAt: entry.at, order }; groups.set(key, group); }
        group.entries.push(entry);
        // 巨项目不能用 Math.max(...members)：参数数量会溢出；最大时间在分组时计算一次，排序只读标量。
        if (entry.at > group.latestAt) group.latestAt = entry.at;
    }

    const ordered = [...groups.values()].sort((a, b) => b.latestAt - a.latestAt || a.order - b.order);
    const rows: CodeLightBrowserRow[] = [];
    for (const group of ordered) {
        const data = group.entries[0].session.metadata;
        const path = data?.nativeSession?.projectPath || data?.path || '/';
        rows.push({ kind: 'project', key: group.key, path, label: data?.nativeSession?.projectLabel || path.split(/[\\/]/).filter(Boolean).at(-1) || path, count: group.entries.length });
        if (!needle && !projects.has(group.key)) continue;

        // 父 ID 必须在同项目内解析；全局 native 索引会让另一项目的重复 ID 抢走父会话。
        const { roots, children } = hierarchy(group.entries);
        const stack = roots.map(entry => ({ entry, child: false })).reverse();
        const visited = new Set<string>();
        // 原递归 append 在深层子会话链上溢出；显式栈保持原有深度优先顺序和折叠规则。
        while (stack.length) {
            const { entry, child } = stack.pop()!;
            const session = entry.session;
            if (visited.has(session.id)) continue;
            visited.add(session.id);
            const descendants = children.get(session.id);
            entry.title ??= sessionTitle(session);
            rows.push({ kind: 'session', key: session.id, session, title: entry.title, child, children: descendants?.length ?? 0, at: entry.at });
            if (descendants && (needle || parents.has(session.id))) {
                for (let index = descendants.length - 1; index >= 0; index--) stack.push({ entry: descendants[index], child: true });
            }
        }
    }
    return rows;
}
