import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { TokenStorage } from '@/auth/tokenStorage';
import type { Session } from './storageTypes';
import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { codeLightAccountScope } from './codeLightBackgroundCache';
import { CodeLightSelectionJournal } from './codeLightSelectionJournal';
import type { BridgeRpcReply } from './noninvasiveRpcJournal';

const journals = new Map<string, CodeLightSelectionJournal>();
const states = new Map<string, { revision: number; state: 'connecting' | 'selected' | 'failed' }>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export function useCodeLightSelectionState(sessionId: string) {
    return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
        () => states.get(sessionId)?.state ?? 'idle');
}
/** Invoked only by a real navigation tap or Retry, never by a preload/background refresh. */
export async function selectCodeLightSession(session: Session | null) {
    const bridge = session?.metadata?.bridge;
    if (!session || !bridge || bridge.source.app !== 'codex') return;
    const revision = (states.get(session.id)?.revision ?? 0) + 1;
    states.set(session.id, { revision, state: 'connecting' }); notify();
    try {
        const credentials = await TokenStorage.getCredentials(), machine = session.metadata?.machineId;
        if (!credentials || !machine || typeof bridge.sourceKey !== 'string') throw Error('Source binding unavailable');
        const origin = getServerUrl(), scope = await codeLightAccountScope(credentials);
        const peerAuthority = credentials.peer ? 'peer:' + credentials.peer.id : null;
        // 同一 Mac 的认证通道切换不会改变选择所有者；旧 origin 判断会把正常自动恢复误记为选择失败。
        const assertAuthority = () => {
            if (peerAuthority ? apiSocket.peerIdentity() !== peerAuthority : getServerUrl() !== origin) throw Error('Selection authority changed');
        };
        assertAuthority();
        let journal = journals.get(scope);
        if (!journal) {
            const key = 'codelight-selection-journal-v1:' + scope;
            journal = new CodeLightSelectionJournal({ get: () => AsyncStorage.getItem(key), set: value => AsyncStorage.setItem(key, value) },
                (id, params) => { assertAuthority(); return apiSocket.machineRPC<BridgeRpcReply, unknown>(id, 'codelight-select-source', params); }, randomUUID);
            journals.set(scope, journal);
        }
        await journal.select(machine, bridge.sourceKey);
        if (states.get(session.id)?.revision === revision) { states.set(session.id, { revision, state: 'selected' }); notify(); }
    } catch (error) {
        if (states.get(session.id)?.revision === revision) { states.set(session.id, { revision, state: 'failed' }); notify(); }
        throw error;
    }
}
