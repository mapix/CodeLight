export type PreviewGeometry = { centerX: number; centerY: number; imageWidth: number; imageHeight: number; scale: number; x: number; y: number };

/** 放大/平移只是手机视图变换；逆变换回所见原图，越界永不发送到桌面。 */
export function previewImagePoint(screenX: number, screenY: number, geometry: PreviewGeometry): { x: number; y: number } | null {
    'worklet';
    const { centerX, centerY, imageWidth, imageHeight, scale, x, y } = geometry;
    if (![screenX, screenY, centerX, centerY, imageWidth, imageHeight, scale, x, y].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0 || scale < 1) return null;
    const imageX = (screenX - centerX - x) / scale + imageWidth / 2;
    const imageY = (screenY - centerY - y) / scale + imageHeight / 2;
    if (imageX < 0 || imageY < 0 || imageX >= imageWidth || imageY >= imageHeight) return null;
    return { x: imageX / imageWidth, y: imageY / imageHeight };
}
