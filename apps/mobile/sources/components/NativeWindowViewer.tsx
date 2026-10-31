import * as React from 'react';
import { useSession } from '@/sync/storage';
import { runNoninvasiveRpc } from '@/sync/noninvasiveRpc';
import { AttachmentImagePreview } from './AttachmentImagePreview';
import { t } from '@/text';

export function NativeWindowViewer({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
    const session = useSession(sessionId);
    const frame = session?.agentState?.windowObservation;
    const [busy, setBusy] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const stamp = frame?.captureStamp;
    const bounds = frame?.bounds;
    const controllable = session?.metadata?.bridge?.sourceStatus === 'connected' && frame?.coordinateControlAvailable === true && !!stamp;
    const point = React.useCallback(async (x: number, y: number) => {
        if (!controllable || busy || !bounds || !stamp) return;
        setBusy(true); setFailed(false);
        try {
            // 操作绑定到当前已显示 ref 的 stamp；Mac 再验证窗口代际，不拿最新坐标代替所见图像。
            await runNoninvasiveRpc(sessionId, 'window-control', { action: 'click', payload: { captureStamp: stamp,
                runtimeGeneration: stamp.runtimeGeneration ?? frame.runtimeGeneration, windowGeneration: stamp.windowGeneration ?? frame.windowGeneration,
                x: x * bounds.width, y: y * bounds.height } });
        } catch { setFailed(true); }
        finally { setBusy(false); }
    }, [sessionId, controllable, busy, bounds, stamp, frame]);
    return <AttachmentImagePreview sessionId={sessionId} refValue={frame?.imageRef ?? ''} name={session?.metadata?.summary?.text ?? t('windowControl.sharedWindow')}
        width={bounds?.width} height={bounds?.height} live onClose={onClose} onPoint={controllable ? point : undefined} interactionEnabled={!busy}
        statusText={failed ? t('windowControl.unconfirmed') : busy ? t('common.loading') : undefined} />;
}
