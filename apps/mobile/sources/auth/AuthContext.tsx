import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate } from '@/sync/sync';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { unregisterPushToken } from '@/sync/apiPush';
import { Platform } from 'react-native';
import { trackLogout } from '@/track';
import { reloadAppAsync } from 'expo';
import { getServerUrl } from '@/sync/serverConfig';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';
import { t } from '@/text';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string, serverUrl?: string) => Promise<void>;
    logout: (options?: { reload?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const currentCredentials = React.useRef(initialCredentials);
    const loginFlight = React.useRef<{ key: string; promise: Promise<void> } | null>(null);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout } : null);
    }, [isAuthenticated, credentials]);

    const login = (token: string, secret: string, serverUrl = getServerUrl()): Promise<void> => {
        if (serverUrl !== getServerUrl()) throw Error('The selected server changed during authentication.');
        const key = JSON.stringify([serverUrl, token, secret]);
        if (loginFlight.current) return loginFlight.current.key === key ? loginFlight.current.promise : Promise.reject(Error('Another account is being initialized.'));
        if (currentCredentials.current && (currentCredentials.current.secret !== secret || currentCredentials.current.serverUrl && currentCredentials.current.serverUrl !== serverUrl)) return Promise.reject(Error('Sign out before changing account.'));
        const newCredentials: AuthCredentials = { token, secret, serverUrl };
        const promise = (async () => {
            const success = await TokenStorage.setCredentials(newCredentials);
            if (!success) { const error = Error('Failed to save credentials'); Object.assign(error, { code: 'credential-storage' }); throw error; }
            await syncCreate(newCredentials, serverUrl);
            currentCredentials.current = newCredentials; setCredentials(newCredentials); setIsAuthenticated(true);
        })().finally(() => { loginFlight.current = null; });
        loginFlight.current = { key, promise }; return promise;
    };

    const logout = async (options?: { reload?: boolean }) => {
        trackLogout();
        const registeredPushToken = credentials ? loadRegisteredPushToken() : null;
        if (credentials && registeredPushToken) {
            try {
                await unregisterPushToken(credentials, registeredPushToken);
            } catch (error) {
                console.log('Failed to unregister push token during logout:', error);
            }
        }
        // 安全存储失败不能假装退出：否则重启又会恢复仍然保存的账号。
        if (!await TokenStorage.removeCredentials()) throw Error('The account could not be removed from secure storage.');
        apiSocket.disconnect();
        clearPersistence();
        
        // Update React state to ensure UI consistency
        setCredentials(null);
        setIsAuthenticated(false);
        currentCredentials.current = null;
        
        if (options?.reload === false) return;
        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await reloadAppAsync();
            } catch (error) {
                Modal.alert(t('common.error'), t('codeLightSetup.reloadFailed'));
            }
        }
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
