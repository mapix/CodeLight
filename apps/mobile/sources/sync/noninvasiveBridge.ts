import { z } from 'zod';
import type { Metadata } from './storageTypes';

export const NONINVASIVE_BRIDGE_CLIENT_ID = 'noninvasive-bridge';

export const NoninvasiveBridgeSchema = z.object({
    version: z.literal(1),
    source: z.object({
        app: z.enum(['codex', 'zcode', 'claude-desktop', 'cursor', 'antigravity', 'windsurf', 'vscode', 'zed', 'trae', 'terminal', 'iterm', 'warp']),
        id: z.string().min(1),
        hostId: z.string().min(1),
        runtimeGeneration: z.string().nullable(),
        windowGeneration: z.string().nullable(),
    }).passthrough(),
    currentTurnId: z.string().nullable(),
    controlMode: z.enum(['session', 'window']),
    sourceStatus: z.enum(['connected', 'owner-unavailable', 'locked', 'permission-required', 'disconnected']),
}).passthrough();

export function isNoninvasiveBridge(metadata: Metadata | null | undefined): boolean {
    return metadata?.client?.id === NONINVASIVE_BRIDGE_CLIENT_ID;
}

export function canSendToNoninvasiveSource(metadata: Metadata | null | undefined): boolean {
    if (!isNoninvasiveBridge(metadata)) return true;
    const bridge = metadata?.bridge;
    return bridge?.controlMode === 'session' && bridge.sourceStatus === 'connected'
        && typeof bridge.source.runtimeGeneration === 'string' && bridge.source.runtimeGeneration.trim().length > 0
        && metadata?.capabilities?.steering === true;
}

export function getNoninvasiveTurnId(metadata: Metadata | null | undefined): string | null {
    if (!isNoninvasiveBridge(metadata) || metadata?.bridge?.sourceStatus !== 'connected') return null;
    const turnId = metadata.bridge.currentTurnId;
    return typeof turnId === 'string' && turnId.trim() ? turnId : null;
}
