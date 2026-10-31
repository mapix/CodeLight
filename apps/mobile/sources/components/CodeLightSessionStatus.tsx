import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useCodeLightSessionActivity } from '@/hooks/useCodeLightProjectActivity';
import type { CodeLightSessionActivity } from '@/sync/codeLightProjectActivity';
import { t } from '@/text';

export const CodeLightSessionStatus = React.memo(({ sessionId }: { sessionId: string }) => {
    const activity = useCodeLightSessionActivity(sessionId);
    return <CodeLightSessionStatusView activity={activity} />;
});

export const CodeLightSessionStatusView = React.memo(({ activity }: { activity: CodeLightSessionActivity }) => {
    const { theme } = useUnistyles();
    const color = theme.colors.textSecondary;
    if (!activity.known || activity.status !== 'ready') return <Text style={{ fontSize: 12, color, marginTop: 5 }}>{t('codeLightSessionStatus.unknown')}</Text>;
    return <View style={{ flexDirection: 'row', gap: 10, marginTop: 5 }} testID="codelight-session-status">
        {activity.active ? <Text style={{ fontSize: 12, color: theme.colors.text }}>{t('codeLightSessionStatus.active')}</Text> : null}
        {activity.waiting ? <Text style={{ fontSize: 12, color: theme.colors.textLink }}>{t('codeLightSessionStatus.waiting')}</Text> : null}
        {!activity.active && !activity.waiting ? <Text style={{ fontSize: 12, color }}>{t('codeLightSessionStatus.idle')}</Text> : null}
    </View>;
});
