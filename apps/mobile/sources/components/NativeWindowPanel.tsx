import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { storage } from '@/sync/storage';
import { useDraft } from '@/hooks/useDraft';
import { runNoninvasiveRpc } from '@/sync/noninvasiveRpc';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { Modal } from '@/modal';
import { NativeWindowViewer } from './NativeWindowViewer';
import { NativeSourceBanner } from './NativeSourceBanner';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type NativeControl = { nodeId: string; role?: string; subrole?: string; title?: string; label?: string; description?: string; value?: string; text?: Record<string, string>; enabled?: boolean; editable?: boolean; valueSettable?: boolean; emptyEditable?: boolean; editableValueTruncated?: boolean; secureValueRedacted?: boolean; actions?: string[] };

export function NativeWindowPanel({ sessionId, topInset = 100 }: { sessionId: string; topInset?: number }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const [text, onChangeText] = React.useState(() => storage.getState().sessions[sessionId]?.draft ?? '');
    useDraft(sessionId, text, onChangeText);
    const raw = session?.agentState?.windowObservation;
    const observation = raw && typeof raw === 'object' ? raw as Record<string, any> : {};
    const stamp = observation.captureStamp;
    const ref = typeof observation.imageRef === 'string' ? observation.imageRef : undefined;
    const bounds = observation.bounds ?? stamp?.bounds;
    const { uri, loading, error: imageError } = useAttachmentImage(sessionId, ref);
    const controls: NativeControl[] = Array.isArray(observation.controls) ? observation.controls.filter((item: unknown) => item && typeof item === 'object' && typeof (item as NativeControl).nodeId === 'string') : [];
    const [selected, setSelected] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const connected = session?.metadata?.bridge?.sourceStatus === 'connected';
    const canControl = connected && !!stamp && session?.metadata?.capabilities?.rpcMethods?.includes('window-control') === true;
    const editable = controls.filter(c => !c.secureValueRedacted && c.subrole !== 'AXSecureTextField' && !c.editableValueTruncated && c.valueSettable !== false
        && (c.editable || /Text(Field|Area|View)|ComboBox/i.test(c.role ?? '')) && (c.emptyEditable === true || c.text?.value !== undefined && !c.text.value.trim()));
    const actionable = controls.filter(c => /Button|CheckBox|PopUp|MenuItem|RadioButton/i.test(c.role ?? '') || c.actions?.includes('press'));
    React.useEffect(() => { if (selected && !editable.some(c => c.nodeId === selected)) setSelected(null); }, [selected, controls]);
    const action = async (name: string, extra: Record<string, unknown> = {}) => {
        if (!canControl || busy) return;
        setBusy(true); setError(false);
        try { await runNoninvasiveRpc(sessionId, 'window-control', { action: name, payload: { captureStamp: stamp, runtimeGeneration: stamp?.runtimeGeneration ?? observation.runtimeGeneration, windowGeneration: stamp?.windowGeneration ?? observation.windowGeneration, ...extra } }); }
        catch { setError(true); }
        finally { setBusy(false); }
    };
    const label = (c: NativeControl) => c.title || c.label || c.description || c.text?.title || c.text?.description || c.value || c.role || t('windowControl.control');
    const buttonStyle = { padding: 12, borderRadius: 12, backgroundColor: theme.colors.surface, opacity: busy ? 0.6 : 1 };
    const font = { color: theme.colors.text, ...Typography.default() };
    return <ScrollView testID="codelight-window-panel" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingTop: topInset + 16, gap: 14 }}>
        {!connected && <NativeSourceBanner sessionId={sessionId} />}
        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('windowControl.sharedWindow')}</Text>
        {uri && ref ? <Pressable accessibilityRole="button" accessibilityLabel={t('imagePreview.open')} onPress={() => Modal.show({ component: NativeWindowViewer, props: { sessionId } })}>
            <Image source={{ uri }} contentFit="contain" style={{ width: '100%', aspectRatio: bounds?.width && bounds?.height ? bounds.width / bounds.height : 4 / 3, borderRadius: 12 }} />
        </Pressable> : <View style={{ padding: 36, alignItems: 'center' }}>{loading ? <ActivityIndicator /> : <Text style={font}>{imageError ? t('imagePreview.loadFailed') : t('windowControl.waitingImage')}</Text>}</View>}
        {canControl && <Pressable accessibilityRole="button" onPress={() => action('activate')} disabled={busy} style={buttonStyle}><Text style={font}>{t('windowControl.showWindow')}</Text></Pressable>}
        {error && <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>{t('windowControl.unconfirmed')}</Text>}
        {observation.textInputAvailable === true && <>
            <Text style={font}>{t('windowControl.chooseInput')}</Text>
            {editable.map(c => <Pressable key={c.nodeId} onPress={() => setSelected(c.nodeId)} disabled={!canControl || busy || c.enabled === false} style={{ ...buttonStyle, borderWidth: selected === c.nodeId ? 1 : 0, borderColor: theme.colors.text }}><Text numberOfLines={2} style={font}>{label(c)}</Text></Pressable>)}
            <TextInput testID="codelight-window-draft" multiline value={text} onChangeText={onChangeText} placeholder={t('windowControl.draft')} placeholderTextColor={theme.colors.textSecondary} style={{ ...buttonStyle, ...font, minHeight: 80 }} />
            <Pressable accessibilityRole="button" testID="codelight-fill-input" disabled={!canControl || busy || !selected || !text.trim()} onPress={() => action('type', { nodeId: selected, text })} style={buttonStyle}><Text style={font}>{t('windowControl.fillInput')}</Text></Pressable>
        </>}
        <Text style={font}>{t('windowControl.controls')}</Text>
        {actionable.slice(0, 80).map(c => <Pressable accessibilityRole="button" key={c.nodeId} disabled={!canControl || busy || c.enabled === false} onPress={() => action('press', { nodeId: c.nodeId })} style={buttonStyle}><Text numberOfLines={2} style={font}>{label(c)}</Text></Pressable>)}
    </ScrollView>;
}
