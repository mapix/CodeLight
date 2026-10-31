import * as React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios', select: (choices: any) => choices.ios ?? choices.default },
    setParams: vi.fn(), back: vi.fn(), track: vi.fn(),
    worktree: null as any, pending: null as any, pendingChats: [] as any[], sessions: {} as Record<string, any>,
}));
vi.mock('react-native', () => ({ Platform: mocks.platform, Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View' }));
vi.mock('react-native-unistyles', () => {
    const theme = { dark: false, colors: { text: 'black', textSecondary: 'gray', header: { tint: 'blue' }, glass: { backgroundStrong: 'white' }, surfaceHigh: 'white', divider: 'gray' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), hairlineWidth: 1 } };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ setParams: mocks.setParams, back: mocks.back }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSessionListViewData: () => [], storage: { getState: () => ({ sessions: mocks.sessions, sessionListViewData: [] }) } }));
vi.mock('@/sync/pendingChats', () => ({ usePendingChat: () => mocks.pending, usePendingChatsBeside: () => mocks.pendingChats, openPendingChat: vi.fn() }));
vi.mock('@/sync/pendingChatHandover', () => ({ handOverPendingChat: vi.fn(), retirePendingChat: vi.fn() }));
vi.mock('@/utils/projectHomeList', () => ({ findProjectWorktree: () => mocks.worktree, locateProjectWorkspace: () => null }));
vi.mock('@/utils/newSessionCheckout', () => ({ newSessionLikeSession: vi.fn() }));
vi.mock('@/hooks/useStartSessionFromDraft', () => ({ useStartSessionFromDraft: () => ({ startSession: vi.fn() }) }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionActionAlert: () => vi.fn() }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/track', () => ({ trackSessionSwitched: mocks.track }));
vi.mock('./MobileGlass', () => ({ MobileGlassSurface: 'MobileGlassSurface' }));
vi.mock('./SessionActionsPopover', () => ({ SessionActionsPopover: 'SessionActionsPopover' }));
vi.mock('./ShimmerText', () => ({ ShimmerText: 'ShimmerText' }));
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('./layout', () => ({ layout: { headerMaxWidth: 800 } }));
vi.mock('./NativeOptionsPicker', () => ({ NativeOptionsPicker: 'NativeOptionsPicker' }));

import { WorktreeTabStrip } from './WorktreeTabStrip';

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.OS = 'ios';
    mocks.pending = null; mocks.pendingChats = [];
    const tabs = Array.from({ length: 150 }, (_, index) => ({ id: `session-${index}`, name: `Long conversation title ${index}`, state: 'idle', hasUnread: false }));
    mocks.worktree = { id: 'checkout', tabs };
    mocks.sessions = Object.fromEntries(tabs.map(session => [session.id, session]));
});

function render(sessionId: string) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(WorktreeTabStrip, { sessionId })); });
    return renderer;
}

it('a large native project uses one select with every full title and the exact current session', () => {
    const renderer = render('session-75');
    const picker = renderer.root.findByType('NativeOptionsPicker');
    expect(renderer.root.findAllByType('ScrollView')).toHaveLength(0);
    expect(picker.props.triggerLabel).toBe('Long conversation title 75');
    expect(picker.props.selectedKey).toBe('session-75');
    expect(picker.props.showChevron).toBe(true);
    expect(picker.props.sections[0].options).toHaveLength(150);
    expect(picker.props.sections[0].options[149]).toEqual({ key: 'session-149', label: 'Long conversation title 149' });
    expect(mocks.setParams).not.toHaveBeenCalled();
    act(() => picker.props.onSelect('session-75'));
    expect(mocks.setParams).not.toHaveBeenCalled();
    act(() => picker.props.onSelect('session-149'));
    expect(mocks.setParams).toHaveBeenCalledExactlyOnceWith({ id: 'session-149' });
    expect(mocks.track).toHaveBeenCalledWith(mocks.sessions['session-149']);
    act(() => renderer.unmount());
});

it('a pending chat that became a session stays selected without throwing away its composer route', () => {
    mocks.pending = { id: 'pending-chat', anchorSessionId: 'session-0', sessionId: 'session-149', knownSessionIds: [] };
    mocks.pendingChats = [mocks.pending];
    const renderer = render('pending-chat');
    const picker = renderer.root.findByType('NativeOptionsPicker');
    expect(picker.props.selectedKey).toBe('session-149');
    expect(picker.props.sections[0].options.some((option: any) => option.key === 'pending-chat')).toBe(false);
    act(() => picker.props.onSelect('session-149'));
    expect(mocks.setParams).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});

it('the web keeps its existing tab strip', () => {
    mocks.platform.OS = 'web';
    const renderer = render('session-0');
    expect(renderer.root.findAllByType('NativeOptionsPicker')).toHaveLength(0);
    expect(renderer.root.findAllByType('ScrollView')).toHaveLength(1);
    act(() => renderer.unmount());
});
