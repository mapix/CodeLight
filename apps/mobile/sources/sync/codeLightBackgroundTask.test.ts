import { expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ register: vi.fn(), unregister: vi.fn(), define: vi.fn() }));
vi.mock('expo-background-task', () => ({ BackgroundTaskResult: { Success: 1, Failed: 2 }, BackgroundTaskStatus: { Available: 1 }, getStatusAsync: async () => 1,
    registerTaskAsync: native.register, unregisterTaskAsync: native.unregister }));
vi.mock('expo-task-manager', () => ({ defineTask: native.define, isAvailableAsync: async () => true, isTaskRegisteredAsync: async (name: string) => name.endsWith('v1') }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: true } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => null } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://fixture.example' }));
vi.mock('./codeLightBackgroundCache', () => ({ codeLightAccountScope: vi.fn(), loadCodeLightBackgroundCache: vi.fn(), saveCodeLightBackgroundCache: vi.fn() }));
import { registerCodeLightBackgroundTask } from './codeLightBackgroundTask';
it('migrates an installed 15-minute task before registering the 60-minute energy budget', async () => {
    await registerCodeLightBackgroundTask();
    expect(native.unregister).toHaveBeenCalledWith('codelight-session-refresh-v1');
    expect(native.register).toHaveBeenCalledWith('codelight-session-refresh-v2', { minimumInterval: 60 });
    expect(native.unregister.mock.invocationCallOrder[0]).toBeLessThan(native.register.mock.invocationCallOrder[0]);
});
