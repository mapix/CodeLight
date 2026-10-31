import { readFile } from 'node:fs/promises';
import React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import type { PendingAgentCommunication } from '@/sync/agentCommunications';

const state = vi.hoisted(() => ({ pending: [] as PendingAgentCommunication[], answer: vi.fn() }));
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { groupped: { background: 'white' }, text: 'black', textSecondary: 'gray', textLink: 'blue' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), hairlineWidth: 1 } };
});
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSessionPendingCommunications: () => state.pending, useSession: () => ({ metadata: { client: { id: 'noninvasive-bridge' } } }), useSessionMessages: () => ({ messages: [] }) }));
vi.mock('@/sync/ops', () => ({ sessionAnswerQuestion: state.answer, sessionCancelCommunication: vi.fn() }));
import { AgentQuestionBanner } from './AgentQuestionBanner';

// 执行实际 SessionView 的 input JSX，而非复制一个理想布局；原生/网络依赖由轻量夹具替代。
const sourceText = await readFile(new URL('../-session/SessionView.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('SessionView.tsx', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let inputExpression: ts.Expression | undefined;
function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'input') inputExpression = node.initializer;
    ts.forEachChild(node, visit);
}
const loadedScreen = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SessionViewLoaded');
if (!loadedScreen) throw new Error('The loaded session screen is missing.');
visit(loadedScreen);
if (!inputExpression) throw new Error('The loaded session input composition is missing.');
const fixtureCode = ts.transpileModule(`function SessionInputFixture({sessionId, showBottomDockDetails}) {
    const inactiveHint = null, visibleAgentGoal = null, sessionInputHorizontalPadding = 0, session = null;
    const composer = React.createElement('Composer', { testID: 'unchanged-composer' });
    return ${inputExpression.getText(source)};
}`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const SessionInputFixture = new Function('React', 'AnimatedFade', 'CenteredInputWidth', 'AgentQuestionBanner', 'RigActivityBar', `${fixtureCode}; return SessionInputFixture;`)(
    React,
    ({ visible, children }: any) => React.createElement('Fade', { pointerEvents: visible ? 'auto' : 'none', style: { opacity: visible ? 1 : 0 } }, children),
    ({ children }: any) => React.createElement('CenteredInputWidth', {}, children),
    AgentQuestionBanner,
    () => React.createElement('StatusDetails'),
);

it('a late native question stays visible and answerable while the phone reads earlier history', async () => {
    state.pending = [];
    state.answer.mockReset().mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    const props = { sessionId: 'original-source-session', showBottomDockDetails: false };
    act(() => { renderer = create(React.createElement(SessionInputFixture, props)); });
    const byId = (id: string) => renderer.root.findAll((node: any) => node.props.testID === id)[0];
    expect(byId('codelight-question-open')).toBeUndefined();
    const composer = byId('unchanged-composer');
    state.pending = [{ id: 'latest-native-question', createdAt: 5, kind: 'form', questions: [{ id: 'answer', header: 'Latest question', question: 'Choose the original answer', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }];
    act(() => renderer.update(React.createElement(SessionInputFixture, props)));
    const banner = byId('codelight-question-open');
    expect(banner).toBeDefined();
    for (let node = banner; node; node = node.parent) {
        expect(node.props.pointerEvents).not.toBe('none');
        expect(node.props.style?.opacity).not.toBe(0);
    }
    expect(byId('unchanged-composer')).toBe(composer);
    expect(renderer.root.findAllByType('Fade').some((node: any) => node.props.pointerEvents === 'none')).toBe(true);
    act(() => banner.props.onPress());
    expect(renderer.root.findByType('Modal').props.visible).toBe(true);
    act(() => byId('codelight-question-option-answer-1').props.onPress());
    expect(state.answer).not.toHaveBeenCalled();
    expect(byId('codelight-question-submit').props.disabled).toBe(false);
    await act(async () => { await byId('codelight-question-submit').props.onPress(); });
    expect(state.answer).toHaveBeenCalledTimes(1);
    expect(state.answer).toHaveBeenCalledWith('original-source-session', 'latest-native-question', { answer: { options: ['Beta'] } }, 'form');
    state.pending = [];
    act(() => renderer.update(React.createElement(SessionInputFixture, props)));
    expect(byId('codelight-question-open')).toBeUndefined();
    expect(byId('unchanged-composer')).toBe(composer);
    act(() => renderer.unmount());
});
