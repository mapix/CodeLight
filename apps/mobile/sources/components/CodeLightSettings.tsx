import * as React from 'react';
import { useRouter } from 'expo-router';
import * as Application from 'expo-application';
import * as Localization from 'expo-localization';
import Constants from 'expo-constants';
import { useCodeLightPairing } from '@/auth/CodeLightPairingProvider';
import { useLocalSettingMutable, useSetting } from '@/sync/storage';
import { getConnectionSnapshot, subscribeConnection, selectConnection } from '@/sync/codeLightConnection';
import { applyAppThemePreference } from '@/utils/appThemePreference';
import { resolveLanguage, resolvePreferredLanguage } from '@/text/resolveLanguage';
import { getLanguageNativeName, t } from '@/text';
import { CodeLightSettingsView } from './CodeLightSettingsView';

/** Global app preferences subscribe to existing owners; mounting this page never selects a route or chat. */
export const CodeLightSettings = React.memo(function CodeLightSettings() {
    const router = useRouter(), pairing = useCodeLightPairing();
    const snapshot = React.useSyncExternalStore(subscribeConnection, getConnectionSnapshot);
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const preferredLanguage = useSetting('preferredLanguage');
    const language = resolvePreferredLanguage(preferredLanguage);
    const detectedLanguage = resolveLanguage(null, Localization.getLocales());
    const languageLabel = language ? getLanguageNativeName(language) : `${t('settingsLanguage.automatic')} · ${getLanguageNativeName(detectedLanguage)}`;
    const version = [Application.nativeApplicationVersion || Constants.expoConfig?.version, Application.nativeBuildVersion].filter(Boolean).join(' · ');
    return <CodeLightSettingsView snapshot={snapshot} themePreference={themePreference} languageLabel={languageLabel} version={version}
        onSelectConnection={selectConnection} onScan={() => { void pairing.scan(); }} onLanguage={() => router.push('/settings/language')}
        onNavigate={page => router.navigate(page === 'sessions' ? '/' : '/settings')}
        onThemeChange={preference => { setThemePreference(preference); applyAppThemePreference(preference); }} />;
});
