import * as SecureStore from 'expo-secure-store';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { Platform } from 'react-native';
import type { PendingAnonymousAccount } from './anonymousAccount';

async function key(origin: string) { return `codelight_pending_${await digestStringAsync(CryptoDigestAlgorithm.SHA256, origin)}`; }
export const pendingAnonymousStorage = {
    async load(origin: string): Promise<PendingAnonymousAccount | null> {
        const name = await key(origin);
        const value = Platform.OS === 'web' ? localStorage.getItem(name) : await SecureStore.getItemAsync(name);
        return value ? JSON.parse(value) : null;
    },
    async save(origin: string, account: PendingAnonymousAccount): Promise<void> {
        const name = await key(origin), value = JSON.stringify(account);
        if (Platform.OS === 'web') localStorage.setItem(name, value);
        else await SecureStore.setItemAsync(name, value);
    },
    async clear(origin: string): Promise<void> {
        const name = await key(origin);
        if (Platform.OS === 'web') localStorage.removeItem(name);
        else await SecureStore.deleteItemAsync(name);
    },
};
