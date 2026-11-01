import * as React from 'react';
import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PeerChannel } from '@slopus/happy-wire/codelight';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { PickerSheet, PickerSheetOption } from './PickerSheet';
import { t } from '@/text';

export interface PeerChannelSnapshot {
    peerId: string | null;
    channels: Array<PeerChannel & { state: 'connected' | 'available' | 'probing' | 'failed'; latencyMs?: number }>;
    selectedId: string | null;
    automatic: boolean;
    connecting: boolean;
}

function channelName(kind: PeerChannel['kind']) { return t(`codeLightChannels.${kind}`); }
function channelHost(channel: PeerChannel) {
    try { return new URL(channel.url).host; } catch { return ''; }
}

/** The connection service owns selection and probes; the view owns only its open sheet. */
export function PeerChannelControlView({ snapshot, onSelect, style, presentation = 'compact', showDivider = false }: {
    snapshot: PeerChannelSnapshot;
    onSelect: (id: string | 'auto') => Promise<void>;
    style?: StyleProp<ViewStyle>;
    presentation?: 'compact' | 'settings' | 'header';
    showDivider?: boolean;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(false);
    const generation = React.useRef(0), busy = React.useRef(false);
    React.useEffect(() => {
        generation.current++;
        busy.current = false; setSubmitting(false); setOpen(false); setError(false);
        return () => { generation.current++; };
    }, [snapshot.peerId]);

    const choose = React.useCallback(async (id: string) => {
        if (busy.current) return;
        busy.current = true; setSubmitting(true); setError(false);
        const current = generation.current;
        try {
            await onSelect(id);
            if (generation.current === current) setOpen(false);
        } catch {
            // 失败由连接 owner 保留当前通道；界面不乐观改选，也不展示可能含凭据的原始错误。
            if (generation.current === current) setError(true);
        } finally {
            if (generation.current === current) { busy.current = false; setSubmitting(false); }
        }
    }, [onSelect]);

    if (!snapshot.peerId || snapshot.channels.length === 0) return null;
    const selected = snapshot.channels.find(channel => channel.id === snapshot.selectedId);
    const label = selected ? [selected.state !== 'connected' ? t(`codeLightChannels.${selected.state}`) : '', snapshot.automatic ? t('codeLightChannels.automatic') : '', channelName(selected.kind)].filter(Boolean).join(' · ')
        : t(snapshot.connecting ? 'codeLightChannels.switching' : 'codeLightChannels.notConnected');
    return (
        <View style={[presentation === 'header' ? styles.headerContainer : presentation === 'settings' ? styles.settingsContainer : styles.container, style]}>
            <Pressable testID="codelight-channel-open" accessibilityRole="button" accessibilityLabel={`${t('codeLightChannels.title')}: ${label}`}
                onPress={() => { setError(false); setOpen(true); }} style={presentation === 'header' ? styles.headerTrigger : presentation === 'settings' ? styles.settingsTrigger : styles.trigger}>
                {snapshot.connecting || submitting ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    : <Ionicons name={selected?.kind === 'local' ? 'wifi-outline' : selected?.kind === 'relay' ? 'swap-horizontal-outline' : 'cloud-outline'} size={presentation === 'settings' ? 25 : presentation === 'header' ? 21 : 16} color={theme.colors.textSecondary} />}
                {presentation === 'header' ? <View style={[styles.headerStatus, { backgroundColor: selected?.state === 'connected' ? theme.colors.success : theme.colors.textSecondary }]} /> : presentation === 'settings' ? <View style={styles.settingsCopy}>
                    <Text style={styles.settingsTitle}>{t('codeLightChannels.title')}</Text>
                    <Text style={styles.settingsDescription} numberOfLines={2}>{label}</Text>
                </View> : <Text style={styles.triggerText} numberOfLines={1}>{label}</Text>}
                {presentation !== 'header' ? <Ionicons name={presentation === 'settings' ? 'chevron-forward' : 'chevron-down'} size={presentation === 'settings' ? 18 : 14} color={theme.colors.textSecondary} /> : null}
            </Pressable>
            {presentation === 'settings' && showDivider ? <View style={styles.settingsDivider} /> : null}
            <PickerSheet visible={open} title={t('codeLightChannels.title')} onClose={() => setOpen(false)}>
                <PickerSheetOption testID="codelight-channel-auto" label={t('codeLightChannels.automatic')} description={t('codeLightChannels.automaticDetail')}
                    selected={snapshot.automatic} disabled={submitting} onPress={() => void choose('auto')} />
                {snapshot.channels.map(channel => {
                    const latency = typeof channel.latencyMs === 'number' && Number.isFinite(channel.latencyMs) && channel.latencyMs >= 0
                        ? t('codeLightChannels.latency', { ms: Math.round(channel.latencyMs) }) : t('codeLightChannels.latencyUnknown');
                    const status = [t(`codeLightChannels.${channel.state}`), latency,
                        channel.id === snapshot.selectedId ? t('codeLightChannels.current') : ''].filter(Boolean).join(' · ');
                    const description = [status, channelHost(channel)].filter(Boolean).join('\n');
                    return <PickerSheetOption key={channel.id} testID={`codelight-channel-${channel.id}`} label={channelName(channel.kind)} description={description}
                        selected={!snapshot.automatic && channel.id === snapshot.selectedId} disabled={submitting}
                        labelIcon={<Ionicons name={channel.kind === 'local' ? 'wifi-outline' : channel.kind === 'relay' ? 'swap-horizontal-outline' : 'cloud-outline'} size={16} color={theme.colors.textSecondary} />}
                        onPress={() => void choose(channel.id)} />;
                })}
                {error ? <Text testID="codelight-channel-error" accessibilityLiveRegion="polite" style={styles.error}>{t('codeLightChannels.switchFailed')}</Text> : null}
            </PickerSheet>
        </View>
    );
}

const stylesheet = StyleSheet.create(theme => ({
    container: { alignSelf: 'flex-start', maxWidth: '100%' },
    headerContainer: { alignSelf: 'center' },
    headerTrigger: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    headerStatus: { position: 'absolute', right: 5, bottom: 7, width: 5, height: 5, borderRadius: 3 },
    settingsContainer: { alignSelf: 'stretch' },
    settingsTrigger: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 16, paddingVertical: 12 },
    settingsCopy: { flex: 1, minWidth: 0, gap: 3 },
    settingsTitle: { color: theme.colors.text, fontSize: 17, ...Typography.default() },
    settingsDescription: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    settingsDivider: { marginLeft: 54, height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider },
    trigger: { minHeight: 44, maxWidth: 300, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 22,
        backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    triggerText: { flexShrink: 1, minWidth: 0, fontSize: 13, color: theme.colors.text, ...Typography.default() },
    error: { marginHorizontal: 24, marginVertical: 12, color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
}));
