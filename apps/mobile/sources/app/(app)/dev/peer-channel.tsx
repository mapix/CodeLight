import * as React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { PeerChannelControlView, type PeerChannelSnapshot } from '@/components/PeerChannelControlView';
import { CodeLightSettingsView } from '@/components/CodeLightSettingsView';
import { applyAppThemePreference, type AppThemePreference } from '@/utils/appThemePreference';
import { ChatHeaderView } from '@/components/ChatHeaderView';

const initial: PeerChannelSnapshot = { peerId: 'preview-peer', selectedId: 'local-preview', automatic: true, connecting: false,
    channels: [{ id: 'local-preview', kind: 'local', url: 'http://192.0.2.10:4567', state: 'connected', latencyMs: 8 },
        { id: 'cloudflare-preview', kind: 'cloudflare', url: 'https://tunnel.example', state: 'available', latencyMs: 95 },
        { id: 'relay-preview', kind: 'relay', url: 'https://relay.example', state: 'failed' }] };

/** Native layout preview only; it never probes a route or mutates a real peer. */
export default function PeerChannelPreview() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ layout?: string }>(), router = useRouter();
    const [snapshot, setSnapshot] = React.useState(initial);
    const [themePreference, setThemePreference] = React.useState<AppThemePreference>('adaptive');
    const select = async (id: string) => {
        if (id === 'relay-preview') throw Error('preview route unavailable');
        setSnapshot(current => ({ ...current, automatic: id === 'auto', selectedId: id === 'auto' ? 'local-preview' : id,
            channels: current.channels.map(channel => ({ ...channel, state: channel.id === (id === 'auto' ? 'local-preview' : id) ? 'connected' : channel.state === 'failed' ? 'failed' : 'available' })) }));
    };
    if (params.layout === 'settings') return <>
        <Stack.Screen options={{ headerShown: false }} />
        <CodeLightSettingsView snapshot={snapshot} onSelectConnection={select} version="0.5.0 · 2026110112" languageLabel="English"
            themePreference={themePreference} onThemeChange={preference => { setThemePreference(preference); applyAppThemePreference(preference); }}
            onScan={() => {}} onLanguage={() => router.push('/settings/language')} onNavigate={page => router.navigate(page === 'sessions' ? '/' : '/settings')} />
    </>;
    if (params.layout === 'header') return <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
        <Stack.Screen options={{ headerShown: false }} />
        <ChatHeaderView title="Current session" subtitle="CodeLight" onBackPress={() => router.back()} rightSlot={<View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <PeerChannelControlView snapshot={snapshot} onSelect={select} presentation="header" />
            <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.textSecondary }} /></View>
        </View>} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text>Session header preview</Text></View>
    </View>;
    return <View style={{ flex: 1, padding: 20, gap: 16, backgroundColor: theme.colors.groupped.background }}>
        <Stack.Screen options={{ headerTitle: 'Connection preview' }} />
        <Text>Sample connection states. Switching here changes this preview only.</Text>
        <PeerChannelControlView snapshot={snapshot} onSelect={select} />
    </View>;
}
