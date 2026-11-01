import type { NormalizedMessage } from '../typesRaw';
import type { ReducerState } from './reducer';

/** Superseded native identities are authoritative aliases, not text-based deduplication. */
function bindReplacements(state: ReducerState, sourceId: string, wireIds: string[], sourceIds: string[], target: string, changed: Set<string>, removed: string[], replacedRows: string[] = []) {
    const replaced = new Set(wireIds), aliases = new Set<string>(replacedRows);
    for (const id of wireIds) { const mapped = state.messageIds.get(id); if (mapped) aliases.add(mapped); }
    for (const id of sourceIds) { const mapped = state.nativeRowIds.get(id); if (mapped) aliases.add(mapped); }
    for (const row of state.messages.values()) if (!row.tool && row.realID && replaced.has(row.realID)) aliases.add(row.id);
    aliases.delete(target);
    const targetRow = state.messages.get(target);
    const acceptedInput = [...aliases].map(id => state.messages.get(id)).find(row => row?.role === 'user' && row.meta?.sentFrom !== 'noninvasive-observer'
        && (replaced.has(row.realID ?? '') || replaced.has(row.localId ?? '')));
    if (targetRow?.role === 'user' && acceptedInput) {
        state.messages.set(target, { ...targetRow, createdAt: acceptedInput.createdAt, localId: acceptedInput.localId ?? targetRow.localId,
            meta: { ...targetRow.meta, ...acceptedInput.meta }, pending: false, deliveryUnconfirmed: false, sendError: undefined, sortAt: acceptedInput.createdAt });
        changed.add(target);
    }
    for (const id of aliases) { state.messages.delete(id); changed.delete(id); if (!removed.includes(id)) removed.push(id); }
    for (const [id, mapped] of state.messageIds) if (aliases.has(mapped)) state.messageIds.set(id, target);
    for (const [id, mapped] of state.localIds) if (aliases.has(mapped)) state.localIds.set(id, target);
    for (const [id, mapped] of state.nativeRowIds) if (aliases.has(mapped)) {
        state.nativeRowIds.set(id, target); if (id !== sourceId) state.nativeRetiredRowIds.add(id);
    }
    for (const id of wireIds) state.messageIds.set(id, target);
    for (const id of sourceIds) { state.nativeRowIds.set(id, target); if (id !== sourceId) state.nativeRetiredRowIds.add(id); }
}

