import React from 'react';
// @ts-expect-error This workspace does not ship declarations for its existing react-test-renderer runtime.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ select: vi.fn(), visible: vi.fn(), state: 'connecting', progress: 'idle', connected: true, session: { id: 'test-session', metadata: { bridge: { sourceStatus: 'owner-unavailable' } } } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('@/sync/codeLightSessionSelection', () => ({ selectCodeLightSession: mocks.select, useCodeLightSelectionState: () => mocks.state }));
vi.mock('@/sync/storage', () => ({ useSession: () => mocks.session, useSocketStatus: () => ({ status: mocks.connected ? 'connected' : 'error' }) }));
vi.mock('@/sync/codeLightLoadingProgress', () => ({ useCodeLightMessageProgress: () => ({ phase: mocks.progress }) }));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: mocks.visible } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (value: string) => value }));
import { NativeSourceBanner } from './NativeSourceBanner';

it('shows automatic progress without an Open Desktop button or navigation on preload mount', () => {
    mocks.state = 'connecting'; mocks.progress = 'idle'; mocks.select.mockReset();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session', topInset: 120 })); });
    expect(renderer.root.findAllByType('View')[0].props.style.paddingTop).toBe(134);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it('offers connection Retry only after an explicit selection failed', async () => {
    mocks.state = 'failed'; mocks.progress = 'error'; mocks.select.mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    const button = renderer.root.findByType('Pressable');
    expect(button.props.testID).toBe('codelight-retry-session-sync'); expect(button.props.style.minHeight).toBe(44);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('common.retry');
    await act(async () => { button.props.onPress(); }); expect(mocks.select).toHaveBeenCalledWith(mocks.session);
    act(() => renderer.unmount());
});
it('cached disconnection and an older error show synchronization while a new read is loading', () => {
    mocks.state = 'selected'; mocks.progress = 'loading'; mocks.session.metadata.bridge.sourceStatus = 'disconnected';
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codeLightLoading.messages');
    act(() => renderer.unmount());
});
it('a current fresh-read failure offers a read Retry without another desktop navigation', () => {
    mocks.state = 'selected'; mocks.progress = 'error'; mocks.select.mockClear(); mocks.visible.mockClear();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    act(() => renderer.root.findByType('Pressable').props.onPress());
    expect(mocks.visible).toHaveBeenCalledWith('test-session'); expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it('an old read error stays synchronization while the route is recovering', () => {
    mocks.state = 'failed'; mocks.progress = 'error'; mocks.connected = false;
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codeLightLoading.messages');
    act(() => renderer.unmount()); mocks.connected = true;
});
