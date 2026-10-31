import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, type RawRecord } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';

function user(id = 'server-user', localId = 'mobile-user') {
    const value = normalizeRawMessage(id, localId, 1, { role: 'user', content: { type: 'text', text: 'same text' }, meta: { expectsAcceptance: true } } as unknown as RawRecord);
    if (!value) throw Error('Native user fixture was dropped');
    return value;
}
function outcome(id: string, ref: string, t: 'user-message-accepted' | 'user-message-delivery-unknown') {
    const value = normalizeRawMessage(id, `${id}-observed`, 10, { role: 'session', content: { id, time: 10, role: 'agent',
        ev: t === 'user-message-accepted' ? { t, id, ref, runId: 'original-turn' } : { t, ref, commandId: 'original-command' } } } as unknown as RawRecord);
    if (!value) throw Error('Native outcome fixture was dropped');
    return value;
}
const options = { holdUserMessagesUntilAccepted: true };

describe('CodeLight nonterminal delivery outcome', () => {
    it('holds old phone records lacking expectsAcceptance while preserving already observed native history', () => {
        const state = createReducer();
        const legacyPhone = normalizeRawMessage('old-server-user', 'old-mobile-user', 1, { role: 'user', content: { type: 'text', text: 'old phone record' } } as unknown as RawRecord)!;
        const observed = normalizeRawMessage('native-observed', 'native-observed-log', 2, { role: 'session', content: { id: 'native-observed', time: 2, role: 'user', turn: 'original-turn', ev: { t: 'text', text: 'original history' } }, meta: { sentFrom: 'noninvasive-observer' } } as unknown as RawRecord)!;
        const result = reducer(state, [legacyPhone, observed], null, { ...options, holdUnobservedUserMessagesUntilAccepted: true });
        expect(result.messages.find(message => message.kind === 'user-text' && message.text === 'old phone record')).toMatchObject({ pending: true });
        expect(result.messages.find(message => message.kind === 'user-text' && message.text === 'original history')).not.toHaveProperty('pending');
    });
    it('updates only the referenced bubble, keeps pending, and clears uncertainty on exact accepted receipt', () => {
        const state = createReducer();
        reducer(state, [user(), user('other-server-user', 'other-mobile-user')], null, options);
        const changed = reducer(state, [outcome('unknown-event', 'server-user', 'user-message-delivery-unknown')], null, options);
        expect(changed.messages).toHaveLength(1);
        expect(changed.messages[0]).toMatchObject({ kind: 'user-text', pending: true, deliveryUnconfirmed: true });
        expect(changed.messages[0]).not.toHaveProperty('sendError');
        const accepted = reducer(state, [outcome('accepted-event', 'server-user', 'user-message-accepted')], null, options);
        expect(accepted.messages[0]).toMatchObject({ kind: 'user-text' });
        expect(accepted.messages[0]).not.toHaveProperty('pending');
        expect(accepted.messages[0]).not.toHaveProperty('deliveryUnconfirmed');
        const other = [...state.messages.values()].find(row => row.realID === 'other-server-user');
        expect(other?.pending).toBe(true); expect(other?.deliveryUnconfirmed).toBeUndefined();
    });

    it.each([true, false])('terminal receipt wins when records precede the user message, independent of unknown arrival order (%s)', (unknownFirst) => {
        const state = createReducer();
        const unknown = outcome('unknown-event', 'server-user', 'user-message-delivery-unknown');
        const accepted = outcome('accepted-event', 'server-user', 'user-message-accepted');
        reducer(state, unknownFirst ? [unknown, accepted] : [accepted, unknown], null, options);
        const result = reducer(state, [user()], null, options);
        expect(result.messages[0]).toMatchObject({ kind: 'user-text' });
        expect(result.messages[0]).not.toHaveProperty('pending');
        expect(result.messages[0]).not.toHaveProperty('deliveryUnconfirmed');
    });

    it('replayed old unknown receipt cannot regress a bubble already accepted', () => {
        const state = createReducer();
        reducer(state, [user()], null, options);
        reducer(state, [outcome('accepted-event', 'server-user', 'user-message-accepted')], null, options);
        const replay = reducer(state, [outcome('unknown-late-replay', 'server-user', 'user-message-delivery-unknown')], null, options);
        expect(replay.messages).toHaveLength(0);
        expect([...state.messages.values()][0]).toMatchObject({ pending: false });
    });
});
