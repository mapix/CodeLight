import { expect, it } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

const fragment = (id: string, sourceId: string): NormalizedMessage => ({ id, localId: null, createdAt: 1, role: 'user', isSidechain: false,
    content: { type: 'text', text: 'Same original input' }, meta: { sentFrom: 'noninvasive-observer', nativeRow: { id: sourceId, offset: 0, revision: 0 } }, turn: 'original-turn' });
const snapshot = (replaceSourceRowIds: string[] = []): NormalizedMessage => ({ id: 'current-snapshot', localId: null, createdAt: 2, role: 'event', isSidechain: false,
    content: { type: 'native-row-upsert', sourceRowId: 'accepted-row', role: 'user', text: 'Same original input', revision: 1,
        snapshotRevision: 3, streamRevision: 1, ownerGeneration: 'owner', replaceIds: [], replaceSourceRowIds }, meta: { sentFrom: 'noninvasive-observer' }, turn: 'original-turn' });
it('the native caller/server replacement merges an old steering UUID even when the full snapshot arrives first', () => {
    const state = createReducer(); reducer(state, [fragment('old-wire', 'legacy-steering-uuid')]);
    reducer(state, [snapshot(['legacy-steering-uuid'])]);
    expect(state.messages.size).toBe(1);
    reducer(state, [fragment('old-wire-replayed', 'legacy-steering-uuid')]); expect(state.messages.size).toBe(1);
});
it('a same-version late replacement still retires its aliases without replacing newer text', () => {
    const state = createReducer(); reducer(state, [fragment('old-wire', 'legacy-steering-uuid')]); reducer(state, [snapshot()]);
    const update = snapshot(['legacy-steering-uuid']); update.id = 'late-wire';
    if (update.role === 'event' && update.content.type === 'native-row-upsert') { delete update.content.snapshotRevision; update.content.replaceIds = ['old-wire']; update.content.text = 'Older text must not replace the snapshot'; }
    reducer(state, [update]); expect(state.messages.size).toBe(1); expect([...state.messages.values()][0].text).toBe('Same original input');
});
it('equal text from unrelated original rows is not merged', () => {
    const state = createReducer(); reducer(state, [fragment('wire-one', 'first-row'), fragment('wire-two', 'second-row')]);
    expect(state.messages.size).toBe(2);
});
