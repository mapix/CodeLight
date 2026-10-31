import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { TokenStorage } from '@/auth/tokenStorage';
import { config } from '@/config';
import { getServerUrl } from './serverConfig';
import { codeLightAccountScope, loadCodeLightBackgroundCache, saveCodeLightBackgroundCache } from './codeLightBackgroundCache';
import { refreshCodeLightBackground } from './codeLightBackgroundCore';

export const CODELIGHT_BACKGROUND_TASK = 'codelight-session-refresh-v2';
TaskManager.defineTask(CODELIGHT_BACKGROUND_TASK, async () => {
    const credentials = await TokenStorage.getCredentials();
    if (!config.noninvasiveLocal || !credentials) return BackgroundTask.BackgroundTaskResult.Success;
    const scope = await codeLightAccountScope(credentials);
    const abort = new AbortController(); const deadline = setTimeout(() => abort.abort(), 25000);
    try {
        await refreshCodeLightBackground({ origin: credentials.serverUrl ?? getServerUrl(), token: credentials.token, scope,
            cache: loadCodeLightBackgroundCache(scope), signal: abort.signal,
            stillCurrent: async () => {
                const current = await TokenStorage.getCredentials();
                return !!current && await codeLightAccountScope(current) === scope;
            }, commit: saveCodeLightBackgroundCache });
        return BackgroundTask.BackgroundTaskResult.Success;
    } catch { return BackgroundTask.BackgroundTaskResult.Failed; }
    finally { clearTimeout(deadline); }
});
export async function registerCodeLightBackgroundTask() {
    if (!config.noninvasiveLocal || Platform.OS === 'web' || !await TaskManager.isAvailableAsync()) return;
    // 已安装的 v1 保留 15 分钟调度；迁移到 v2 才能实际应用节能预算，不能只改注册时的默认值。
    if (await TaskManager.isTaskRegisteredAsync('codelight-session-refresh-v1')) await BackgroundTask.unregisterTaskAsync('codelight-session-refresh-v1');
    if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Available
        && !await TaskManager.isTaskRegisteredAsync(CODELIGHT_BACKGROUND_TASK)) {
        await BackgroundTask.registerTaskAsync(CODELIGHT_BACKGROUND_TASK, { minimumInterval: 60 });
    }
}
