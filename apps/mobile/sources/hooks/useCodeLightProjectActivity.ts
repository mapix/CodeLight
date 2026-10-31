import * as React from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { randomUUID } from 'expo-crypto';
import { TokenStorage } from '@/auth/tokenStorage';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { codeLightAccountScope } from '@/sync/codeLightBackgroundCache';
import { CodeLightProjectActivityController, codeLightProjectActivityStore, type CodeLightProjectDescriptor } from '@/sync/codeLightProjectActivity';

export function useCodeLightProjectActivities(projects: CodeLightProjectDescriptor[]) {
    const focused = useIsFocused();
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
    const controller = React.useMemo(() => new CodeLightProjectActivityController({
        store: codeLightProjectActivityStore, clientId: randomUUID(),
        scope: async () => {
            const credentials = await TokenStorage.getCredentials();
            return credentials ? getServerUrl() + ':' + await codeLightAccountScope(credentials) : '';
        },
        request: (machine, params) => apiSocket.machineRPC(machine, 'codelight-project-activity', params),
    }), []);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
        return () => subscription.remove();
    }, []);
    React.useEffect(() => { controller.setProjects(projects); }, [controller, projects]);
    React.useEffect(() => { controller.setEnabled(focused && foreground); }, [controller, focused, foreground]);
    // StrictMode 会先清理再重新设置 effects；停采已释放所有资源，不能把可重用控制器永久标成 closed。
    React.useEffect(() => () => controller.setEnabled(false), [controller]);
}

export function useCodeLightProjectActivity(id: string) {
    const subscribe = React.useCallback((changed: () => void) => codeLightProjectActivityStore.subscribe(id, changed), [id]);
    const get = React.useCallback(() => codeLightProjectActivityStore.get(id), [id]);
    return React.useSyncExternalStore(subscribe, get);
}

export function useCodeLightSessionActivity(id: string) {
    const subscribe = React.useCallback((changed: () => void) => codeLightProjectActivityStore.subscribeSession(id, changed), [id]);
    const get = React.useCallback(() => codeLightProjectActivityStore.getSession(id), [id]);
    return React.useSyncExternalStore(subscribe, get);
}
