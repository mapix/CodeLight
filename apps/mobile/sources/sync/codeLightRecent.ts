import type { Session } from './storageTypes';
import type { NormalizedMessage } from './typesRaw';

export interface PeerSessionDescriptor {
    id: string;
    nativeUpdatedAt: number;
    basicOnly: boolean;
    metadata: Session['metadata'];
    metadataVersion: number;
    agentState: Session['agentState'];
    agentStateVersion: number;
    seq: number;
    createdAt: number;
    active: boolean;
    activeAt: number;
    sessionKey?: string;
}
export interface NativeRecentRow {
    id: string;
    role: 'user' | 'assistant' | 'reasoning' | 'tool';
    turnId: string;
    text: string;
    at: number | null;
    order?: number;
    projectionRevision: number;
    snapshotRevision: number;
    streamRevision: number;
    ownerGeneration: string | null;
    replaceIds: string[];
    replaceSourceRowIds?: string[];
    tools?: { id: string; name: string; output: string; status: string }[];
}
export interface PeerRecentWindow {
    version: 1;
    session: PeerSessionDescriptor;
    rows: NativeRecentRow[];
    nextCursor: string | null;
    hasMore: boolean;
    ownerGeneration: string | null;
    revision: number | null;
    status: string;
    currentTurnId: string | null;
    seq: number;
    observedAt: number;
}

/** Peer-sealed catalog fields stay light; runtime activity never comes from recency. */
export function peerDescriptorSession(value: PeerSessionDescriptor, previous?: Session): Session {
    if (!value || typeof value.id !== 'string' || !value.id || !Number.isFinite(value.nativeUpdatedAt) || !value.metadata
        || ![value.metadataVersion, value.agentStateVersion, value.seq].every(number => Number.isSafeInteger(number) && number >= 0)
        || ![value.createdAt, value.activeAt].every(number => Number.isFinite(number) && number >= 0)) throw Error('Invalid native session descriptor');
    const metadataAhead = previous && previous.metadataVersion > value.metadataVersion;
    const stateAhead = previous && previous.agentStateVersion > value.agentStateVersion;
    const metadata = metadataAhead ? previous.metadata : value.basicOnly && previous?.metadata ? { ...previous.metadata, ...value.metadata } : value.metadata;
    return { ...previous, id: value.id, createdAt: value.createdAt, updatedAt: value.nativeUpdatedAt,
        seq: Math.max(value.seq, previous?.seq ?? 0), active: value.active === true, activeAt: value.activeAt, presence: value.active ? 'online' : value.activeAt,
        metadata, metadataVersion: metadataAhead ? previous.metadataVersion : value.metadataVersion,
        agentState: value.basicOnly || stateAhead ? previous?.agentState ?? null : value.agentState,
        agentStateVersion: value.basicOnly || stateAhead ? previous?.agentStateVersion ?? 0 : value.agentStateVersion,
        thinking: previous?.thinking ?? false, thinkingAt: previous?.thinkingAt ?? 0 };
}

export function isCurrentNativeRecent(window: PeerRecentWindow, session: Session): boolean {
    const currentOwner = session.metadata?.bridge?.source.runtimeGeneration;
    return !(session.metadataVersion > window.session.metadataVersion && currentOwner && window.ownerGeneration && currentOwner !== window.ownerGeneration);
}

/** Each recent native row can render without earlier wire text/tool seeds. */
export function nativeRecentMessages(window: PeerRecentWindow): NormalizedMessage[] {
    if (window.version !== 1 || !Array.isArray(window.rows) || window.rows.length > 100) throw Error('Invalid native recent window');
    const messages: NormalizedMessage[] = [];
    for (const row of window.rows) {
        if (!row || typeof row.id !== 'string' || !row.id || !row.turnId || !Number.isSafeInteger(row.projectionRevision) || row.projectionRevision < 1
            || !Number.isSafeInteger(row.snapshotRevision) || row.snapshotRevision < 1 || !Number.isSafeInteger(row.streamRevision) || row.streamRevision < 0
            || typeof row.text !== 'string' || !Array.isArray(row.replaceIds) || !row.replaceIds.every(id => typeof id === 'string')) throw Error('Invalid native recent row');
        // 原 owner 的时间未知时保留索引时间；observedAt 只描述新鲜度，不能伪装成原消息的发送时间。
        const createdAt = Number.isFinite(row.at) && row.at !== null ? row.at : window.session.nativeUpdatedAt;
        const meta = { sentFrom: 'noninvasive-observer', ...(Number.isSafeInteger(row.order) ? { nativeOrder: row.order } : {}) };
        const common = { localId: null, createdAt, isSidechain: false, turn: row.turnId, meta };
        if (row.role === 'tool') {
            messages.push({ ...common, id: `recent-tool:${row.id}:${row.ownerGeneration}:${row.snapshotRevision}`, role: 'event', content: { type: 'native-row-upsert', sourceRowId: row.id, role: 'tool', text: '',
                revision: row.projectionRevision, replaceIds: [], tools: row.tools ?? [], snapshotRevision: row.snapshotRevision, streamRevision: row.streamRevision, ownerGeneration: row.ownerGeneration ?? undefined } });
        } else {
            messages.push({ ...common, id: `recent-row:${row.id}:${row.ownerGeneration}:${row.snapshotRevision}`, role: 'event', content: { type: 'native-row-upsert', sourceRowId: row.id, role: row.role,
                text: row.text, revision: row.projectionRevision, replaceIds: row.replaceIds, ...(row.replaceSourceRowIds ? { replaceSourceRowIds: row.replaceSourceRowIds } : {}), snapshotRevision: row.snapshotRevision, streamRevision: row.streamRevision, ownerGeneration: row.ownerGeneration ?? undefined } });
        }
    }
    return messages;
}
