import React, { useState } from 'react';
import { reloadAppAsync } from 'expo';
import { useAuth } from '@/auth/AuthContext';
import { apiSocket } from '@/sync/apiSocket';
import { normalizeServerOrigin } from '@/utils/serverOrigin';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import {
    getServerUrl,
    setServerUrl,
    validateServerUrl,
    getServerInfo,
    setUseCustomServerForVoice,
    shouldUseCustomServerForVoice,
} from '@/sync/serverConfig';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: Platform.select({ web: theme.colors.input.background, default: theme.colors.surfaceHigh }),
        paddingHorizontal: 14,
        paddingVertical: 12,
        minHeight: 44,
        borderRadius: 10,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 15,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonColumn: {
        gap: 4,
        marginTop: 4,
        marginBottom: 12,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const auth = useAuth();
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    const [isCustomServer, setIsCustomServer] = useState(serverInfo.isCustom);
    const [useCustomServerForVoice, setUseCustomServerForVoiceState] = useState(shouldUseCustomServerForVoice());
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);

    const validateServer = async (url: string): Promise<boolean> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            setIsValidating(true);
            setError(null);
            
            const response = await fetch(`${url}/health`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }, signal: controller.signal,
            });
            
            if (!response.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }
            
            const data = await response.json();
            if (data?.status !== 'ok' || data?.service !== 'happy-server') {
                setError(t('server.notValidHappyServer'));
                return false;
            }
            
            return true;
        } catch (err) {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            clearTimeout(timeout);
            setIsValidating(false);
        }
    };

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        // Validate the server
        const nextOrigin = normalizeServerOrigin(inputUrl);
        const isValid = await validateServer(nextOrigin);
        if (!isValid) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('server.changeServer'),
            t('server.continueWithServer'),
            { confirmText: t('common.continue'), destructive: true }
        );

        if (!confirmed) return;
        try {
            if (auth.isAuthenticated) await auth.logout({ reload: false });
            apiSocket.disconnect(); setServerUrl(nextOrigin); setInputUrl(nextOrigin);
            // 改地址后必须重载自己的连接图；不复用上一服务器的 token/socket，也不依赖被禁用的 OTA reload。
            if (Platform.OS === 'web') window.location.reload(); else await reloadAppAsync();
        } catch { setError(t('codeLightSetup.reloadFailed')); }
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            try {
                if (auth.isAuthenticated) await auth.logout({ reload: false });
                apiSocket.disconnect(); setServerUrl(null); setUseCustomServerForVoice(false);
                if (Platform.OS === 'web') window.location.reload(); else await reloadAppAsync();
            } catch { setError(t('codeLightSetup.reloadFailed')); }
        }
    };

    const handleUseCustomServerForVoice = (enabled: boolean) => {
        setUseCustomServerForVoice(enabled);
        setUseCustomServerForVoiceState(enabled);
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.title'),
                    headerTitleAlign: 'center',
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                {/* 键盘打开时首次 Save 必须执行；默认 ScrollView 会吞掉第一次点击仅用于收键盘。 */}
                <ItemList style={styles.itemListContainer} keyboardShouldPersistTaps="handled">
                    <ItemGroup footer={t('server.selfHostFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.serverUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            <View style={styles.buttonColumn}>
                                <RoundButton
                                    title={isValidating ? t('server.validating') : t('common.save')}
                                    size="normal"
                                    action={handleSave}
                                    disabled={isValidating}
                                />
                                {isCustomServer && (
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                )}
                            </View>
                            {isCustomServer && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    {isCustomServer && (
                        <ItemGroup
                            title={t('server.services')}
                            footer={t('server.customServerVoiceFooter')}
                        >
                            <Item
                                title={t('server.useCustomServerForVoice')}
                                subtitle={useCustomServerForVoice
                                    ? t('server.customServerVoiceEnabled')
                                    : t('server.customServerVoiceDisabled')}
                                icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                                rightElement={
                                    <Switch
                                        value={useCustomServerForVoice}
                                        onValueChange={handleUseCustomServerForVoice}
                                    />
                                }
                                showChevron={false}
                            />
                        </ItemGroup>
                    )}

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
