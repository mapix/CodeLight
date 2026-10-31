import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeLightProjectActivityController, CodeLightProjectActivityStore, parseActivityReply } from './codeLightProjectActivity';

const project = { id: 'project-A', projectKey: '/fixture', hostId: 'local', machineId: 'Mac' };
type RequestParams = { clientId: string; requestSeq: number; groups: Array<{ id: string; projectKey: string; hostId: string }> };
const reply = (values = {}, sequence = 1, epoch = 'native-epoch') => ({ ok: true, version: 1, epoch, sequence, observedAt: 1000,
    groups: [{ id: project.id, total: 3, active: 1, waiting: 1, unknown: 1, status: 'ready', ...values }] });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('supports overlapping active/waiting while preserving unknown coverage and rejecting false counters', () => {
    expect(parseActivityReply(reply({ total: 1, active: 1, waiting: 1, unknown: 0 })).groups[0]).toMatchObject({ active: 1, waiting: 1 });
    expect(() => parseActivityReply(reply({ total: 1, active: 1, unknown: 1 }))).toThrow();
    expect(() => parseActivityReply({ ...reply(), version: 2 })).toThrow();
});

it('stores only public summaries and rejects stale sequence or foreign project replies', () => {
    const store = new CodeLightProjectActivityStore(); store.reset('account');
    const payload = reply({ history: ['private-text'], tools: ['private-tool'] }, 2);
    store.apply('Mac', payload, new Set([project.id]));
    expect(JSON.stringify(store.get(project.id))).not.toMatch(/private|history|tools/);
    store.apply('Mac', reply({ active: 0 }, 1), new Set([project.id]));
    expect(store.get(project.id).active).toBe(1);
    store.apply('Mac', { ...reply({}, 3), groups: [{ ...reply().groups[0], id: 'foreign' }] }, new Set([project.id]));
    expect(store.get('foreign').status).toBe('refreshing');
    expect(store.get(project.id).status).toBe('unavailable');
});

it('an unrelated project update does not notify this card or replace its snapshot', () => {
    const store = new CodeLightProjectActivityStore(); const changed = vi.fn();
    const unsubscribe = store.subscribe('other-project', changed), old = store.get('other-project');
    store.apply('Mac', reply(), new Set([project.id]));
    expect(changed).not.toHaveBeenCalled(); expect(store.get('other-project')).toBe(old); unsubscribe();
});

it('foreground polls are serialized and background releases interests without recurring work', async () => {
    const store = new CodeLightProjectActivityStore();
    let finish!: (value: unknown) => void;
    const request = vi.fn((_machine: string, params: RequestParams) => params.groups.length ? new Promise<unknown>(resolve => { finish = resolve; }) : Promise.resolve(reply()));
    const controller = new CodeLightProjectActivityController({ store, clientId: 'phone-client', scope: async () => 'account', request });
    controller.setProjects([project]);
    await vi.advanceTimersByTimeAsync(60000); expect(request).not.toHaveBeenCalled();
    controller.setEnabled(true); await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000); expect(request).toHaveBeenCalledTimes(1);
    controller.setEnabled(false); await Promise.resolve(); await Promise.resolve();
    expect(request.mock.calls[1][1]).toMatchObject({ groups: [], requestSeq: 2 });
    finish(reply()); await controller.refresh();
    expect(store.get(project.id).status).toBe('stale');
    await vi.advanceTimersByTimeAsync(60000); expect(request).toHaveBeenCalledTimes(2); controller.close();
});

it('an account switch discards an old encrypted result and clears its displayed counters', async () => {
    const store = new CodeLightProjectActivityStore(); let scope = 'old';
    let finish!: (value: unknown) => void;
    const request = vi.fn((_machine: string, _params: RequestParams) => new Promise<unknown>(resolve => { finish = resolve; }));
    const controller = new CodeLightProjectActivityController({ store, clientId: 'phone-client', scope: async () => scope, request });
    controller.setProjects([project]); controller.setEnabled(true); await Promise.resolve(); await Promise.resolve();
    scope = 'new'; finish(reply()); await controller.refresh();
    expect(store.get(project.id).status).toBe('refreshing');
    expect(store.get(project.id).active).toBe(0); controller.close();
});

it('no visible project releases the same client and suppresses subsequent polls', async () => {
    const store = new CodeLightProjectActivityStore();
    const request = vi.fn(async (_machine: string, _params: RequestParams) => reply());
    const controller = new CodeLightProjectActivityController({ store, clientId: 'phone-client', scope: async () => 'account', request });
    controller.setProjects([project]); controller.setEnabled(true); await controller.refresh();
    controller.setProjects([]); await Promise.resolve(); await Promise.resolve();
    expect(request.mock.calls[1][1]).toMatchObject({ groups: [], requestSeq: 2 });
    await vi.advanceTimersByTimeAsync(60000); expect(request).toHaveBeenCalledTimes(2); controller.close();
});

it('visible row status stays scoped and old project-only replies cannot retain a stale active row', () => {
    const store = new CodeLightProjectActivityStore(); store.reset('account');
    const wanted = new Map([[project.id, new Set(['phone-session'])]]);
    store.apply('Mac', reply({ sessions: [{ id: 'phone-session', known: true, active: true, waiting: true }, { id: 'foreign-row', known: true, active: true, waiting: false }] }), new Set([project.id]), wanted);
    expect(store.getSession('phone-session')).toMatchObject({ known: true, active: true, waiting: true, status: 'ready' });
    expect(store.getSession('foreign-row').known).toBe(false);
    const changed = vi.fn(); const unsubscribe = store.subscribeSession('other-row', changed);
    store.apply('Mac', reply({}, 2), new Set([project.id]), wanted);
    expect(store.getSession('phone-session').status).toBe('unavailable');
    expect(changed).not.toHaveBeenCalled(); unsubscribe();
    store.reset('other-account'); expect(store.getSession('phone-session').known).toBe(false);
});

it('row payload limits and unknown booleans cannot masquerade as confirmed runtime facts', () => {
    expect(() => parseActivityReply(reply({ sessions: [{ id: 'row', known: false, active: true, waiting: false }] }))).toThrow();
    expect(() => parseActivityReply(reply({ sessions: Array.from({ length: 65 }, (_, n) => ({ id: `row-${n}`, known: false, active: false, waiting: false })) }))).toThrow();
});
