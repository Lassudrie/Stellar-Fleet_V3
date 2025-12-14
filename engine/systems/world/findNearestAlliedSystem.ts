import { StarSystem, FactionId } from '../../../types';
import { distSq } from '../../math/vec3';

export function findNearestAlliedSystemExcluding(
  factionId: FactionId,
  excludedSystemId: string,
  systems: StarSystem[]
): StarSystem | null {
  let best: { system: StarSystem; dist: number } | null = null;

  const fromSystem = systems.find(s => s.id === excludedSystemId);
  if (!fromSystem) return null;

  for (const sys of systems) {
    if (sys.id === excludedSystemId) continue;
    if (sys.ownerFactionId !== factionId) continue;

    const dist = distSq(fromSystem.position, sys.position);

    if (!best || dist < best.dist) {
      best = { system: sys, dist };
    }
  }

  return best ? best.system : null;
}
