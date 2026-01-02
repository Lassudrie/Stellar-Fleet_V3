import type { Army, FactionId, GameState, HexCoord } from '../../shared/types';
import { generateSurfaceMapForState } from '../planetSurface/access';
import { neighborsAxial } from '../planetSurface/hex';

export interface ZocSnapshot {
  bodyId: string;
  w: number;
  h: number;
  wrapX: boolean;
  zocByFactionId: Map<FactionId, Uint8Array>;
}

export const computeZocSnapshotFromArmies = (params: {
  bodyId: string;
  w: number;
  h: number;
  wrapX: boolean;
  armies: Army[];
}): ZocSnapshot => {
  const { bodyId, w, h, wrapX, armies } = params;
  const size = w * h;
  const zocByFactionId = new Map<FactionId, Uint8Array>();

  const getArr = (factionId: FactionId): Uint8Array => {
    const existing = zocByFactionId.get(factionId);
    if (existing) return existing;
    const arr = new Uint8Array(size);
    zocByFactionId.set(factionId, arr);
    return arr;
  };

  armies.forEach(army => {
    if (army.state !== 'DEPLOYED') return;
    if (army.containerId !== bodyId) return;
    if (!army.surfacePos) return;
    if (army.members <= 0) return;
    if (army.condition < 0.3) return;
    const q = army.surfacePos.q;
    const r = army.surfacePos.r;
    if (q < 0 || q >= w || r < 0 || r >= h) return;
    const arr = getArr(army.factionId);
    const ns = neighborsAxial({ q, r }, w, h, wrapX);
    for (const n of ns) {
      arr[n.r * w + n.q] = 1;
    }
  });

  return { bodyId, w, h, wrapX, zocByFactionId };
};

export const computeZocSnapshotForBody = (
  state: GameState,
  bodyId: string,
  armies: Army[]
): ZocSnapshot | null => {
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;
  const { w, h, wrapX } = map.descriptor.config;
  return computeZocSnapshotFromArmies({ bodyId, w, h, wrapX, armies });
};

export const isInEnemyZoc = (
  snapshot: ZocSnapshot,
  coord: HexCoord,
  ownFactionId: FactionId
): boolean => {
  const idx = coord.r * snapshot.w + coord.q;
  for (const [factionId, arr] of snapshot.zocByFactionId.entries()) {
    if (factionId === ownFactionId) continue;
    if (arr[idx]) return true;
  }
  return false;
};

