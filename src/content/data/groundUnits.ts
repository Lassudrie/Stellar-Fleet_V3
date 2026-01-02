import type { GroundUnitType } from '../../shared/shared';
import type { TerrainType } from '../../engine/ground';

export interface GroundUnitStats {
  baseMP: number;
  defaultMaxMembers: number;
  baseAttack: number;
  baseDefense: number;
  terrainCombatAffinity: Partial<Record<TerrainType, number>>;
  terrainMoveAffinity: Partial<Record<TerrainType, number>>;
  tags?: Array<'artillery'>;
}

// NOTE: These values are intentionally conservative defaults.
// Balance tuning is expected after the system is playable.
export const GROUND_UNIT_STATS: Record<GroundUnitType, GroundUnitStats> = {
  light_infantry: {
    baseMP: 6,
    defaultMaxMembers: 10000,
    baseAttack: 1.0,
    baseDefense: 1.0,
    terrainCombatAffinity: {
      Forest: 1.1,
      Hills: 1.05,
      Mountains: 1.05,
      Urban: 1.05,
      Desert: 0.95
    },
    terrainMoveAffinity: {
      Forest: 0.95,
      Hills: 0.95,
      Mountains: 1.0,
      Urban: 0.95,
      Swamp: 1.0,
      Desert: 1.0,
      Coastal: 1.0
    }
  },
  mechanized_infantry: {
    baseMP: 5,
    defaultMaxMembers: 10000,
    baseAttack: 1.1,
    baseDefense: 1.0,
    terrainCombatAffinity: {
      Open: 1.05,
      Forest: 0.95,
      Urban: 1.0,
      Desert: 1.0
    },
    terrainMoveAffinity: {
      Open: 0.95,
      Forest: 1.05,
      Hills: 1.05,
      Mountains: 1.2,
      Swamp: 1.2,
      Urban: 1.05,
      Desert: 1.0,
      Coastal: 1.05
    }
  },
  heavy_armor: {
    baseMP: 4,
    defaultMaxMembers: 8000,
    baseAttack: 1.25,
    baseDefense: 1.15,
    terrainCombatAffinity: {
      Open: 1.1,
      Forest: 0.9,
      Urban: 0.95,
      Mountains: 0.85,
      Swamp: 0.9
    },
    terrainMoveAffinity: {
      Open: 0.95,
      Forest: 1.15,
      Hills: 1.1,
      Mountains: 1.3,
      Swamp: 1.25,
      Urban: 1.1,
      Desert: 1.05,
      Coastal: 1.1
    }
  },
  artillery: {
    baseMP: 4,
    defaultMaxMembers: 6000,
    baseAttack: 1.2,
    baseDefense: 0.9,
    terrainCombatAffinity: {
      Open: 1.05,
      Urban: 1.05,
      Hills: 1.05
    },
    terrainMoveAffinity: {
      Open: 1.0,
      Forest: 1.1,
      Hills: 1.05,
      Mountains: 1.25,
      Swamp: 1.2,
      Urban: 1.05,
      Desert: 1.05,
      Coastal: 1.05
    },
    tags: ['artillery']
  }
};

