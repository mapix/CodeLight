import type { NormalizedMessage } from '../typesRaw';
import type { ReducerState } from './reducer';

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
                if ((state.nativeRevisions.get(key) ?? 0) >= update.revision) continue;
                state.nativeRevisions.set(key, update.revision);
                state.nativeToolUpdates.set(tool.id, tool.output);
            }
            continue;
        }
        if ((state.nativeRevisions.get(update.sourceRowId) ?? 0) >= update.revision) continue;
        state.nativeRevisions.set(update.sourceRowId, update.revision);
        const replaced = new Set(update.replaceIds);
        const existing = [...state.messages.values()].filter(row => row.realID && replaced.has(row.realID) && !row.tool);
        const first = existing.sort((a, b) => a.createdAt - b.createdAt)[0];
        const internalId = first?.id ?? `native:${message.id}`;
        // 保存被替换 wire id：历史分页和重新连线不能让旧片段再次出现。
        for (const id of replaced) state.messageIds.set(id, internalId);
        for (const row of existing.slice(1)) { state.messages.delete(row.id); changed.delete(row.id); removed.push(row.id); }
        state.messages.set(internalId, { ...first, id: internalId, realID: message.id,
            role: update.role === 'user' ? 'user' : 'agent', createdAt: first?.createdAt ?? message.createdAt,
            text: update.role === 'reasoning' ? `*${update.text}*` : update.text,
            isThinking: update.role === 'reasoning', event: null, tool: null, meta: message.meta, turn: message.turn });
        state.messageIds.set(message.id, internalId);
        changed.add(internalId);
    }
    return { removed, messages: messages.filter(m => !(m.role === 'event' && m.content.type === 'native-row-upsert')) };
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
