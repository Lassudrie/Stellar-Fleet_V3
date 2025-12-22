export type AnchorPoint = { x: number; y: number };
export type Size = { width: number; height: number };
export type ViewportRect = { left: number; top: number; width: number; height: number };
export type SafeAreaInsets = { top: number; right: number; bottom: number; left: number };
export type PositioningConstraints = {
    anchor: AnchorPoint;
    menuSize: Size;
    viewport: ViewportRect;
    safeInsets: SafeAreaInsets;
    offset: number;
    padding: number;
};

const clamp = (value: number, min: number, max: number): number => {
    if (min > max) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
};

export const computeConstrainedMenuPosition = ({
    anchor,
    menuSize,
    viewport,
    safeInsets,
    offset,
    padding,
}: PositioningConstraints): AnchorPoint => {
    const viewportRight = viewport.left + viewport.width;
    const viewportBottom = viewport.top + viewport.height;

    const minX = viewport.left + safeInsets.left + padding;
    const minY = viewport.top + safeInsets.top + padding;
    const maxX = viewportRight - safeInsets.right - padding - menuSize.width;
    const maxY = viewportBottom - safeInsets.bottom - padding - menuSize.height;

    let x = anchor.x + offset;
    let y = anchor.y + offset;

    const preferredRight = x + menuSize.width;
    const preferredBottom = y + menuSize.height;

    if (preferredRight > viewportRight - safeInsets.right - padding) {
        x = anchor.x - menuSize.width - offset;
    }

    if (preferredBottom > viewportBottom - safeInsets.bottom - padding) {
        y = anchor.y - menuSize.height - offset;
    }

    return {
        x: clamp(x, minX, maxX),
        y: clamp(y, minY, maxY),
    };
};
