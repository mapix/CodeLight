import * as React from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from '@/components/StyledText';
import { TokenStorage } from '@/auth/tokenStorage';
import { apiSocket } from '@/sync/apiSocket';
import { abortBudget } from '@/sync/abortBudget';
import { peerAuthorization, decodePeerResponse } from '@/sync/peerNetwork';
import { getConnectionSnapshot, selectConnection } from '@/sync/codeLightConnection';
import { nativeRecentMessages, peerDescriptorSession } from '@/sync/codeLightRecent';
import { decodeBase64 } from '@/encryption/base64';

/** Native QA with an optional same-peer Auto selection. No native session command is dispatched. */
export default function PeerDiagnostics() {
    const params = useLocalSearchParams<{ thread?: string; select?: string }>();
    const [report, setReport] = React.useState('Checking connection…');
    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result: Record<string, unknown> = { at: Date.now(), stages: [] };
            const stages = result.stages as Record<string, unknown>[];
            try {
                let credentials = await TokenStorage.getCredentials();
                if (!credentials?.peer) throw Error('No stored peer');
                if (params.select === 'auto' || params.select === 'relay') {
                    result.currentStage = 'selection';
                    const started = Date.now();
                    try { await selectConnection(params.select); result.selectionTest = { ok: true, ms: Date.now() - started }; }
                    catch { result.selectionTest = { ok: false, ms: Date.now() - started, connectionError: apiSocket.peerConnectionError() }; }
                    credentials = await TokenStorage.getCredentials();
                    if (!credentials?.peer) throw Error('Peer credentials changed');
                }
                const authenticated = credentials, peer = authenticated.peer;
                if (!peer) throw Error('Peer credentials changed');
                result.channels = await Promise.all(peer.channels.map(async (channel, index) => {
                    const started = Date.now(), deadline = abortBudget(undefined, channel.kind === 'local' ? 2500 : 7000);
                    try {
                        const url = channel.url + '/api/peer/channels';
                        const response = await fetch(url, { headers: { Authorization: peerAuthorization(authenticated.token, peer, channel.url, 'GET', url) }, signal: deadline.signal });
                        if (response.ok) decodePeerResponse(peer, await response.json());
                        return { index, kind: channel.kind, status: response.status, ms: Date.now() - started };
                    } catch { return { index, kind: channel.kind, status: 'unavailable', ms: Date.now() - started }; }
                    finally { deadline.dispose(); }
                }));
                result.socketConnected = apiSocket.peerConnected(); result.automatic = getConnectionSnapshot().automatic;
                let started = Date.now();
                result.currentStage = 'catalog';
                const catalog = await apiSocket.peerRequest('/api/peer/catalog?limit=200');
                stages.push({ name: 'catalog', status: catalog.status, ms: Date.now() - started });
                if (catalog.ok) {
                    const data = await catalog.json();
                    result.catalogCount = data.sessions?.length;
                    const selected = data.sessions?.find((entry: any) => entry.metadata?.bridge?.source?.id === params.thread);
                    result.selectedFound = !!selected;
                    if (selected) {
                        started = Date.now();
                        result.currentStage = 'recent';
                        const recent = await apiSocket.peerRequest(`/api/peer/sessions/${selected.id}/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 50 }) });
                        stages.push({ name: 'recent', status: recent.status, ms: Date.now() - started });
                        if (recent.ok) {
                            const window = await recent.json(); result.recentRows = window.rows?.length; result.nativeStatus = window.status;
                            peerDescriptorSession(window.session); nativeRecentMessages(window);
                            result.nativeProjectionValid = true;
                            result.sessionKeyBytes = decodeBase64(window.session.sessionKey, 'base64').length;
                        }
                    }
                }
                result.currentStage = 'complete';
            } catch { result.failed = true; }
            result.finishedAt = Date.now();
            await AsyncStorage.setItem('codelight-peer-diagnostics-v1', JSON.stringify(result));
            if (!cancelled) setReport(JSON.stringify(result, null, 2));
        })();
        return () => { cancelled = true; };
    }, [params.thread, params.select]);
    return <ScrollView contentContainerStyle={{ padding: 24 }}><Stack.Screen options={{ headerTitle: 'Connection diagnostics' }} /><Text>{report}</Text></ScrollView>;
}
