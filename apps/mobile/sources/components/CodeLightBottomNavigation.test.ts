import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'white', divider: 'gray', textLink: 'blue', textSecondary: 'gray', surfacePressed: 'silver' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), hairlineWidth: 1 } };
});
import { CodeLightBottomNavigationView } from './CodeLightBottomNavigation';

it('top-level tabs expose the selected page and reselecting it does not navigate or reload', () => {
    const navigate = vi.fn(); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodeLightBottomNavigationView, { active: 'settings', onNavigate: navigate })); });
    const settings = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'codelight-tab-settings')[0];
    const sessions = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'codelight-tab-sessions')[0];
    expect(settings.props.accessibilityState.selected).toBe(true); expect(sessions.props.accessibilityState.selected).toBe(false);
    act(() => settings.props.onPress()); expect(navigate).not.toHaveBeenCalled();
    act(() => sessions.props.onPress()); expect(navigate).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledWith('sessions');
    act(() => renderer.unmount());
});
