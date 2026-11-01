import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useCodeLightMessageProgress } from '@/sync/codeLightLoadingProgress';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useSocketStatus } from '@/sync/storage';
export function CodeLightSessionLoading({ sessionId, initial, older, topInset = 0 }: { sessionId: string; initial: boolean; older: boolean; topInset?: number }) {
    const { theme } = useUnistyles(); const progress = useCodeLightMessageProgress(sessionId);
    const recovering = useSocketStatus().status !== 'connected';
    // 正文加载条也会显示上次读取错误；连接恢复期间它与 source banner 必须使用同一新鲜度规则。
    const failed = !recovering && progress.phase === 'error';
    if (!initial && !older && progress.phase !== 'loading' && !failed && !recovering) return null;
    return <View testID="codelight-session-loading" accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingVertical: 12, paddingTop: initial ? topInset + 12 : 12,
        ...(!initial ? { position: 'absolute', top: topInset + 4, left: 12, right: 12, zIndex: 10, borderRadius: 12 } as const : {}),
        flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.colors.groupped.background }}>
        {!failed ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
        <Text style={{ flex: 1, color: theme.colors.textSecondary }}>{t(failed ? 'codeLightLoading.failed' : older && !recovering ? 'codeLightLoading.older' : 'codeLightLoading.messages')}</Text>
        {failed ? <Pressable onPress={() => sync.onSessionVisible(sessionId)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: theme.colors.text }}>{t('common.retry')}</Text></Pressable> : null}
    </View>;
}
