import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@/sync/storageTypes';
import type { EffortLevel, ModelMode } from '@/components/modelModeOptions';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';
import { recoverCodeLightModelRpc, runCodeLightModelRpc } from '@/sync/noninvasiveRpc';
import { apiSocket } from '@/sync/apiSocket';
import { t } from '@/text';

export function useCodeLightModelControls(session: Session | null) {
    const native = isNoninvasiveBridge(session?.metadata), controls = session?.metadata?.nativeControls?.model;
    const id = session?.id, canRead = session?.metadata?.capabilities?.rpcMethods?.includes('codex-controls-read') === true;
    const [status, setStatus] = useState<'idle' | 'saving' | 'error' | 'unknown'>('idle');
    const refresh = useCallback(async () => {
        if (!id || !canRead) return;
        const result = await apiSocket.sessionRPC<{ error?: { code?: string } }, unknown>(id, 'codex-controls-read', {});
        if (result?.error) throw Error(result.error.code ?? 'controls-unavailable');
        if (await recoverCodeLightModelRpc(id)) setStatus('idle');
    }, [id, canRead]);
    useEffect(() => {
        if (native && canRead && !controls) void refresh().catch(() => setStatus('error'));
    }, [native, canRead, controls, refresh]);
    const models: ModelMode[] = useMemo(() => (controls?.models ?? []).map(model => ({ key: model.id, modelId: model.id, name: model.label,
        thinkingLevels: model.reasoningEfforts, defaultThinkingLevel: model.defaultReasoningEffort })), [controls]);
    const current = controls?.current;
    const currentModel = current ? models.find(model => model.key === current.model) ?? { key: current.model, name: current.model } : null;
    const currentEntry = controls?.models.find(model => model.id === current?.model);
    const efforts: EffortLevel[] = useMemo(() => currentEntry ? [{ key: '__default__', name: t('codeLightModels.default') }, ...currentEntry.reasoningEfforts.map(key => ({ key, name: key.charAt(0).toUpperCase() + key.slice(1) }))] : [], [currentEntry]);
    const enabled = native && controls?.available === true && !!current && status !== 'saving' && status !== 'unknown';
    const change = useCallback(async (model: string, reasoningEffort: string | null) => {
        if (!id || !current || !enabled) return;
        setStatus('saving');
        try {
            // 期望值来自用户看到的原 owner 设置；桌面并发修改时拒绝覆盖，不能仅更新手机本地模式。
            await runCodeLightModelRpc(id, { model, reasoningEffort, expectedModel: current.model, expectedReasoningEffort: current.reasoningEffort });
            setStatus('idle');
        } catch (error) {
            setStatus(error instanceof Error && /unconfirmed|did not respond/i.test(error.message) ? 'unknown' : 'error');
            void refresh().catch(() => {});
        }
    }, [id, current, enabled, refresh]);
    const selectModel = useCallback((model: ModelMode) => {
        const entry = controls?.models.find(candidate => candidate.id === model.key);
        if (!entry) return;
        const effort = current?.reasoningEffort === null ? null : current?.reasoningEffort && entry.reasoningEfforts.includes(current.reasoningEffort) ? current.reasoningEffort : entry.defaultReasoningEffort ?? null;
        void change(entry.id, effort);
    }, [controls, current, change]);
    const selectEffort = useCallback((effort: EffortLevel) => { if (current && efforts.some(e => e.key === effort.key)) void change(current.model, effort.key === '__default__' ? null : effort.key); }, [current, efforts, change]);
    return { native, enabled, models, currentModel, efforts, currentEffort: efforts.find(e => e.key === (current?.reasoningEffort ?? '__default__')) ?? null,
        selectModel, selectEffort, refresh, status, message: status === 'saving' ? t('codeLightModels.saving') : status === 'unknown' ? t('codeLightModels.unconfirmed') : status === 'error' ? t('codeLightModels.failed') : null };
}
