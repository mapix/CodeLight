import React from 'react';
// @ts-expect-error The existing native test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ connected: false, phase: 'error', visible: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: state.connected ? 'connected' : 'error' }) }));
vi.mock('@/sync/codeLightLoadingProgress', () => ({ useCodeLightMessageProgress: () => ({ phase: state.phase }) }));
vi.mock('@/sync/sync', () => ({ sync: { onSessionVisible: state.visible } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { CodeLightSessionLoading } from './CodeLightSessionLoading';
it('the body overlay retains syncing instead of an obsolete error during route recovery', () => {
    state.connected = false; state.phase = 'error';
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(CodeLightSessionLoading, { sessionId: 'fixture', initial: false, older: false })); });
    expect(view.root.findAllByType('Button')).toHaveLength(0);
    expect(view.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codeLightLoading.messages');
    act(() => view.unmount());
});
it('a current read failure on a connected route still offers Retry', () => {
    state.connected = true; state.phase = 'error';
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(CodeLightSessionLoading, { sessionId: 'fixture', initial: true, older: false })); });
    act(() => view.root.findByType('Button').props.onPress()); expect(state.visible).toHaveBeenCalledWith('fixture');
    act(() => view.unmount());
});
