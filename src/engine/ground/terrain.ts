import type { Biome, GameState, HexCoord } from '../../shared/types';
import { generateSurfaceMapForState, getTileAt } from '../planetSurface/access';

export type TerrainType =
  | 'Open'
  | 'Forest'
  | 'Hills'
  | 'Mountains'
  | 'Urban'
  | 'Swamp'
  | 'Desert'
  | 'Coastal';

// --- Normative tables (Ground Surface Combat V1) ---
// NOTE: Values here are the source of truth for engine behavior and tests.
// If you change them, update docs/specs/ground-surface-combat-v1.md and tests.

export const K_TERRAIN_BASE: Record<TerrainType, number> = {
  Open: 1.0,
  Forest: 0.9,
  Hills: 0.95,
  Mountains: 0.85,
  Urban: 1.05,
  Swamp: 0.9,
  Desert: 0.95,
  Coastal: 0.95
};

export const MOVE_COST: Record<TerrainType, number> = {
  Open: 1,
  Forest: 2,
  Hills: 2,
  Mountains: 3,
  Urban: 2,
  Swamp: 3,
  Desert: 2,
  Coastal: 2
};

export const biomeToTerrainType = (biome: Biome): TerrainType => {
  switch (biome) {
    case 'desert': return 'Desert';
    case 'coast': return 'Coastal';
    case 'forest':
    case 'rainforest':
    case 'taiga': return 'Forest';
    case 'mountain':
    case 'volcanic': return 'Mountains';
    case 'rocky':
    case 'cratered': return 'Hills';
    case 'grassland':
    case 'tundra':
    case 'ice': return 'Open';
    case 'lake': return 'Coastal';
    case 'ocean': return 'Coastal'; // Ocean is impassable; TerrainType used only for display/affinity.
    default: return 'Open';
  }
};

export const deriveTerrainType = (
  state: GameState,
  bodyId: string,
  coord: HexCoord
): TerrainType => {
  // Urban if settlement or building exists on the tile.
  const buildings = state.groundBuildings ?? [];
  const hasBuilding = buildings.some(
    b => b.surfacePos.bodyId === bodyId && b.surfacePos.q === coord.q && b.surfacePos.r === coord.r
  );
  if (hasBuilding) return 'Urban';

  const surfaceMap = generateSurfaceMapForState(state, bodyId);
  const hasSettlement = surfaceMap?.settlements?.some(
    s => s.coord.q === coord.q && s.coord.r === coord.r
  );
  if (hasSettlement) return 'Urban';

  const tileResult = getTileAt(state, bodyId, coord.q, coord.r);
  if (!tileResult) return 'Open';
  return biomeToTerrainType(tileResult.tile.biome);
};

