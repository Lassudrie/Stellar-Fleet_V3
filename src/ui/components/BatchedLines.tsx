import React, { useMemo, useLayoutEffect, useRef } from 'react';
import { Color, BufferGeometry, BufferAttribute } from 'three';
import { Vec3 } from '../../engine/math/vec3';

export interface LineData {
  start: Vec3;
  end: Vec3;
  color: string;
}

interface BatchedLinesProps {
  lines: LineData[];
  dashed?: boolean;
}

const MAX_LINES = 1000;

const BatchedLines: React.FC<BatchedLinesProps> = ({ lines, dashed }) => {
  const lineRef = useRef<any>(null);

  const positionArray = useMemo(() => new Float32Array(MAX_LINES * 6), []);
  const colorArray = useMemo(() => new Float32Array(MAX_LINES * 6), []);

  const geometry = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positionArray, 3));
    geo.setAttribute('color', new BufferAttribute(colorArray, 3));
    return geo;
  }, [positionArray, colorArray]);

  useLayoutEffect(() => {
    const count = Math.min(lines.length, MAX_LINES);
    const tempColor = new Color();

    for (let i = 0; i < count; i++) {
        const line = lines[i];
        const i6 = i * 6;

        positionArray[i6] = line.start.x;
        positionArray[i6 + 1] = line.start.y;
        positionArray[i6 + 2] = line.start.z;
        positionArray[i6 + 3] = line.end.x;
        positionArray[i6 + 4] = line.end.y;
        positionArray[i6 + 5] = line.end.z;

        tempColor.set(line.color);
        const r = tempColor.r;
        const g = tempColor.g;
        const b = tempColor.b;

        colorArray[i6] = r;
        colorArray[i6 + 1] = g;
        colorArray[i6 + 2] = b;
        colorArray[i6 + 3] = r;
        colorArray[i6 + 4] = g;
        colorArray[i6 + 5] = b;
    }

    geometry.setDrawRange(0, count * 2);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;

    if (dashed) {
        geometry.computeLineDistances();
    }

  }, [lines, dashed, geometry, positionArray, colorArray]);

  return (
    <lineSegments ref={lineRef} geometry={geometry}>
        {dashed ? (
            <lineDashedMaterial vertexColors dashSize={1.5} gapSize={1.0} transparent opacity={0.6} />
        ) : (
            <lineBasicMaterial vertexColors transparent opacity={0.6} linewidth={1} />
        )}
    </lineSegments>
  );
};

export default BatchedLines;