/** 原 owner 的修订只替换明确的片段身份；内容相同不代表同一消息。 */
export function applyNativeProjection(state: ReducerState, messages: NormalizedMessage[], changed: Set<string>) {
    const removed: string[] = [];
    const updates = messages.filter(m => m.role === 'event' && m.content.type === 'native-row-upsert');
    for (const message of updates) {
        if (message.role !== 'event' || message.content.type !== 'native-row-upsert') continue;
        const update = message.content;
        if (update.role === 'tool') {
            for (const tool of update.tools ?? []) {
                const key = `tool:${tool.id}`;
                if (update.snapshotRevision !== undefined) {
                    const id = state.toolIdToMessageId.get(tool.id) ?? `native-tool:${tool.id}`, existing = state.messages.get(id);
                    const owner = update.ownerGeneration ?? 'unknown', priorOwner = state.nativeSnapshotOwners.get(key);
                    if (priorOwner !== owner) { state.nativeSnapshotOwners.set(key, owner); if (priorOwner !== undefined) state.nativeRevisions.delete(key); }
                    const seedKey = JSON.stringify(['tool-snapshot', owner, tool.id]);
                    const streamAhead = (state.nativeRevisions.get(key) ?? 0) > (update.streamRevision ?? 0);
                    if ((state.nativeRevisions.get(seedKey) ?? 0) >= update.snapshotRevision || streamAhead && existing?.tool) continue;
                    state.nativeRevisions.set(seedKey, update.snapshotRevision);
                    if ((update.streamRevision ?? 0) > 0) state.nativeRevisions.set(key, Math.max(update.streamRevision!, state.nativeRevisions.get(key) ?? 0));
                    const completed = ['completed', 'failed', 'cancelled', 'interrupted', 'error'].includes(tool.status);
                    // 旧 running seed 不能触发通用 tool-start 的“审批占位→运行”分支，把真实终态重新打开。
                    if (!completed && existing?.tool?.state !== undefined && existing.tool.state !== 'running' && existing.tool.startedAt !== null) continue;
                    state.messages.set(id, { ...existing, id, realID: message.id, role: 'agent', createdAt: existing?.createdAt ?? message.createdAt, text: null, event: null, meta: message.meta, turn: message.turn,
                        tool: { ...existing?.tool, callId: tool.id, name: tool.name || existing?.tool?.name || 'Tool', input: existing?.tool?.input ?? {},
                            createdAt: existing?.tool?.createdAt ?? message.createdAt, startedAt: existing?.tool?.startedAt ?? message.createdAt,
                            completedAt: completed ? existing?.tool?.completedAt ?? null : null, description: existing?.tool?.description ?? tool.name ?? '',
                            state: completed ? tool.status === 'completed' ? 'completed' : 'error' : 'running',
                            result: streamAhead ? state.nativeToolUpdates.get(tool.id) ?? tool.output : tool.output } });
                    state.toolIdToMessageId.set(tool.id, id); state.messageIds.set(message.id, id); changed.add(id);
                    continue;
                }
                if ((state.nativeRevisions.get(key) ?? 0) >= update.revision) continue;
                state.nativeRevisions.set(key, update.revision);
                state.nativeToolUpdates.set(tool.id, tool.output);
            }
            continue;
        }
        if (state.nativeRetiredRowIds.has(update.sourceRowId)) continue;
        const currentCanonical = state.nativeRowIds.get(update.sourceRowId);
        // 正文已经由快照播种时，较早/同版本 wire 的替换关联仍需生效，不能留下临时 steering 气泡。
        if (currentCanonical) bindReplacements(state, update.sourceRowId, update.replaceIds, update.replaceSourceRowIds ?? [], currentCanonical, changed, removed);
        if (update.snapshotRevision !== undefined) {
            const owner = update.ownerGeneration ?? 'unknown';
            const priorOwner = state.nativeSnapshotOwners.get(update.sourceRowId);
            if (priorOwner !== owner) {
                state.nativeSnapshotOwners.set(update.sourceRowId, owner);
                if (priorOwner !== undefined) state.nativeRevisions.delete(update.sourceRowId);
            }
            const key = JSON.stringify(['snapshot', owner, update.sourceRowId]);
            if ((state.nativeRevisions.get(key) ?? 0) >= update.snapshotRevision
                || (state.nativeRevisions.get(update.sourceRowId) ?? 0) > (update.streamRevision ?? 0)) continue;
            // 快照版本与流式 entry.revision 分属两个 owner；较大的快照版本不能压住后来的第1次文本修订。
            state.nativeRevisions.set(key, update.snapshotRevision);
            if ((update.streamRevision ?? 0) > 0) state.nativeRevisions.set(update.sourceRowId, update.streamRevision!);
        } else {
            if ((state.nativeRevisions.get(update.sourceRowId) ?? 0) >= update.revision) continue;
            state.nativeRevisions.set(update.sourceRowId, update.revision);
        }
        const replaced = new Set(update.replaceIds);
        const aliases = new Set([...update.replaceIds.map(id => state.messageIds.get(id)), ...(update.replaceSourceRowIds ?? []).map(id => state.nativeRowIds.get(id))].filter(Boolean));
        const canonical = state.nativeRowIds.get(update.sourceRowId);
        // 最近窗口会改变 realID；必须沿原生身份与旧 wire 别名找回同一显示行。
        const existing = [...state.messages.values()].filter(row => !row.tool && (row.id === canonical || aliases.has(row.id) || !!row.realID && replaced.has(row.realID)));
        const first = existing.sort((a, b) => a.createdAt - b.createdAt)[0];
        const internalId = first?.id ?? `native:${update.sourceRowId}`;
        const acceptedInput = update.role === 'user' && first?.role === 'user' && first.meta?.sentFrom !== 'noninvasive-observer'
            && (replaced.has(first.realID ?? '') || replaced.has(first.localId ?? ''));
        // 保存被替换 wire id：历史分页和重新连线不能让旧片段再次出现。
        for (const id of replaced) state.messageIds.set(id, internalId);
        for (const row of existing.slice(1)) { state.messages.delete(row.id); changed.delete(row.id); removed.push(row.id); }
        state.messages.set(internalId, { ...first, id: internalId, realID: message.id,
            role: update.role === 'user' ? 'user' : 'agent', createdAt: acceptedInput ? first.createdAt : update.snapshotRevision !== undefined ? message.createdAt : first?.createdAt ?? message.createdAt,
            text: update.role === 'reasoning' ? `*${update.text}*` : update.text,
            isThinking: update.role === 'reasoning', event: null, tool: null, meta: acceptedInput ? { ...message.meta, ...first.meta } : message.meta, turn: message.turn,
            ...(acceptedInput ? { pending: false, deliveryUnconfirmed: false, sendError: undefined, sortAt: first.createdAt } : {}) });
        state.messageIds.set(message.id, internalId);
        state.nativeRowIds.set(update.sourceRowId, internalId);
        bindReplacements(state, update.sourceRowId, update.replaceIds, update.replaceSourceRowIds ?? [], internalId, changed, removed, existing.slice(1).map(row => row.id));
        changed.add(internalId);
    }
    for (const message of messages) {
        const source = message.meta?.nativeRow;
        if (!source || (message.role !== 'user' && message.role !== 'agent')) continue;
        if (state.nativeRetiredRowIds.has(source.id)) {
            const canonical = state.nativeRowIds.get(source.id); if (canonical) state.messageIds.set(message.id, canonical);
            continue;
        }
        const fragments = state.nativeTextFragments.get(source.id) ?? new Map<string, NormalizedMessage>();
        fragments.set(message.id, message); state.nativeTextFragments.set(source.id, fragments);
    }
    for (const [sourceId, fragments] of state.nativeTextFragments) {
        const internalId = state.nativeRowIds.get(sourceId) ?? `native:${sourceId}`;
        for (const [wireId, message] of [...fragments].sort((a, b) => a[1].meta!.nativeRow!.offset - b[1].meta!.nativeRow!.offset)) {
            const source = message.meta!.nativeRow!, first = state.messages.get(internalId);
            const part = message.role === 'user' ? message.content.text : message.role === 'agent' ? message.content[0] : null;
            const thinking = typeof part === 'object' && part?.type === 'thinking';
            const text = typeof part === 'string' ? part : part?.type === 'text' ? part.text : thinking ? part.thinking : null;
            if (text === null) { fragments.delete(wireId); continue; }
            const revision = state.nativeRevisions.get(sourceId) ?? 0;
            if (source.revision > revision) continue; // A missing correction must arrive before its suffix.
            state.nativeRowIds.set(sourceId, internalId);
            state.messageIds.set(wireId, internalId);
            if (source.revision < revision) { fragments.delete(wireId); continue; }
            const previous = first?.isThinking && first.text ? first.text.slice(1, -1) : first?.text ?? '';
            if (source.offset > previous.length) continue;
            if (source.offset < previous.length) {
                if (previous.slice(source.offset, source.offset + text.length) === text) fragments.delete(wireId);
                continue;
            }
            // suffix 只追加到原 row；重连、重复片段和完整快照不能再创建一个消息气泡。
            const combined = previous + text;
            state.messages.set(internalId, { ...first, id: internalId, realID: wireId, role: message.role === 'user' ? 'user' : 'agent',
                createdAt: first?.createdAt ?? message.createdAt, text: thinking ? `*${combined}*` : combined, isThinking: thinking,
                tool: null, event: null, meta: { ...message.meta, ...first?.meta }, turn: message.turn });
            changed.add(internalId); fragments.delete(wireId);
        }
        if (!fragments.size) state.nativeTextFragments.delete(sourceId);
    }
    return { removed, messages: messages.filter(m => !(m.role === 'event' && m.content.type === 'native-row-upsert') && !m.meta?.nativeRow) };
}

export function applyNativeToolUpdates(state: ReducerState, changed: Set<string>) {
    for (const [callId, output] of state.nativeToolUpdates) {
        const id = state.toolIdToMessageId.get(callId);
        const row = id ? state.messages.get(id) : undefined;
        if (!row?.tool) continue;
        // 中途结果只更新 running 工具；旧进度永远不能覆盖原 owner 的终态。
        if (row.tool.state === 'running' && row.tool.result !== output) { row.tool.result = output; changed.add(row.id); }
        state.nativeToolUpdates.delete(callId);
    }
}
