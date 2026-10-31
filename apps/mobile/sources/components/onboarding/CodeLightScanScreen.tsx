import React from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { OnboardingScreen } from './OnboardingScreen';
import { OnboardingHeader } from './OnboardingHeader';
import { HappyEngineeringWordmark } from './HappyEngineeringWordmark';
import { RoundButton } from '../RoundButton';
import { useCodeLightPairing } from '@/auth/CodeLightPairingProvider';
import { Modal } from '@/modal';
import { t } from '@/text';

export const CodeLightScanScreen = React.memo(function CodeLightScanScreen() {
    const pairing = useCodeLightPairing();
    return <OnboardingScreen reserveContent={false} header={<OnboardingHeader />} content={<View>
        <HappyEngineeringWordmark height={84} />
        <Image source={require('@/assets/images/codelight-connection.png')} resizeMode="contain" style={{ width: 260, height: 144, marginTop: 18 }} />
        <Text style={styles.title}>{t('onboarding.linkTitle')}</Text>
        <Text style={styles.body}>{t('onboarding.openBody')}</Text>
        {pairing.error ? <Text style={styles.error} accessibilityLiveRegion="polite">{pairing.error}</Text> : null}
    </View>} primary={<RoundButton title={t('onboarding.scanButton')} loadingTitle={t('onboarding.linking')}
        loading={pairing.busy} disabled={pairing.busy} onPress={() => { void pairing.scan(); }} />}
        secondary={{ title: t('onboarding.pasteLink'), disabled: pairing.busy, action: async () => {
            const link = await Modal.prompt(t('onboarding.pasteLinkTitle'), t('onboarding.pasteLinkMessage'), { placeholder: 'codelight://pair?...', confirmText: t('onboarding.pasteLinkConfirm') });
            if (link?.trim()) await pairing.connect(link.trim()).catch(() => {});
        } }} />;
});
const styles = StyleSheet.create(theme => ({
    title: { fontSize: 28, lineHeight: 34, fontWeight: '600', color: theme.colors.text, marginTop: 24 },
    body: { fontSize: 17, lineHeight: 24, color: theme.colors.textSecondary, marginTop: 12 },
    error: { fontSize: 15, color: theme.colors.warningCritical, marginTop: 16 },
}));
