import React, { useMemo, useLayoutEffect, useRef } from 'react';
import { BufferGeometry, BufferAttribute, Color, Vector3 } from 'three';
import { Vec3 } from '../engine/math/vec3';

export interface LineDef {
    id: string;
    start: Vec3;
    end: Vec3;
    color: string;
    dashed?: boolean;
}

interface BatchedLinesProps {
    lines: LineDef[];
}

const BatchedLines: React.FC<BatchedLinesProps> = ({ lines }) => {
    const solidLines = useMemo(() => lines.filter(l => !l.dashed), [lines]);
    const dashedLines = useMemo(() => lines.filter(l => l.dashed), [lines]);

    return (
        <group>
            {solidLines.length > 0 && <LineBatch lines={solidLines} dashed={false} />}
            {dashedLines.length > 0 && <LineBatch lines={dashedLines} dashed={true} />}
        </group>
    );
};

const LineBatch: React.FC<{ lines: LineDef[]; dashed: boolean }> = ({ lines, dashed }) => {
    const geometry = useMemo(() => {
        const geo = new BufferGeometry();
        // Initial allocation (can resize if needed, but here we re-create if lines change length)
        return geo;
    }, []); // We actually want to reuse geometry instance if possible, but React might unmount

    // We need to manage attributes manually
    useLayoutEffect(() => {
        const count = lines.length;
        const positions = new Float32Array(count * 2 * 3); // 2 vertices * 3 coords
        const colors = new Float32Array(count * 2 * 3);    // 2 vertices * 3 coords

        const _color = new Color();

        lines.forEach((line, i) => {
            const idx = i * 6; // 6 floats per line

            // Start
            positions[idx] = line.start.x;
            positions[idx + 1] = line.start.y;
            positions[idx + 2] = line.start.z;

            // End
            positions[idx + 3] = line.end.x;
            positions[idx + 4] = line.end.y;
            positions[idx + 5] = line.end.z;

            // Color
            _color.set(line.color);

            // Start Color
            colors[idx] = _color.r;
            colors[idx + 1] = _color.g;
            colors[idx + 2] = _color.b;

            // End Color
            colors[idx + 3] = _color.r;
            colors[idx + 4] = _color.g;
            colors[idx + 5] = _color.b;
        });

        geometry.setAttribute('position', new BufferAttribute(positions, 3));
        geometry.setAttribute('color', new BufferAttribute(colors, 3));

        geometry.computeBoundingSphere();

        // computeLineDistances() is not on BufferGeometry in standard TS definition
        // without augmenting or casting, though it exists in Three.js runtime for Line geometries.
        // LineSegments geometry needs it for dashed material.
        if (dashed) {
            // @ts-ignore
            if (geometry.computeLineDistances) {
                // @ts-ignore
                geometry.computeLineDistances();
            } else {
                // Manually compute distances for LineSegments if method missing
                const dists = new Float32Array(count * 2);
                for(let i=0; i<count; i++) {
                    // LineSegments: each pair is independent.
                    // Start distance 0, End distance length.
                    const idx = i * 6;
                    const x1 = positions[idx], y1 = positions[idx+1], z1 = positions[idx+2];
                    const x2 = positions[idx+3], y2 = positions[idx+4], z2 = positions[idx+5];
                    const d = Math.sqrt((x2-x1)**2 + (y2-y1)**2 + (z2-z1)**2);
                    dists[i*2] = 0;
                    dists[i*2+1] = d;
                }
                geometry.setAttribute('lineDistance', new BufferAttribute(dists, 1));
            }
        }

    }, [lines, geometry, dashed]);

    return (
        <lineSegments geometry={geometry}>
            {dashed ? (
                <lineDashedMaterial
                    vertexColors
                    dashSize={1.5}
                    gapSize={1.0}
                    transparent
                    opacity={0.6}
                />
            ) : (
                <lineBasicMaterial
                    vertexColors
                    transparent
                    opacity={0.6}
                    linewidth={1}
                />
            )}
        </lineSegments>
    );
};

export default BatchedLines;
