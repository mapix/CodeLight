import React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const { answer } = vi.hoisted(() => ({ answer: vi.fn() }));
const pending = { id: 'native-communication-id', createdAt: 1, kind: 'form' as const, questions: [{ id: 'answer', header: '', question: 'Choose the CodeLight test option', options: [{ label: 'Alpha' }, { label: 'Beta' }], required: true, allowCustom: true }] };
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
vi.mock('@/sync/storage', () => ({ useSessionPendingCommunications: () => [pending], useSession: () => ({ metadata: { client: { id: 'noninvasive-bridge' } } }), useSessionMessages: () => ({ messages: [] }) }));
vi.mock('@/sync/ops', () => ({ sessionAnswerQuestion: answer, sessionCancelCommunication: vi.fn() }));
import { AgentQuestionBanner } from './AgentQuestionBanner';

it('an unmatched Native choice form opens, selects Beta without submission, and submits the original form identity once', async () => {
    answer.mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(AgentQuestionBanner, { sessionId: 'native-source-session' })); });
    const byId = (id: string) => renderer.root.findAll((node: any) => node.props.testID === id)[0];
    expect(byId('codelight-question-open')).toBeDefined();
    act(() => byId('codelight-question-open').props.onPress());
    expect(renderer.root.findByType('Modal').props.visible).toBe(true);
    expect(byId('codelight-question-submit').props.disabled).toBe(true);
    act(() => byId('codelight-question-option-answer-1').props.onPress());
    expect(answer).not.toHaveBeenCalled();
    expect(byId('codelight-question-submit').props.disabled).toBe(false);
    await act(async () => { await byId('codelight-question-submit').props.onPress(); });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith('native-source-session', 'native-communication-id', { answer: { options: ['Beta'] } }, 'form');
    expect(renderer.root.findByType('Modal').props.visible).toBe(false);
    act(() => renderer.unmount());
});
