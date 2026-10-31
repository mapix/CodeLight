import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from './StyledText';
import { NativeOptionsPicker, type NativeOptionsPickerOption } from './NativeOptionsPicker';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** One bounded control; the platform owns the scrollable list of conversations. */
export const ProjectSessionSelect = React.memo(({ options, selectedId, onSelect }: {
    options: NativeOptionsPickerOption[];
    selectedId: string;
    onSelect: (id: string) => void;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const label = options.find(option => option.key === selectedId)?.label ?? t('session.newChat');
    const sections = React.useMemo(() => [{ key: 'sessions', options }], [options]);
    return (
        <View style={styles.container} testID="project-session-select">
            <NativeOptionsPicker
                title={t('tabs.sessions')}
                triggerLabel={label}
                sections={sections}
                selectedKey={selectedId}
                onSelect={onSelect}
                showChevron
            >
                <View style={styles.trigger}>
                    <Text style={styles.label} numberOfLines={1}>{label}</Text>
                    <Ionicons name="chevron-down" size={14} color={theme.colors.textSecondary} />
                </View>
            </NativeOptionsPicker>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: { flex: 1, minWidth: 0, paddingHorizontal: 12 },
    trigger: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 12 },
    label: { flex: 1, minWidth: 0, fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
}));
