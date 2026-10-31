import AsyncStorage from '@react-native-async-storage/async-storage';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { NoninvasiveRpcJournal, type BridgeRpcReply } from './noninvasiveRpcJournal';

const KEY = 'noninvasive-rpc-journal-v1';
const journal = new NoninvasiveRpcJournal(
    { get: () => AsyncStorage.getItem(KEY), set: value => AsyncStorage.setItem(KEY, value), remove: () => AsyncStorage.removeItem(KEY) },
    (sessionId, method, params) => apiSocket.sessionRPC<BridgeRpcReply, unknown>(sessionId, method, params),
    randomUUID,
    text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
);

export function runNoninvasiveRpc(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return journal.execute({ serverUrl: getServerUrl(), sessionId, method }, params);
}
export function recoverNoninvasiveRpc(sessionId: string, method: string): Promise<boolean> {
    return journal.recover({ serverUrl: getServerUrl(), sessionId, method });
}
const modelJournals = new Map<string, NoninvasiveRpcJournal>();
async function codeLightModelJournal(sessionId: string) {
    const origin = getServerUrl(), scope = JSON.stringify([origin, sessionId]);
    if (!modelJournals.has(scope)) {
        const key = 'codelight-model-rpc-v1:' + await digestStringAsync(CryptoDigestAlgorithm.SHA256, scope);
        if (!modelJournals.has(scope)) modelJournals.set(scope, new NoninvasiveRpcJournal(
            { get: () => AsyncStorage.getItem(key), set: value => AsyncStorage.setItem(key, value), remove: () => AsyncStorage.removeItem(key) },
            (id, method, params) => {
                if (getServerUrl() !== origin) throw Error('Model settings origin changed');
                return apiSocket.sessionRPC<BridgeRpcReply, unknown>(id, method, params);
            }, randomUUID, value => digestStringAsync(CryptoDigestAlgorithm.SHA256, value)));
    }
    return { journal: modelJournals.get(scope)!, context: { serverUrl: origin, sessionId, method: 'codex-controls-update' } };
}
export async function runCodeLightModelRpc(sessionId: string, params: Record<string, unknown>) {
    const { journal, context } = await codeLightModelJournal(sessionId); return journal.execute(context, params);
}
export async function recoverCodeLightModelRpc(sessionId: string) {
    const { journal, context } = await codeLightModelJournal(sessionId); return journal.recover(context);
}

const MACHINE_KEY = 'codelight-machine-rpc-journal-v1';
const machineJournal = new NoninvasiveRpcJournal(
    { get: () => AsyncStorage.getItem(MACHINE_KEY), set: value => AsyncStorage.setItem(MACHINE_KEY, value), remove: () => AsyncStorage.removeItem(MACHINE_KEY) },
    (machineId, method, params) => apiSocket.machineRPC<BridgeRpcReply, unknown>(machineId, method === 'bridge-receipt' ? 'codelight-receipt' : method, params),
    randomUUID,
    text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
);

export function runNoninvasiveMachineRpc(machineId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return machineJournal.execute({ serverUrl: getServerUrl(), sessionId: machineId, method }, params);
}
