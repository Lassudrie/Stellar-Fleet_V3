import assert from 'node:assert';
import { computeConstrainedMenuPosition, SafeAreaInsets, ViewportRect } from './computeConstrainedMenuPosition';

const viewport: ViewportRect = { left: 0, top: 0, width: 500, height: 500 };
const safe: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const menuSize = { width: 100, height: 100 };
const offset = 10;
const padding = 8;

{
    const position = computeConstrainedMenuPosition({
        anchor: { x: 100, y: 100 },
        menuSize,
        viewport,
        safeInsets: safe,
        offset,
        padding,
    });
    assert.deepStrictEqual(position, { x: 110, y: 110 }, 'Menu should appear bottom-right of anchor when space permits');
}

{
    const position = computeConstrainedMenuPosition({
        anchor: { x: 480, y: 100 },
        menuSize,
        viewport,
        safeInsets: safe,
        offset,
        padding,
    });
    assert.deepStrictEqual(position, { x: 370, y: 110 }, 'Menu should flip to the left when there is no room on the right');
}

{
    const position = computeConstrainedMenuPosition({
        anchor: { x: 100, y: 480 },
        menuSize,
        viewport,
        safeInsets: safe,
        offset,
        padding,
    });
    assert.deepStrictEqual(position, { x: 110, y: 370 }, 'Menu should flip above when there is no room below');
}

{
    const position = computeConstrainedMenuPosition({
        anchor: { x: 490, y: 490 },
        menuSize,
        viewport,
        safeInsets: safe,
        offset,
        padding,
    });
    assert.deepStrictEqual(position, { x: 380, y: 380 }, 'Menu should flip both directions near the bottom-right corner and clamp inside the viewport');
}

{
    const safeInsets: SafeAreaInsets = { top: 20, right: 12, bottom: 16, left: 14 };
    const position = computeConstrainedMenuPosition({
        anchor: { x: 5, y: 5 },
        menuSize,
        viewport,
        safeInsets,
        offset,
        padding,
    });
    const expectedX = viewport.left + safeInsets.left + padding;
    const expectedY = viewport.top + safeInsets.top + padding;
    assert.deepStrictEqual(position, { x: expectedX, y: expectedY }, 'Menu should clamp within safe-area insets');
}

{
    const shortViewport: ViewportRect = { left: 0, top: 0, width: 200, height: 150 };
    const tallMenu = { width: 180, height: 200 };

    const position = computeConstrainedMenuPosition({
        anchor: { x: 50, y: 50 },
        menuSize: tallMenu,
        viewport: shortViewport,
        safeInsets: safe,
        offset,
        padding,
    });

    assert.strictEqual(position.y, padding, 'Menu taller than viewport height should clamp to top with padding');
}

console.log('computeConstrainedMenuPosition tests passed');
