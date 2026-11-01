import React from 'react';
// @ts-expect-error The existing test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), phase: 'loading', status: 'connected', session: { id: 'known-session', metadata: {} } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', FlatList: 'List', Pressable: 'Button', Text: 'Text', TextInput: 'Input', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray' } } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@/sync/storage', () => ({ useAllSessions: () => [mocks.session], useAllMachines: () => [], useSocketStatus: () => ({ status: mocks.status }) }));
vi.mock('@/sync/codeLightLoadingProgress', () => ({ useCodeLightDiscoveryProgress: () => ({ phase: mocks.phase, found: 0 }) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: vi.fn() } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: mocks.navigate }));
vi.mock('@/utils/codeLightSessionBrowser', () => ({ isCodeLightCodexSession: () => true, codeLightProjectKey: () => 'project',
    buildCodeLightBrowserRows: () => [{ kind: 'session', key: 'known', session: mocks.session, title: 'Known session' }] }));
vi.mock('@/utils/sessionListTimestamp', () => ({ formatSessionListTimestamp: () => '' }));
vi.mock('@/hooks/useCodeLightProjectActivity', () => ({ useCodeLightProjectActivities: () => {} }));
vi.mock('@/sync/codeLightProjectActivity', () => ({ codeLightProjectActivityStore: { mark: () => {}, markSessions: () => {} } }));
vi.mock('./CodeLightProjectStatus', () => ({ CodeLightProjectStatus: () => null }));
vi.mock('./CodeLightSessionStatus', () => ({ CodeLightSessionStatus: () => null }));
vi.mock('./CodeLightBottomNavigation', () => ({ CodeLightBottomNavigation: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { CodeLightSessions } from './CodeLightSessions';
it('known rows remain pressable during title synchronization and an obsolete connection error', () => {
    for (const state of [{ phase: 'loading', status: 'connected' }, { phase: 'error', status: 'connecting' }]) {
        Object.assign(mocks, state); mocks.navigate.mockClear();
        let screen!: ReturnType<typeof create>, row!: ReturnType<typeof create>;
        act(() => { screen = create(React.createElement(CodeLightSessions)); });
        const list = screen.root.findByType('List');
        act(() => { row = create(list.props.renderItem({ item: list.props.data[0] })); });
        const button = row.root.findByType('Button'); expect(button.props.disabled).not.toBe(true);
        act(() => button.props.onPress()); expect(mocks.navigate).toHaveBeenCalledWith(expect.anything(), 'known-session');
        expect(screen.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codeLightLoading.titles');
        expect(screen.root.findAllByType('Text').map((node: any) => node.props.children)).not.toContain('codeLightLoading.failed');
        act(() => { row.unmount(); screen.unmount(); });
    }
});
