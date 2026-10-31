import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useCodeLightProjectActivity } from '@/hooks/useCodeLightProjectActivity';
import { t } from '@/text';
import type { CodeLightProjectActivity } from '@/sync/codeLightProjectActivity';

export const CodeLightProjectStatus = React.memo(({ projectId }: { projectId: string }) => {
    const activity = useCodeLightProjectActivity(projectId);
    return <CodeLightProjectStatusView activity={activity} />;
});

export const CodeLightProjectStatusView = React.memo(({ activity }: { activity: CodeLightProjectActivity }) => {
    const { theme } = useUnistyles();
    const color = theme.colors.textSecondary;
    if (activity.status !== 'ready' && !(activity.status === 'refreshing' && activity.observedAt > 0 && activity.total > 0)) {
        const label = activity.status === 'refreshing' ? t('codeLightProjects.refreshing') : activity.status === 'stale' ? t('codeLightProjects.stale') : t('codeLightProjects.unavailable');
        return <Text style={{ fontSize: 12, color, marginTop: 5 }}>{label}</Text>;
    }
    return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 5 }} testID="codelight-project-status">
        <Text style={{ fontSize: 12, color: theme.colors.text }}>{t('codeLightProjects.active', { count: activity.active })}</Text>
        <Text style={{ fontSize: 12, color: activity.waiting ? theme.colors.textLink : color }}>{t('codeLightProjects.waiting', { count: activity.waiting })}</Text>
        {activity.unknown > 0 ? <Text style={{ fontSize: 12, color }}>{t('codeLightProjects.unknown', { count: activity.unknown })}</Text> : null}
        {activity.status === 'refreshing' ? <Text style={{ fontSize: 12, color }}>{t('codeLightProjects.refreshing')}</Text> : null}
    </View>;
});
