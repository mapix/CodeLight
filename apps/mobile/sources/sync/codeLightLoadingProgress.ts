import { useSyncExternalStore } from 'react';
export type LoadingProgress = { generation: number; phase: 'idle' | 'loading' | 'complete' | 'error'; found: number; pages: number };
const initial: LoadingProgress = { generation: 0, phase: 'idle', found: 0, pages: 0 };
/** The sync runtime owns progress; obsolete fetches cannot finish a newer load. */
export class CodeLightLoadingProgress {
    private discovery = initial;
    private sessions = new Map<string, LoadingProgress>();
    private listeners = new Set<() => void>();
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private changed() { for (const listener of this.listeners) listener(); }
    getDiscovery = () => this.discovery;
    getSession = (id: string) => this.sessions.get(id) ?? initial;
    beginDiscovery() { const generation = this.discovery.generation + 1; this.discovery = { ...initial, generation, phase: 'loading' }; this.changed(); return generation; }
    updateDiscovery(generation: number, update: Partial<LoadingProgress>) {
        if (generation !== this.discovery.generation) return;
        this.discovery = { ...this.discovery, ...update, generation }; this.changed();
    }
    isCurrent(generation: number) { return generation === this.discovery.generation; }
    beginSession(id: string) { const generation = this.getSession(id).generation + 1; this.sessions.set(id, { ...initial, generation, phase: 'loading' }); this.changed(); return generation; }
    endSession(id: string, generation: number, failed = false) {
        const state = this.getSession(id); if (state.generation !== generation) return;
        this.sessions.set(id, { ...state, phase: failed ? 'error' : 'complete' }); this.changed();
    }
}
export const codeLightLoadingProgress = new CodeLightLoadingProgress();
export const useCodeLightDiscoveryProgress = () => useSyncExternalStore(codeLightLoadingProgress.subscribe, codeLightLoadingProgress.getDiscovery);
export function useCodeLightMessageProgress(id: string) {
    return useSyncExternalStore(codeLightLoadingProgress.subscribe, () => codeLightLoadingProgress.getSession(id));
}
