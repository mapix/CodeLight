import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { selectCodeLightSession, useCodeLightSelectionState } from '@/sync/codeLightSessionSelection';

export function NativeSourceBanner({ sessionId, topInset = 0 }: { sessionId: string; topInset?: number }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId), state = useCodeLightSelectionState(sessionId);
    const sourceStatus = session?.metadata?.bridge?.sourceStatus;
    const failed = state === 'failed' || sourceStatus === 'locked' || sourceStatus === 'disconnected';
    // 预加载也会挂载 banner；不能在 mount 时额外切换桌面，点击导航是唯一发起者。
    return <View testID="codelight-auto-session-sync" style={{ padding: 14, paddingTop: topInset + 14, gap: 8, backgroundColor: theme.colors.groupped.background }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {!failed ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
            <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{failed ? t('sourceBridge.openFailed') : t('common.loading')}</Text>
        </View>
        {failed ? <Pressable accessibilityRole="button" onPress={() => { void selectCodeLightSession(session).catch(() => {}); }} testID="codelight-retry-session-sync" style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
        </Pressable> : null}
    </View>;
}
