import AsyncStorage from '@react-native-async-storage/async-storage';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import type { BridgeRpcReply } from './noninvasiveRpcJournal';
import { ScopedNoninvasiveRpc } from './scopedNoninvasiveRpc';

const KEY = 'noninvasive-rpc-journal-v1';
const journal = new ScopedNoninvasiveRpc({
    storage: AsyncStorage, legacyKey: KEY, legacyScopedPrefix: 'noninvasive-rpc-v2:', keyPrefix: 'noninvasive-rpc-v3:', serverUrl: getServerUrl,
    identity: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (sessionId, method, params, origin) => apiSocket.sessionRPC<BridgeRpcReply, unknown>(sessionId, method, params, origin),
    id: randomUUID, digest: text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
});

export function runNoninvasiveRpc(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return journal.execute(sessionId, method, params);
}
export function recoverNoninvasiveRpc(sessionId: string, method: string): Promise<boolean> {
    return journal.recover(sessionId, method);
}
const modelJournal = new ScopedNoninvasiveRpc({
    storage: AsyncStorage, legacyScopedPrefix: 'codelight-model-rpc-v1:', keyPrefix: 'codelight-model-rpc-v3:', serverUrl: getServerUrl,
    identity: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (id, method, params, origin) => apiSocket.sessionRPC<BridgeRpcReply, unknown>(id, method, params, origin),
    id: randomUUID, digest: text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
});
export async function runCodeLightModelRpc(sessionId: string, params: Record<string, unknown>) {
    return modelJournal.execute(sessionId, 'codex-controls-update', params);
}
export async function recoverCodeLightModelRpc(sessionId: string) {
    return modelJournal.recover(sessionId, 'codex-controls-update');
}

const MACHINE_KEY = 'codelight-machine-rpc-journal-v1';
const machineJournal = new ScopedNoninvasiveRpc({
    storage: AsyncStorage, legacyKey: MACHINE_KEY, legacyScopedPrefix: 'codelight-machine-rpc-v2:', keyPrefix: 'codelight-machine-rpc-v3:', serverUrl: getServerUrl,
    identity: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (machineId, method, params, origin) => apiSocket.machineRPC<BridgeRpcReply, unknown>(machineId, method === 'bridge-receipt' ? 'codelight-receipt' : method, params, origin),
    id: randomUUID, digest: text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
});

apiSocket.onReconnected(() => { void journal.recoverPending(); void modelJournal.recoverPending(); });

export function runNoninvasiveMachineRpc(machineId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return machineJournal.execute(machineId, method, params);
}
