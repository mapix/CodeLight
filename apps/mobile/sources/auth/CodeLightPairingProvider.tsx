import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { reloadAppAsync } from 'expo';
import axios from 'axios';
import { useAuth } from './AuthContext';
import { TokenStorage } from './tokenStorage';
import { generateAuthKeyPair } from './authQRStart';
import { CodeLightPairingController, CodeLightPairingError, type PendingCodeLightPairing } from './codeLightPairing';
import sodium from '@/encryption/libsodium.lib';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getServerUrl, setServerUrl } from '@/sync/serverConfig';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { config } from '@/config';
import { t } from '@/text';
import DeviceInfo from 'react-native-device-info';

const PENDING_KEY = 'codelight_pending_scan_v1';
const DEVICE_KEY = 'codelight_device_box_key_v1';
type PairingContext = { busy: boolean; error: string | null; scan: () => Promise<void>; connect: (url: string) => Promise<void> };
const Context = createContext<PairingContext | null>(null);
export function CodeLightPairingProvider({ children }: { children: React.ReactNode }) {
    const auth = useAuth(), authRef = useRef(auth); authRef.current = auth;
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
    const checkCamera = useCheckScannerPermissions();
    const controller = useRef<CodeLightPairingController | null>(null);
    if (!controller.current) controller.current = new CodeLightPairingController({
        load: async () => {
            const value = Platform.OS === 'web' ? localStorage.getItem(PENDING_KEY) : await SecureStore.getItemAsync(PENDING_KEY);
            return value ? JSON.parse(value) as PendingCodeLightPairing : null;
        },
        save: async pending => {
            const value = JSON.stringify(pending);
            if (Platform.OS === 'web') localStorage.setItem(PENDING_KEY, value); else await SecureStore.setItemAsync(PENDING_KEY, value);
        },
        clear: async () => { if (Platform.OS === 'web') localStorage.removeItem(PENDING_KEY); else await SecureStore.deleteItemAsync(PENDING_KEY); },
        generateKey: async () => {
            const saved = Platform.OS === 'web' ? localStorage.getItem(DEVICE_KEY) : await SecureStore.getItemAsync(DEVICE_KEY);
            if (saved) return JSON.parse(saved);
            const key = generateAuthKeyPair(), value = { publicKey: encodeBase64(key.publicKey, 'base64url'), secretKey: encodeBase64(key.secretKey, 'base64url'), name: DeviceInfo.getModel() };
            if (Platform.OS === 'web') localStorage.setItem(DEVICE_KEY, JSON.stringify(value)); else await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(value));
            return value;
        },
        encrypt: (code, device) => {
            const nonce = getRandomBytes(24), plain = new TextEncoder().encode(JSON.stringify({ version: 1, invite: code.invite, origin: code.origin, deviceName: device.name ?? 'Phone' }));
            const ciphertext = sodium.crypto_box_easy(plain, nonce, decodeBase64(code.key, 'base64url'), decodeBase64(device.secretKey, 'base64url'));
            return { publicKey: device.publicKey, nonce: encodeBase64(nonce, 'base64url'), ciphertext: encodeBase64(ciphertext, 'base64url') };
        },
        exchange: async (origin, packet) => (await axios.post(origin + '/codelight/pairing/exchange', packet, { timeout: 15000 })).data,
        decrypt: (code, device, value) => {
            const reply = value as { version?: number; macKey?: string; nonce: string; ciphertext: string };
            if (reply?.version !== 1 || reply.macKey !== code.key) throw new CodeLightPairingError('identity', 'Wrong Mac pairing key.');
            const plain = sodium.crypto_box_open_easy(decodeBase64(reply.ciphertext, 'base64url'), decodeBase64(reply.nonce, 'base64url'),
                decodeBase64(code.key, 'base64url'), decodeBase64(device.secretKey, 'base64url'));
            return JSON.parse(new TextDecoder().decode(plain));
        },
        currentOrigin: getServerUrl, selectOrigin: setServerUrl,
        credentials: () => { const value = authRef.current.credentials; return value ? { ...value, serverUrl: value.serverUrl ?? getServerUrl() } : null; },
        saveCredentials: async credentials => { if (!await TokenStorage.setCredentials(credentials)) throw new CodeLightPairingError('storage', 'Could not save this Mac.'); },
        login: credentials => authRef.current.login(credentials.token, credentials.secret, credentials.serverUrl),
        reload: async () => { if (Platform.OS === 'web') window.location.reload(); else await reloadAppAsync(); },
    });
    const run = useCallback(async (operation: () => Promise<void>) => {
        setBusy(true); setError(null);
        try { await operation(); } catch (failure) {
            const code = failure instanceof CodeLightPairingError ? failure.code : 'network';
            setError(code === 'expired' || code === 'used' ? t('codeLightPairing.refresh') : code === 'storage' ? t('codeLightPairing.storage') : code === 'invalid' || code === 'identity' ? t('codeLightPairing.invalid') : t('codeLightPairing.network'));
            throw failure;
        }
        finally { setBusy(false); }
    }, []);
    const connect = useCallback((url: string) => run(() => controller.current!.connect(url)), [run]);
    const scan = useCallback(async () => {
        if (busy) return;
        if (!await checkCamera()) { setError(t('modals.cameraPermissionsRequiredToScanQr')); return; }
        try { await CameraView.launchScanner({ barcodeTypes: ['qr'] }); } catch { setError(t('onboarding.linkFailed')); }
    }, [busy, checkCamera]);
    useEffect(() => {
        if (!config.noninvasiveLocal) return;
        void run(() => controller.current!.resume()).catch(() => {});
        if (!CameraView.isModernBarcodeScannerAvailable) return;
        const subscription = CameraView.onModernBarcodeScanned(async event => {
            if (!event.data.startsWith('codelight://pair?')) return;
            if (Platform.OS === 'ios') await CameraView.dismissScanner().catch(() => {});
            await connect(event.data).catch(() => {});
        });
        return () => subscription.remove();
    }, [connect, run]);
    return <Context.Provider value={{ busy, error, scan, connect }}>{children}</Context.Provider>;
}
export function useCodeLightPairing() {
    const value = useContext(Context); if (!value) throw Error('CodeLightPairingProvider is missing'); return value;
}
