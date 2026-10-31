import { RoundButton } from "@/components/RoundButton";
import { useAuth } from "@/auth/AuthContext";
import { Platform, Text, View } from "react-native";
import * as React from 'react';
import { encodeBase64 } from "@/encryption/base64";
import { authGetToken } from "@/auth/authGetToken";
import { useRouter } from "expo-router";
import { getRandomBytesAsync } from "expo-crypto";
import { trackAccountCreated, trackAccountRestored } from '@/track';
import { HomeHeaderNotAuth } from "@/components/HomeHeader";
import { MainView } from "@/components/MainView";
import { OnboardingLinkComputer } from "@/components/onboarding/LinkComputer";
import { OnboardingScreen } from "@/components/onboarding/OnboardingScreen";
import { WelcomeContent } from "@/components/onboarding/OnboardingContent";
import { shouldShowFirstRunInstall } from "@/components/onboarding/firstRunOnboarding";
import { useAllMachines, useIsDataReady } from "@/sync/storage";
import { t } from '@/text';
import { isRunningOnMac } from '@/utils/platform';
import { AnonymousAccountCreation, AnonymousAccountError } from '@/auth/anonymousAccount';
import { pendingAnonymousStorage } from '@/auth/pendingAnonymousStorage';
import { decodeBase64 } from '@/encryption/base64';
import { getServerUrl } from '@/sync/serverConfig';
import { useUnistyles } from 'react-native-unistyles';
import { config } from '@/config';
import { CodeLightScanScreen } from '@/components/onboarding/CodeLightScanScreen';
import { CodeLightSessions } from '@/components/CodeLightSessions';

export default function Home() {
    const auth = useAuth();
    if (!auth.isAuthenticated) {
        return config.noninvasiveLocal ? <CodeLightScanScreen /> : <NotAuthenticated />;
    }
    return (
        <Authenticated />
    )
}

function Authenticated() {
    const isDataReady = useIsDataReady();
    const machines = useAllMachines({ includeOffline: true });
    // Until a computer is linked there is nothing for the home chrome to do:
    // the dock, filters, session list, and tablet sidebar all need a machine.
    // Native phones and tablets therefore share the same link screen. Web
    // and desktop retain their existing account-linking flow.
    const showInstallStep = shouldShowFirstRunInstall({
        isAuthenticated: true,
        isDataReady,
        machineCount: machines.length,
        isWeb: Platform.OS === 'web',
        isRunningOnMac: isRunningOnMac(),
    });
    if (showInstallStep) {
        return config.noninvasiveLocal ? <CodeLightScanScreen /> : <OnboardingLinkComputer />;
    }
    return config.noninvasiveLocal ? <CodeLightSessions /> : <MainView variant="phone" />;
}

function NotAuthenticated() {
    const auth = useAuth();
    const router = useRouter();
    const isMobile = Platform.OS === 'android' || Platform.OS === 'ios';
    const { theme } = useUnistyles();
    const [error, setError] = React.useState<string | null>(null);
    const [creating, setCreating] = React.useState(false);
    const authRef = React.useRef(auth); authRef.current = auth;
    const creator = React.useRef<AnonymousAccountCreation | null>(null);
    if (!creator.current) creator.current = new AnonymousAccountCreation({ ...pendingAnonymousStorage,
        generateSecret: async () => encodeBase64(await getRandomBytesAsync(32), 'base64url'),
        authenticate: (secret, origin) => authGetToken(decodeBase64(secret, 'base64url'), origin),
        login: (token, secret, origin) => authRef.current.login(token, secret, origin),
    });

    const createAccount = async () => {
        setCreating(true);
        setError(null);
        try {
            await creator.current!.create(getServerUrl());
            trackAccountCreated();
        } catch (error) {
            setError(error instanceof AnonymousAccountError && error.code === 'storage' ? t('codeLightSetup.storageFailed') : t('codeLightSetup.createFailed'));
        } finally { setCreating(false); }
    }

    const openRestore = () => {
        trackAccountRestored();
        router.push('/restore');
    };

    // One filled action and one quiet text action underneath it. On a phone
    // the restore path is rare, so it reads as a footnote; in a browser the
    // usual way in is an account that already lives on a phone.
    return (
        <OnboardingScreen
            header={<HomeHeaderNotAuth />}
            content={<View><WelcomeContent />{error && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textDestructive, marginTop: 12 }}>{error}</Text>}</View>}
            primary={isMobile ? (
                <RoundButton title={t('onboarding.createAccount')} action={createAccount} loading={creating} />
            ) : (
                <RoundButton title={t('welcome.loginWithMobileApp')} onPress={openRestore} />
            )}
            secondary={isMobile
                ? { title: t('onboarding.restoreExisting'), onPress: openRestore, disabled: creating }
                : { title: t('welcome.createAccount'), action: createAccount }}
        />
    );
}
