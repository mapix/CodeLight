import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession, useSocketStatus } from '@/sync/storage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { selectCodeLightSession, useCodeLightSelectionState } from '@/sync/codeLightSessionSelection';
import { useCodeLightMessageProgress } from '@/sync/codeLightLoadingProgress';
import { sync } from '@/sync/sync';

export function NativeSourceBanner({ sessionId, topInset = 0 }: { sessionId: string; topInset?: number }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId), state = useCodeLightSelectionState(sessionId);
    const progress = useCodeLightMessageProgress(sessionId);
    const sourceStatus = session?.metadata?.bridge?.sourceStatus;
    const connected = useSocketStatus().status === 'connected';
    const loading = !connected || progress.phase === 'loading' || state === 'connecting';
    // 缓存的 disconnected 不是这次读取失败；新鲜验证期间只展示同步，错误必须来自当前尝试。
    const failed = !loading && (state === 'failed' || progress.phase === 'error' || progress.phase === 'complete' && sourceStatus === 'locked');
    // 预加载也会挂载 banner；不能在 mount 时额外切换桌面，点击导航是唯一发起者。
    return <View testID="codelight-auto-session-sync" style={{ padding: 14, paddingTop: topInset + 14, gap: 8, backgroundColor: theme.colors.groupped.background }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {!failed ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t(failed ? 'codeLightLoading.failed' : 'codeLightLoading.messages')}</Text>
        </View>
        {failed ? <Pressable accessibilityRole="button" onPress={() => { if (state === 'failed') void selectCodeLightSession(session).catch(() => {}); sync.onSessionVisible(sessionId); }} testID="codelight-retry-session-sync" style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
        </Pressable> : null}
    </View>;
}
