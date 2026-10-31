import type { Session } from './storageTypes';
import { runNoninvasiveMachineRpc } from './noninvasiveRpc';
import { CodeLightActivationGate } from './codeLightActivationGate';
import { getServerUrl } from './serverConfig';
import { TokenStorage } from '@/auth/tokenStorage';

const starts = new CodeLightActivationGate();
/** Entering a source is the user action; only the existing desktop owner starts its observation. */
export async function activateCodeLightSource(session: Session | null): Promise<unknown> {
    const bridge = session?.metadata?.bridge;
    if (!session || !bridge || bridge.source.app !== 'codex' || bridge.sourceStatus === 'connected') return Promise.resolve();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw Error('Source credentials unavailable');
    const identity = JSON.stringify([getServerUrl(), credentials.token, session.id, session.metadata?.machineId,
        bridge.sourceKey, bridge.source.runtimeGeneration]);
    return starts.run(identity, () => bridge.controller === 'machine' && session.metadata?.machineId && bridge.sourceKey
        ? runNoninvasiveMachineRpc(session.metadata.machineId, 'codelight-observe-source', { sourceKey: bridge.sourceKey })
        : Promise.resolve());
}
