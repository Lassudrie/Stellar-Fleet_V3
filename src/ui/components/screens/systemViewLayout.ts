import { Fleet, StarSystem } from '../../../shared/shared';
import { sorted } from '../../../shared/shared';
import { isFleetWithinOrbitProximity } from '../../../engine/orbit';

export type SystemObjectKind = 'body' | 'fleet' | 'station' | 'ship';
export type SystemObjectId = `${SystemObjectKind}:${string}`;

export const makeObjectId = (kind: SystemObjectKind, id: string): SystemObjectId => `${kind}:${id}`;

export const parseObjectId = (value: string | null | undefined): { kind: SystemObjectKind; id: string } | null => {
  if (!value) return null;
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
  const kind = value.slice(0, separatorIndex) as SystemObjectKind;
  const id = value.slice(separatorIndex + 1);
  if (!id) return null;
  if (!['body', 'fleet', 'station', 'ship'].includes(kind)) return null;
  return { kind, id };
};

const compareIds = <T extends { id: string }>(a: T, b: T): number =>
  a.id.localeCompare(b.id, 'en', { sensitivity: 'base' });

export const hashStringToUnit = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0) / 0xffffffff;
};

export const hashStringToAngle = (value: string): number => hashStringToUnit(value) * Math.PI * 2;

export type TacticalRingConfig = {
  baseRadius: number;
  ringSpacing: number;
  maxPerRing: number;
  yOffset?: number;
  rotationSpeed?: number;
};

export type TacticalPosition<T extends { id: string }> = {
  entity: T;
  position: [number, number, number];
  ringIndex: number;
  angle: number;
  radius: number;
};

export const layoutTacticalRing = <T extends { id: string }>(
  entities: readonly T[],
  config: TacticalRingConfig,
  day = 0
): TacticalPosition<T>[] => {
  const ordered = sorted(entities, compareIds);
  const ringCapacity = Math.max(1, Math.floor(config.maxPerRing));
  const ringSpacing = Math.max(config.ringSpacing, 0);
  const yOffset = config.yOffset ?? 0;
  const rotationSpeed = config.rotationSpeed ?? 0;

  return ordered.map((entity, index) => {
    const ringIndex = Math.floor(index / ringCapacity);
    const radius = config.baseRadius + ringIndex * ringSpacing;
    const angle = hashStringToAngle(entity.id) + day * rotationSpeed;
    const position: [number, number, number] = [
      Math.cos(angle) * radius,
      yOffset,
      Math.sin(angle) * radius
    ];
    return {
      entity,
      position,
      ringIndex,
      angle,
      radius
    };
  });
};

export const getSystemFleets = (system: StarSystem, fleets: Fleet[]): Fleet[] => {
  const inRange = fleets.filter((fleet) => isFleetWithinOrbitProximity(fleet, system));
  return sorted(inRange, compareIds);
};
