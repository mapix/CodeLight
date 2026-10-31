export interface CodeLightProjectDescriptor { id: string; projectKey: string; hostId: string; machineId: string; sessions?: Array<{ id: string; nativeId: string }> }
export interface CodeLightSessionActivity { known: boolean; active: boolean; waiting: boolean; status: 'ready' | 'refreshing' | 'unavailable' | 'stale'; observedAt: number }
export interface CodeLightProjectActivity {
    total: number; active: number; waiting: number; unknown: number;
    status: 'ready' | 'refreshing' | 'unavailable' | 'stale'; observedAt: number;
}
interface ActivityReply {
    ok: true; version: 1; epoch: string; sequence: number; observedAt: number;
    groups: Array<CodeLightProjectActivity & { id: string; sessions?: Array<{ id: string; known: boolean; active: boolean; waiting: boolean }> }>;
}
const EMPTY: CodeLightProjectActivity = Object.freeze({ total: 0, active: 0, waiting: 0, unknown: 0, status: 'refreshing', observedAt: 0 });
const EMPTY_SESSION: CodeLightSessionActivity = Object.freeze({ known: false, active: false, waiting: false, status: 'refreshing', observedAt: 0 });

/** Kept outside the large conversation store: status changes do not sort/decrypt the catalog. */
export class CodeLightProjectActivityStore {
    private values = new Map<string, CodeLightProjectActivity>();
    private listeners = new Map<string, Set<() => void>>();
    private sessions = new Map<string, CodeLightSessionActivity>();
    private sessionListeners = new Map<string, Set<() => void>>();
    private versions = new Map<string, { epoch: string; sequence: number }>();
    private scope = '';
    get(id: string) { return this.values.get(id) ?? EMPTY; }
    getSession(id: string) { return this.sessions.get(id) ?? EMPTY_SESSION; }
    subscribeSession(id: string, listener: () => void) {
        let set = this.sessionListeners.get(id); if (!set) { set = new Set(); this.sessionListeners.set(id, set); } set.add(listener);
        return () => { set!.delete(listener); if (!set!.size) this.sessionListeners.delete(id); };
    }
    subscribe(id: string, listener: () => void) {
        let set = this.listeners.get(id);
        if (!set) { set = new Set(); this.listeners.set(id, set); }
        set.add(listener);
        return () => { set!.delete(listener); if (!set!.size) this.listeners.delete(id); };
    }
    reset(scope: string) {
        if (scope === this.scope) return;
        this.scope = scope; this.values.clear(); this.sessions.clear(); this.versions.clear();
        for (const set of this.listeners.values()) for (const listener of set) listener();
        for (const set of this.sessionListeners.values()) for (const listener of set) listener();
    }
    mark(ids: readonly string[], status: 'refreshing' | 'unavailable' | 'stale') {
        for (const id of ids) this.set(id, { ...this.get(id), status });
    }
    markSessions(ids: readonly string[], status: 'refreshing' | 'unavailable' | 'stale') {
        for (const id of ids) this.setSession(id, { ...this.getSession(id), status });
    }
    private setSession(id: string, value: CodeLightSessionActivity) {
        const old = this.sessions.get(id);
        if (old && Object.keys(value).every(key => old[key as keyof CodeLightSessionActivity] === value[key as keyof CodeLightSessionActivity])) return;
        this.sessions.set(id, value); for (const listener of this.sessionListeners.get(id) ?? []) listener();
    }
    private set(id: string, value: CodeLightProjectActivity) {
        const old = this.values.get(id);
        if (old && Object.keys(value).every(key => old[key as keyof CodeLightProjectActivity] === value[key as keyof CodeLightProjectActivity])) return;
        this.values.set(id, value);
        for (const listener of this.listeners.get(id) ?? []) listener();
    }
    apply(machineId: string, raw: unknown, requested: ReadonlySet<string>, requestedSessions: ReadonlyMap<string, ReadonlySet<string>> = new Map()) {
        const reply = parseActivityReply(raw);
        const previous = this.versions.get(machineId);
        if (previous?.epoch === reply.epoch && reply.sequence < previous.sequence) return;
        this.versions.set(machineId, { epoch: reply.epoch, sequence: reply.sequence });
        const seen = new Set<string>();
        for (const group of reply.groups) {
            if (!requested.has(group.id)) continue;
            seen.add(group.id);
            const { id, sessions, ...value } = group;
            this.set(id, { ...value, observedAt: reply.observedAt });
            const wanted = requestedSessions.get(id) ?? new Set<string>(), received = new Set<string>();
            for (const row of sessions ?? []) if (wanted.has(row.id)) {
                received.add(row.id); this.setSession(row.id, { known: row.known, active: row.active, waiting: row.waiting, status: 'ready', observedAt: reply.observedAt });
            }
            for (const rowId of wanted) if (!received.has(rowId)) this.setSession(rowId, { ...EMPTY_SESSION, status: 'unavailable' });
        }
        const missing = [...requested].filter(id => !seen.has(id));
        this.mark(missing, 'unavailable');
        for (const id of missing) this.markSessions([...(requestedSessions.get(id) ?? [])], 'unavailable');
    }
}

