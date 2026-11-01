import React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const { answer, cancel } = vi.hoisted(() => ({ answer: vi.fn(), cancel: vi.fn() }));
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
vi.mock('@/sync/ops', () => ({ sessionAnswerQuestion: answer, sessionCancelCommunication: cancel }));
import { AgentQuestionBanner } from './AgentQuestionBanner';
import { BridgeRpcUnconfirmedError } from '@/sync/noninvasiveRpcJournal';
import { AgentQuestionModal } from './AgentQuestionModal';

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

it('an unconfirmed answer keeps the draft, offers receipt checking and closes without cancelling the sent answer', async () => {
    answer.mockReset(); cancel.mockReset(); answer.mockRejectedValue(new BridgeRpcUnconfirmedError('original-command'));
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(AgentQuestionBanner, { sessionId: 'native-source-session' })); });
    const byId = (id: string) => renderer.root.findAll((node: any) => node.props.testID === id)[0];
    act(() => byId('codelight-question-open').props.onPress());
    act(() => byId('codelight-question-option-answer-1').props.onPress());
    await act(async () => { await byId('codelight-question-submit').props.onPress(); });
    expect(byId('codelight-question-option-answer-1').props.disabled).toBe(true);
    expect(byId('codelight-question-submit').props.children.props.children).toBe('agentQuestion.checkResult');
    await act(async () => { await byId('codelight-question-close').props.onPress(); });
    expect(cancel).not.toHaveBeenCalled(); expect(answer).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
});

it('a late earlier answer cannot close a newer question form', async () => {
    answer.mockReset(); let finish!: () => void; answer.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const earlierClose = vi.fn(), currentClose = vi.fn(); let renderer!: ReturnType<typeof create>, submission!: Promise<void>;
    act(() => { renderer = create(React.createElement(AgentQuestionModal, { pending, sessionId: 'native-source-session', visible: true, onClose: earlierClose })); });
    const byId = (id: string) => renderer.root.findAll((node: any) => node.props.testID === id)[0];
    act(() => byId('codelight-question-option-answer-1').props.onPress());
    act(() => { submission = byId('codelight-question-submit').props.onPress(); });
    act(() => renderer.update(React.createElement(AgentQuestionModal, { pending: { ...pending, id: 'new-question' }, sessionId: 'native-source-session', visible: true, onClose: currentClose })));
    await act(async () => { finish(); await submission; });
    expect(earlierClose).not.toHaveBeenCalled(); expect(currentClose).not.toHaveBeenCalled();
    expect(renderer.root.findByType('Modal').props.visible).toBe(true);
    act(() => renderer.unmount());
});
