import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './StyledText';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { CodeLightMark } from './CodeLightMark';
import { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';
import { PickerSheet, PickerSheetOption } from './PickerSheet';
import { CodeLightBottomNavigationView, type CodeLightTopLevelPage } from './CodeLightBottomNavigation';
import { Typography } from '@/constants/Typography';
import type { AppThemePreference } from '@/utils/appThemePreference';
import { t } from '@/text';

export interface CodeLightSettingsViewProps {
    snapshot: PeerChannelSnapshot;
    themePreference: AppThemePreference;
    languageLabel: string;
    version: string;
    onSelectConnection: (id: string) => Promise<void>;
    onThemeChange: (preference: AppThemePreference) => void;
    onLanguage: () => void;
    onScan: () => void;
    onNavigate: (page: CodeLightTopLevelPage) => void;
}

export const CodeLightSettingsView = React.memo(function CodeLightSettingsView(props: CodeLightSettingsViewProps) {
    const { theme } = useUnistyles(), insets = useSafeAreaInsets();
    const [themeOpen, setThemeOpen] = React.useState(false);
    return <View testID="codelight-settings-page" style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}><Text accessibilityRole="header" style={styles.heading}>{t('settings.title')}</Text></View>
        <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('codeLightChannels.title')} headerStyle={styles.firstGroup}>
                <PeerChannelControlView snapshot={props.snapshot} onSelect={props.onSelectConnection} presentation="settings" />
                <Item title={t('onboarding.scanButton')} icon={<Ionicons name="qr-code-outline" size={25} color={theme.colors.textSecondary} />}
                    onPress={props.onScan} />
            </ItemGroup>
            <ItemGroup title={t('settingsAppearance.display')}>
                <Item title={t('settings.appearance')} detail={t(`settingsAppearance.themeOptions.${props.themePreference}`)}
                    icon={<Ionicons name="contrast-outline" size={25} color={theme.colors.textSecondary} />} onPress={() => setThemeOpen(true)} />
                <Item title={t('settingsLanguage.title')} detail={props.languageLabel}
                    icon={<Ionicons name="language-outline" size={25} color={theme.colors.textSecondary} />} onPress={props.onLanguage} />
            </ItemGroup>
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item title="CodeLight" titleStyle={styles.brand} detail={props.version} detailStyle={styles.version}
                    icon={<CodeLightMark size={29} />} showChevron={false} copy={props.version} />
            </ItemGroup>
        </ScrollView>
        <CodeLightBottomNavigationView active="settings" onNavigate={props.onNavigate} />
        <PickerSheet visible={themeOpen} title={t('settingsAppearance.theme')} onClose={() => setThemeOpen(false)}>
            {(['adaptive', 'light', 'dark'] as const).map(preference => <PickerSheetOption key={preference} testID={`codelight-theme-${preference}`}
                label={t(`settingsAppearance.themeOptions.${preference}`)} description={t(`settingsAppearance.themeDescriptions.${preference}`)}
                selected={props.themePreference === preference} onPress={() => { props.onThemeChange(preference); setThemeOpen(false); }} />)}
        </PickerSheet>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, backgroundColor: theme.colors.groupped.background },
    header: { paddingHorizontal: 20, paddingVertical: 16 },
    heading: { fontSize: 28, color: theme.colors.text, ...Typography.default('semiBold') },
    content: { flex: 1 }, scrollContent: { paddingBottom: 16 },
    firstGroup: { paddingTop: 6 },
    brand: { fontSize: 20, ...Typography.logo() },
    version: { fontSize: 11, ...Typography.mono() },
}));