/** Validate and copy only the small public fields; no future history field enters the store. */
export function parseActivityReply(raw: unknown): ActivityReply {
    const value = raw as Partial<ActivityReply> | null;
    if (!value || value.ok !== true || value.version !== 1 || typeof value.epoch !== 'string' || !value.epoch ||
        !Number.isSafeInteger(value.sequence) || value.sequence! < 0 || !Number.isSafeInteger(value.observedAt) || value.observedAt! < 0 ||
        !Array.isArray(value.groups) || value.groups.length > 16) throw Error('Unsupported project activity reply');
    const ids = new Set<string>();
    const rowIds = new Set<string>();
    let rowCount = 0;
    const groups = value.groups.map(group => {
        if (!group || typeof group.id !== 'string' || !group.id || ids.has(group.id) || !['ready', 'refreshing', 'unavailable'].includes(group.status)) throw Error('Invalid project activity group');
        ids.add(group.id);
        const counts = [group.total, group.active, group.waiting, group.unknown];
        if (counts.some(n => !Number.isSafeInteger(n) || n < 0 || n > 1_000_000) || group.active + group.unknown > group.total || group.waiting + group.unknown > group.total) throw Error('Invalid activity counters');
        const sessions = group.sessions?.map(row => {
            if (!row || typeof row.id !== 'string' || !row.id || rowIds.has(row.id) || typeof row.known !== 'boolean' || typeof row.active !== 'boolean' || typeof row.waiting !== 'boolean' || !row.known && (row.active || row.waiting)) throw Error('Invalid session activity');
            rowIds.add(row.id);
            rowCount++; if (rowCount > 64) throw Error('Too many session activity rows');
            return { id: row.id, known: row.known, active: row.active, waiting: row.waiting };
        });
        return { id: group.id, total: group.total, active: group.active, waiting: group.waiting, unknown: group.unknown, status: group.status, observedAt: value.observedAt!, ...(sessions ? { sessions } : {}) };
    });
    return { ok: true, version: 1, epoch: value.epoch, sequence: value.sequence!, observedAt: value.observedAt!, groups };
}

interface ControllerOptions {
    store: CodeLightProjectActivityStore; clientId: string;
    scope: () => Promise<string>;
    request: (machineId: string, params: { clientId: string; requestSeq: number; groups: Array<Omit<CodeLightProjectDescriptor, 'machineId'>> }) => Promise<unknown>;
    intervalMs?: number;
}

