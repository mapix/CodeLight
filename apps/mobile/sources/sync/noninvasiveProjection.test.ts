import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, type RawRecord } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';

const message = (id: string, time: number, ev: Record<string, unknown>) => {
    const normalized = normalizeRawMessage(id, `${id}-observed`, time, {
        role: 'session', content: { id, time, role: 'agent', turn: 'original-turn', ev },
    } as unknown as RawRecord);
    if (!normalized) throw new Error('Native source event was dropped');
    return normalized;
};

describe('CodeLight native projection', () => {
    it('replaces only the named fragments and ignores old fragments replayed later', () => {
        const state = createReducer();
        reducer(state, [message('prefix', 10, { t: 'text', text: 'wrong' }), message('suffix', 11, { t: 'text', text: ' text' }), message('other', 12, { t: 'text', text: 'keep me' })]);
        const update = message('corrected', 20, { t: 'native-row-upsert', sourceRowId: 'native-row', role: 'assistant', text: 'correct text', revision: 1, replaceIds: ['prefix', 'suffix'] });
        const result = reducer(state, [update]);
        expect(result.messages.filter(m => m.kind === 'agent-text').map(m => m.text)).toContain('correct text');
        expect(result.removedMessageIds).toHaveLength(1);
        reducer(state, [update, message('suffix', 11, { t: 'text', text: ' text' })]);
        expect([...state.messages.values()].filter(m => m.text).map(m => m.text).sort()).toEqual(['correct text', 'keep me']);
    });

    it('keeps incremental tool output running until the original tool-end', () => {
        const state = createReducer();
        reducer(state, [message('start', 1, { t: 'tool-call-start', call: 'native-tool', name: 'Shell', title: 'Shell', description: '', args: {} })]);
        const progress = message('progress', 2, { t: 'native-row-upsert', sourceRowId: 'native-row', role: 'tool', text: '', revision: 1, replaceIds: [], tools: [{ id: 'native-tool', output: 'first line', status: 'inProgress' }] });
        const result = reducer(state, [progress]);
        const tool = result.messages.find(m => m.kind === 'tool-call');
        expect(tool?.kind === 'tool-call' && tool.tool.state).toBe('running');
        expect(tool?.kind === 'tool-call' && tool.tool.result).toBe('first line');
        reducer(state, [message('end', 3, { t: 'tool-call-end', call: 'native-tool', result: 'final output' })]);
        reducer(state, [progress]);
        expect([...state.messages.values()].find(m => m.tool)?.tool).toMatchObject({ state: 'completed', result: 'final output' });
    });
});
