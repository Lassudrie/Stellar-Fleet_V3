import type { GameState, GroundBuilding, SurfacePos } from '../../shared/types';
import { ArmyState } from '../../shared/types';
import { generateSurfaceMapForState } from './access';
import { isBuildable, isInsideGrid, isPassable, relocateSurfacePosDeterministic } from './validation';

const clampInt = (x: number): number => (Number.isFinite(x) ? Math.floor(x) : 0);

const pickInitialArmyPos = (state: GameState, armyId: string, bodyId: string): SurfacePos | null => {
  const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
  if (!descriptor) return null;
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;

  const { w, h, wrapX } = descriptor.config;
  const capital = map.settlements.find(s => s.kind === 'capital')?.coord;
  const origin = capital ? { q: capital.q, r: capital.r } : { q: Math.floor(w / 2), r: Math.floor(h / 2) };

  // Prefer passable tiles near capital/center. Deterministic tie-break by hash.
  const pos = relocateSurfacePosDeterministic({
    state,
    entityId: armyId,
    kind: 'army',
    bodyId,
    origin,
    predicate: (biome) => isPassable(biome)
  });
  return pos;
};

export const normalizeSurfacePositions = (state: GameState): GameState => {
  const descriptors = state.planetSurfaceDescriptorsByBodyId;
  if (!descriptors) return state;

  const groundBuildings = state.groundBuildings ?? [];
  const deployedArmies = state.armies.filter(a => a.state === ArmyState.DEPLOYED);

  if (deployedArmies.length === 0 && groundBuildings.length === 0) return state;

  // Group by bodyId for efficiency.
  const touchedBodyIds = new Set<string>();
  deployedArmies.forEach(a => touchedBodyIds.add(a.containerId));
  groundBuildings.forEach(b => touchedBodyIds.add(b.surfacePos.bodyId));

  let armiesChanged = false;
  let buildingsChanged = false;

  const buildingByTileKey = new Map<string, string>(); // `${bodyId}:${q}:${r}` -> buildingId (kept)
  const nextBuildings: GroundBuilding[] = [];

  // 1) Normalize buildings (valid tile + uniqueness per tile)
  for (const b of groundBuildings) {
    const bodyId = b.surfacePos.bodyId;
    const descriptor = descriptors[bodyId];
    if (!descriptor) continue;

    const q = clampInt(b.surfacePos.q);
    const r = clampInt(b.surfacePos.r);
    const basePos: SurfacePos = { bodyId, q, r };

    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) continue;

    let finalPos = basePos;
    if (!isInsideGrid(finalPos, descriptor)) {
      const relocated = relocateSurfacePosDeterministic({
        state,
        entityId: b.id,
        kind: 'building',
        bodyId,
        origin: { q, r },
        predicate: (biome) => isBuildable(biome),
        isOccupied: (qq, rr) => buildingByTileKey.has(`${bodyId}:${qq}:${rr}`)
      });
      if (!relocated) continue;
      finalPos = relocated;
      buildingsChanged = true;
    }

    const biome = map.tiles[finalPos.r * descriptor.config.w + finalPos.q].biome;
    if (!isBuildable(biome)) {
      const relocated = relocateSurfacePosDeterministic({
        state,
        entityId: b.id,
        kind: 'building',
        bodyId,
        origin: { q: finalPos.q, r: finalPos.r },
        predicate: (b) => isBuildable(b),
        isOccupied: (qq, rr) => buildingByTileKey.has(`${bodyId}:${qq}:${rr}`)
      });
      if (!relocated) continue;
      finalPos = relocated;
      buildingsChanged = true;
    }

    const key = `${bodyId}:${finalPos.q}:${finalPos.r}`;
    const existing = buildingByTileKey.get(key);
    if (existing) {
      // Collision: keep deterministic winner, relocate loser.
      const winner = existing.localeCompare(b.id) <= 0 ? existing : b.id;
      const loser = winner === existing ? b.id : existing;
      if (winner !== existing) {
        // Replace kept building in-place: rebuild map from nextBuildings
        const keptIndex = nextBuildings.findIndex(x => x.id === existing);
        if (keptIndex >= 0) {
          nextBuildings[keptIndex] = { ...b, surfacePos: finalPos };
          buildingsChanged = true;
        }
        buildingByTileKey.set(key, winner);
      }

      if (loser === b.id) {
        const relocated = relocateSurfacePosDeterministic({
          state,
          entityId: b.id,
          kind: 'building',
          bodyId,
          origin: { q: finalPos.q, r: finalPos.r },
          predicate: (biome) => isBuildable(biome),
          isOccupied: (qq, rr) => buildingByTileKey.has(`${bodyId}:${qq}:${rr}`)
        });
        if (!relocated) continue;
        finalPos = relocated;
        buildingsChanged = true;
      }
    }

    buildingByTileKey.set(`${bodyId}:${finalPos.q}:${finalPos.r}`, b.id);
    if (finalPos.q !== b.surfacePos.q || finalPos.r !== b.surfacePos.r) buildingsChanged = true;
    nextBuildings.push({ ...b, surfacePos: finalPos });
  }

  // 2) Normalize armies (ensure surfacePos exists, in-grid, passable; stacking allowed)
  const nextArmies = state.armies.map(a => {
    if (a.state !== ArmyState.DEPLOYED) return a;

    const bodyId = a.containerId;
    const descriptor = descriptors[bodyId];
    if (!descriptor) return a;
    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) return a;

    const existing = a.surfacePos;
    const q0 = existing ? clampInt(existing.q) : NaN;
    const r0 = existing ? clampInt(existing.r) : NaN;

    let nextPos: SurfacePos | null = null;
    if (!existing) {
      nextPos = pickInitialArmyPos(state, a.id, bodyId);
    } else {
      const normalized: SurfacePos = { bodyId, q: q0, r: r0 };
      if (!isInsideGrid(normalized, descriptor)) {
        nextPos = pickInitialArmyPos(state, a.id, bodyId);
      } else {
        const biome = map.tiles[normalized.r * descriptor.config.w + normalized.q].biome;
        if (!isPassable(biome)) {
          nextPos = relocateSurfacePosDeterministic({
            state,
            entityId: a.id,
            kind: 'army',
            bodyId,
            origin: { q: normalized.q, r: normalized.r },
            predicate: (b) => isPassable(b)
          });
        } else {
          nextPos = normalized;
        }
      }
    }

    if (!nextPos) return a;
    if (!a.surfacePos || a.surfacePos.q !== nextPos.q || a.surfacePos.r !== nextPos.r || a.surfacePos.bodyId !== nextPos.bodyId) {
      armiesChanged = true;
      return { ...a, surfacePos: nextPos };
    }
    return a;
  });

  if (!armiesChanged && !buildingsChanged) return state;
  return {
    ...state,
    armies: nextArmies,
    groundBuildings: nextBuildings.length > 0 ? nextBuildings : undefined
  };
};