/** One serialized foreground loop, not one timer/request per project. */
export class CodeLightProjectActivityController {
    private projects: CodeLightProjectDescriptor[] = [];
    private enabled = false; private closed = false; private revision = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private flight: Promise<void> | null = null;
    private failures = 0;
    private requestOrder = 0;
    private lastScope = ''; private lastMachines = new Set<string>();
    constructor(private options: ControllerOptions) {}
    setProjects(projects: CodeLightProjectDescriptor[]) {
        const next = projects.slice(0, 16).sort((a, b) => a.id.localeCompare(b.id));
        if (JSON.stringify(next) === JSON.stringify(this.projects)) return;
        this.projects = next; this.revision++; this.clearTimer();
        if (!next.length) void this.release();
        else if (this.enabled) void this.refresh();
    }
    setEnabled(enabled: boolean) {
        if (this.closed || enabled === this.enabled) return;
        this.enabled = enabled; this.revision++; this.clearTimer();
        if (enabled) {
            this.options.store.mark(this.projects.map(p => p.id), 'refreshing');
            this.options.store.markSessions(this.projects.flatMap(p => p.sessions?.map(row => row.id) ?? []), 'refreshing');
            void this.refresh();
        } else {
            this.options.store.mark(this.projects.map(p => p.id), 'stale');
            this.options.store.markSessions(this.projects.flatMap(p => p.sessions?.map(row => row.id) ?? []), 'stale');
            void this.release();
        }
    }
    refresh(): Promise<void> {
        if (this.flight) return this.flight;
        if (!this.enabled || this.closed || !this.projects.length) return Promise.resolve();
        this.clearTimer();
        const revision = this.revision, projects = this.projects;
        const operation = (async () => {
            const scope = await this.options.scope();
            if (!this.current(revision)) return;
            if (!scope) { this.options.store.reset(''); return; }
            this.options.store.reset(scope);
            this.lastScope = scope;
            const buckets = new Map<string, CodeLightProjectDescriptor[]>();
            for (const project of projects) {
                const items = buckets.get(project.machineId) ?? [];
                items.push(project); buckets.set(project.machineId, items);
            }
            for (const [machine, items] of buckets) {
                if (!this.current(revision)) return;
                this.lastMachines.add(machine);
                const groups = items.map(({ machineId: _machine, ...group }) => group);
                const result = await this.options.request(machine, { clientId: this.options.clientId, requestSeq: ++this.requestOrder, groups });
                // 原账户/入口已变化的迟到回复不能写进当前项目；这条读链路不重放任何会话动作。
                if (!this.current(revision)) return;
                const currentScope = await this.options.scope();
                if (currentScope !== scope) { this.options.store.reset(currentScope); return; }
                this.options.store.apply(machine, result, new Set(items.map(item => item.id)), new Map(items.map(item => [item.id, new Set(item.sessions?.map(row => row.id) ?? [])])));
            }
            this.failures = 0;
        })().catch(() => {
            if (!this.current(revision)) return;
            this.failures++;
            this.options.store.mark(projects.map(p => p.id), 'unavailable');
            this.options.store.markSessions(projects.flatMap(p => p.sessions?.map(row => row.id) ?? []), 'unavailable');
        }).finally(() => {
            this.flight = null;
            if (this.enabled && !this.closed && this.projects.length) {
                const delay = revision !== this.revision ? 0 : Math.min((this.options.intervalMs ?? 10000) * (1 + this.failures), 30000);
                this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
            }
        });
        this.flight = operation;
        return operation;
    }
    private current(revision: number) { return this.enabled && !this.closed && revision === this.revision; }
    private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
    private async release() {
        const scope = this.lastScope, machines = [...this.lastMachines].map(machine => ({ machine, requestSeq: ++this.requestOrder })); this.lastMachines.clear();
        if (!scope || await this.options.scope().catch(() => '') !== scope) return;
        await Promise.allSettled(machines.map(({ machine, requestSeq }) => this.options.request(machine, { clientId: this.options.clientId, requestSeq, groups: [] })));
    }
    close() {
        if (this.closed) return;
        this.setEnabled(false); this.closed = true; this.revision++; this.clearTimer();
    }
}

export const codeLightProjectActivityStore = new CodeLightProjectActivityStore();
