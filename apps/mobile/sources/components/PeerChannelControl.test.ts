import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'white', divider: 'gray', text: 'black', textSecondary: 'gray' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), hairlineWidth: 1 } };
});
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string, params?: { ms: number }) => params ? `${params.ms} ms` : key }));
vi.mock('./PickerSheet', () => ({
    PickerSheet: ({ children, ...props }: any) => React.createElement('PickerSheet', props, children),
    PickerSheetOption: (props: any) => React.createElement('Option', props),
}));
import { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';

const snapshot: PeerChannelSnapshot = { peerId: 'verified-peer', selectedId: 'local-id', automatic: true, connecting: false,
    channels: [{ id: 'local-id', kind: 'local', url: 'http://192.0.2.10:4567', state: 'connected', latencyMs: 8.1 },
        { id: 'cloud-id', kind: 'cloudflare', url: 'https://tunnel.example', state: 'available', latencyMs: 80 },
        { id: 'relay-id', kind: 'relay', url: 'https://relay.example', state: 'failed' }] };

it('renders only verified routes with real state/latency and opens automatic plus manual choices', () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select })); });
    const open = renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-open')[0];
    act(() => open.props.onPress());
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    const options = renderer.root.findAllByType('Option'); expect(options).toHaveLength(4); expect(options[0].props.selected).toBe(true);
    expect(options[1].props.description).toContain('192.0.2.10:4567'); expect(options[1].props.description).toContain('8 ms');
    expect(options[3].props.description).toContain('codeLightChannels.latencyUnknown'); expect(options[3].props.disabled).toBe(false);
    expect(select).not.toHaveBeenCalled(); act(() => renderer.unmount());
});

it('serializes manual choice and reports failure without changing the existing selected route', async () => {
    let reject!: (error: Error) => void;
    const select = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; })); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot: { ...snapshot, automatic: false }, onSelect: select })); });
    act(() => renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-open')[0].props.onPress());
    const relay = renderer.root.findAllByType('Option')[3];
    act(() => { relay.props.onPress(); relay.props.onPress(); });
    expect(select).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledWith('relay-id');
    expect(renderer.root.findAllByType('Option').every((node: any) => node.props.disabled)).toBe(true);
    await act(async () => { reject(Error('credential value must never enter UI')); });
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    expect(renderer.root.findAllByType('Option')[1].props.selected).toBe(true);
    expect(renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-error')[0].props.children).toBe('codeLightChannels.switchFailed');
    act(() => renderer.unmount());
});

it('an old peer completion cannot close a newly opened peer sheet', async () => {
    let finish!: () => void; const select = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select })); });
    act(() => renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-open')[0].props.onPress());
    act(() => renderer.root.findAllByType('Option')[2].props.onPress());
    act(() => renderer.update(React.createElement(PeerChannelControlView, { snapshot: { ...snapshot, peerId: 'new-verified-peer' }, onSelect: select })));
    act(() => renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-open')[0].props.onPress());
    await act(async () => { finish(); });
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    act(() => renderer.unmount());
});

it('a global settings row keeps route selection explicit and uses the same automatic/manual picker', async () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'settings' })); });
    expect(select).not.toHaveBeenCalled();
    const trigger = renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-open')[0];
    expect(trigger.findAll((node: any) => node.type === 'Text' && node.props.children === 'codeLightChannels.title')).toHaveLength(1);
    act(() => trigger.props.onPress());
    const automatic = renderer.root.findAllByType('Option')[0];
    await act(async () => { automatic.props.onPress(); });
    expect(select).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledWith('auto');
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(false);
    act(() => renderer.unmount());
});

it('a header indicator has no visible route label and opens the same picker only when clicked', () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'header' })); });
    const trigger = renderer.root.findAll((node: any) => node.props.testID === 'codelight-channel-open')[0];
    expect(trigger.findAllByType('Text')).toHaveLength(0);
    expect(trigger.props.accessibilityLabel).toContain('codeLightChannels.automatic');
    expect(select).not.toHaveBeenCalled();
    act(() => trigger.props.onPress()); expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    act(() => renderer.unmount());
});
