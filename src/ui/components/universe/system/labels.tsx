import React, { useMemo, useRef } from 'react';
import { Billboard, Text } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { Camera, Group, MathUtils, Mesh, Vector3 } from 'three';
import { applyMaterialOpacity } from './renderUtils';

const LABEL_RENDER_ORDER = 10;
const LABEL_NEAR_FADE_START_PLANET = 9;
const LABEL_NEAR_FADE_END_PLANET = 4.5;
const LABEL_NEAR_FADE_START_MOON = 8;
const LABEL_NEAR_FADE_END_MOON = 4;

export type BodyLabelTarget = {
  id: string;
  name: string;
  position: [number, number, number];
  radius: number;
  kind: 'planet' | 'moon';
  parent?: {
    position: [number, number, number];
    radius: number;
  };
};

type BodyLabelEvaluation = {
  visible: boolean;
  scale: number;
  opacity: number;
};

type LabelComputationScratch = {
  worldPosition: Vector3;
  projectedPosition: Vector3;
  parentWorldPosition: Vector3;
  parentProjectedPosition: Vector3;
};

const createBodyLabelState = (
  target: BodyLabelTarget,
  camera: Camera,
  baseScale: number,
  labelOffset: number,
  scratch: LabelComputationScratch
): BodyLabelEvaluation => {
  const { worldPosition, projectedPosition, parentWorldPosition, parentProjectedPosition } = scratch;
  worldPosition.set(...target.position);
  worldPosition.y += labelOffset;
  projectedPosition.copy(worldPosition).project(camera);

  const isOnScreen = projectedPosition.z > -1 && projectedPosition.z < 1
    && Math.abs(projectedPosition.x) <= 1.02
    && Math.abs(projectedPosition.y) <= 1.02;

  if (!isOnScreen) {
    return {
      visible: false,
      scale: 1,
      opacity: 0
    };
  }

  const distance = camera.position.distanceTo(worldPosition);
  const targetMinScale = baseScale * 0.32;
  const targetMaxScale = baseScale * (target.kind === 'planet' ? 1.6 : 1.25);
  const angularScale = MathUtils.clamp((target.radius * 8) / Math.max(distance, 0.001), targetMinScale, targetMaxScale);
  const fadeStart = Math.max(target.radius * (target.kind === 'planet' ? 28 : 22), baseScale * 5);
  const fadeEnd = fadeStart * 1.9;
  const distanceFade = MathUtils.clamp(1 - (distance - fadeStart) / (fadeEnd - fadeStart), 0, 1);
  const nearFadeStart = target.radius * (target.kind === 'planet' ? LABEL_NEAR_FADE_START_PLANET : LABEL_NEAR_FADE_START_MOON);
  const nearFadeEnd = target.radius * (target.kind === 'planet' ? LABEL_NEAR_FADE_END_PLANET : LABEL_NEAR_FADE_END_MOON);
  const nearFade = MathUtils.clamp(
    (distance - nearFadeEnd) / Math.max(nearFadeStart - nearFadeEnd, 0.001),
    0,
    1
  );
  let opacity = distanceFade * nearFade;

  if (target.parent) {
    parentWorldPosition.set(...target.parent.position);
    parentProjectedPosition.copy(parentWorldPosition).project(camera);
    const screenDistance = projectedPosition.distanceTo(parentProjectedPosition);
    const overlapThreshold = 0.18;
    const overlapFactor = MathUtils.clamp(screenDistance / overlapThreshold, 0, 1);
    opacity *= MathUtils.lerp(0.35, 1, overlapFactor);
  }

  return {
    visible: true,
    scale: angularScale,
    opacity
  };
};

interface BodyLabelProps {
  target: BodyLabelTarget;
  baseScale: number;
  color?: string;
}

const BodyLabel: React.FC<BodyLabelProps> = ({ target, baseScale, color = '#ffffff' }) => {
  const { camera } = useThree();
  const groupRef = useRef<Group | null>(null);
  const textRef = useRef<Mesh | null>(null);
  const scratch = useMemo<LabelComputationScratch>(() => ({
    worldPosition: new Vector3(),
    projectedPosition: new Vector3(),
    parentWorldPosition: new Vector3(),
    parentProjectedPosition: new Vector3()
  }), []);
  const labelOffset = useMemo(
    () => Math.max(target.radius * 1.25, baseScale * 0.22),
    [baseScale, target.radius]
  );
  const fontSize = useMemo(
    () => MathUtils.clamp(target.radius * 0.7, baseScale * 0.32, baseScale * 1.25),
    [baseScale, target.radius]
  );

  useFrame(() => {
    const group = groupRef.current;
    const text = textRef.current;
    if (!group || !text) return;

    const { visible, scale, opacity } = createBodyLabelState(target, camera, baseScale, labelOffset, scratch);
    group.visible = visible;
    if (!visible) return;

    group.scale.setScalar(scale);
    applyMaterialOpacity(text.material, opacity);
  });

  return (
    <group ref={groupRef} position={target.position}>
      <Billboard position={[0, labelOffset, 0]} frustumCulled={false}>
        <Text
          ref={textRef}
          renderOrder={LABEL_RENDER_ORDER}
          fontSize={fontSize}
          color={color}
          outlineWidth={fontSize * 0.16}
          outlineColor="#0f172a"
          outlineOpacity={0.85}
          maxWidth={14}
          anchorX="center"
          anchorY="bottom"
        >
          {target.name}
        </Text>
      </Billboard>
    </group>
  );
};

interface SystemBodyLabelsProps {
  labels: BodyLabelTarget[];
  baseScale: number;
}

export const SystemBodyLabels: React.FC<SystemBodyLabelsProps> = ({ labels, baseScale }) => {
  if (!labels.length) return null;
  return (
    <group name="SystemBodyLabels">
      {labels.map((label) => (
        <BodyLabel key={label.id} target={label} baseScale={baseScale} />
      ))}
    </group>
  );
};
