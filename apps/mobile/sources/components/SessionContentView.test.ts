import React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('./AgentContentView', () => ({ AgentContentView: (props: any) => React.createElement('ChatSurface', {}, props.content, props.placeholder, props.input) }));
import { SessionContentView } from './SessionContentView';

it('a real window surface mounts its controls without the empty-chat overlay or model composer', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(SessionContentView, {
        windowMode: true,
        content: React.createElement('OpenWindowControl'),
        placeholder: React.createElement('EmptyMessagesOverlay'),
        input: React.createElement('ModelComposer'),
        floatingDock: true,
    })); });
    expect(renderer.root.findAllByType('OpenWindowControl')).toHaveLength(1);
    expect(renderer.root.findAllByType('EmptyMessagesOverlay')).toHaveLength(0);
    expect(renderer.root.findAllByType('ModelComposer')).toHaveLength(0);
    expect(renderer.root.findAllByType('ChatSurface')).toHaveLength(0);
    act(() => renderer.unmount());
});

it('ordinary chat mode keeps its content, loading/empty state and composer when a surface changes mode', () => {
    let renderer!: ReturnType<typeof create>;
    const props = { content: React.createElement('SessionMessages'), placeholder: React.createElement('ChatPlaceholder'), input: React.createElement('ChatComposer') };
    act(() => { renderer = create(React.createElement(SessionContentView, { ...props, windowMode: false })); });
    for (const type of ['SessionMessages', 'ChatPlaceholder', 'ChatComposer']) expect(renderer.root.findAllByType(type)).toHaveLength(1);
    act(() => renderer.update(React.createElement(SessionContentView, { ...props, content: React.createElement('WindowControls'), windowMode: true })));
    expect(renderer.root.findAllByType('WindowControls')).toHaveLength(1);
    expect(renderer.root.findAllByType('ChatPlaceholder')).toHaveLength(0);
    expect(renderer.root.findAllByType('ChatComposer')).toHaveLength(0);
    act(() => renderer.unmount());
});

it('an empty native session shows automatic synchronization and its local draft while deferring the empty overlay', () => {
    let renderer!: ReturnType<typeof create>;
    const props = { windowMode: false, content: React.createElement('SourceSyncProgress'), placeholder: React.createElement('EmptyMessagesOverlay'), input: React.createElement('LocalDraftComposer') };
    act(() => { renderer = create(React.createElement(SessionContentView, { ...props, sourceActivationRequired: true })); });
    expect(renderer.root.findAllByType('SourceSyncProgress')).toHaveLength(1);
    expect(renderer.root.findAllByType('LocalDraftComposer')).toHaveLength(1);
    expect(renderer.root.findAllByType('EmptyMessagesOverlay')).toHaveLength(0);
    act(() => renderer.update(React.createElement(SessionContentView, { ...props, sourceActivationRequired: false })));
    expect(renderer.root.findAllByType('EmptyMessagesOverlay')).toHaveLength(1);
    act(() => renderer.unmount());
});
