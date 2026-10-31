import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';
import { rigMetadataFixture } from './__testdata__/rigMetadata';
import { getNoninvasiveTurnId, isNoninvasiveBridge, canSendToNoninvasiveSource } from './noninvasiveBridge';
import { isRigMetadataV1, isRigModelSelectionEnabled, isRigPermissionSelectionEnabled, rigCanAbort, rigCanUseShell, rigSendsMessageReceipts } from './rig';
import { resolveMessageModeMeta, resolveMessageDeliveryMeta } from './messageMeta';
import { getSessionForkSource } from '@/utils/sessionFork';

const metadata = MetadataSchema.parse({
    ...rigMetadataFixture,
    client: { id: 'noninvasive-bridge', name: 'Codex Desktop', version: '1' },
    capabilities: { ...rigMetadataFixture.capabilities, messageReceipts: true, modelSelection: false, permissionModeSelection: false, shell: false, resume: false },
    bridge: { version: 1, source: { app: 'codex', id: 'native-fixture', hostId: 'local', runtimeGeneration: 'native-runtime', windowGeneration: null }, currentTurnId: 'native-current-turn', controlMode: 'session', sourceStatus: 'connected' },
});

describe('non-invasive desktop source capability seam', () => {
    it('requires a truly connected session runtime before allowing submit, independent of machine/HTTP liveness', () => {
        const connected = { ...metadata, capabilities: { ...metadata.capabilities!, steering: true } };
        expect(canSendToNoninvasiveSource(connected)).toBe(true);
        expect(canSendToNoninvasiveSource({ ...connected, bridge: { ...metadata.bridge!, sourceStatus: 'owner-unavailable' } })).toBe(false);
        expect(canSendToNoninvasiveSource({ ...connected, bridge: { ...metadata.bridge!, source: { ...metadata.bridge!.source, runtimeGeneration: null } } })).toBe(false);
        expect(canSendToNoninvasiveSource({ ...connected, bridge: { ...metadata.bridge!, controlMode: 'window' } })).toBe(false);
        expect(canSendToNoninvasiveSource({ ...connected, capabilities: { ...connected.capabilities, steering: false } })).toBe(false);
    });
    it('requires native receipts even for a descriptor or an older false online capability', () => {
        const descriptor = { ...metadata, capabilities: { ...metadata.capabilities!, messageReceipts: false }, bridge: { ...metadata.bridge!, sourceStatus: 'owner-unavailable' as const } };
        expect(rigSendsMessageReceipts(descriptor)).toBe(true);
        expect(resolveMessageDeliveryMeta({ metadata: descriptor, thinking: false, agentState: null })).toMatchObject({ expectsAcceptance: true });
    });
    it('keeps real connector identity while applying native Happy capability UI', () => {
        expect(isNoninvasiveBridge(metadata)).toBe(true);
        expect(isRigMetadataV1(metadata)).toBe(true);
        expect(rigSendsMessageReceipts(metadata)).toBe(true);
        expect(isRigModelSelectionEnabled(metadata)).toBe(false);
        expect(isRigPermissionSelectionEnabled(metadata)).toBe(false);
        expect(rigCanUseShell(metadata)).toBe(false);
    });
    it('requires a connected original foreground turn for abort', () => {
        expect(getNoninvasiveTurnId(metadata)).toBe('native-current-turn');
        expect(rigCanAbort(metadata)).toBe(true);
        expect(rigCanAbort({ ...metadata, bridge: { ...metadata.bridge!, currentTurnId: null } })).toBe(false);
        expect(rigCanAbort({ ...metadata, bridge: { ...metadata.bridge!, sourceStatus: 'disconnected' } })).toBe(false);
    });
    it('never offers a runner-backed native source fork', () => {
        expect(getSessionForkSource({ id: 'happy-fixture', metadata: { ...metadata, machineId: 'fixture-machine', codexThreadId: 'native-fixture' } } as Parameters<typeof getSessionForkSource>[0])).toBe(null);
    });
    it('does not forward local mode overrides or claim native busy queueing', () => {
        expect(resolveMessageModeMeta({ metadata, permissionMode: 'bypassPermissions', modelMode: 'other:model', effortLevel: 'high', serviceTier: 'fast' })).toEqual({});
        expect(resolveMessageDeliveryMeta({ metadata, thinking: true, agentState: null })).toEqual({ expectsAcceptance: true, queuedWhileBusy: false });
    });
    it('keeps original address separate from the Happy record', () => {
        expect(metadata.bridge?.source.id).toBe('native-fixture');
        expect(NonNativeParse({ ...metadata, bridge: { ...metadata.bridge!, version: 2 } })).toBe(false);
    });
});
function NonNativeParse(value: unknown) { return MetadataSchema.safeParse(value).success; }
