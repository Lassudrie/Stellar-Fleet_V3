import { ShipType } from '../../types';
import { TARGET_REACQUIRE_THRESHOLD } from './constants';
import { BattleShipState } from './types';

// Priority Tables (Lower index = Higher priority)
const PRIORITIES: Record<ShipType, ShipType[]> = {
  [ShipType.CARRIER]: [ShipType.CARRIER, ShipType.CRUISER, ShipType.DESTROYER, ShipType.FRIGATE],
  [ShipType.CRUISER]: [ShipType.CARRIER, ShipType.CRUISER, ShipType.DESTROYER, ShipType.FRIGATE],
  [ShipType.DESTROYER]: [ShipType.BOMBER, ShipType.FIGHTER, ShipType.FRIGATE, ShipType.DESTROYER],
  [ShipType.FRIGATE]: [ShipType.BOMBER, ShipType.FIGHTER, ShipType.DESTROYER, ShipType.FRIGATE],
  [ShipType.FIGHTER]: [ShipType.BOMBER, ShipType.FIGHTER, ShipType.FRIGATE, ShipType.DESTROYER],
  [ShipType.BOMBER]: [ShipType.CARRIER, ShipType.CRUISER, ShipType.DESTROYER, ShipType.FRIGATE],
  [ShipType.TROOP_TRANSPORT]: [ShipType.BOMBER, ShipType.FIGHTER, ShipType.FRIGATE, ShipType.DESTROYER],
};

export const selectTarget = (
  attacker: BattleShipState,
  enemies: BattleShipState[],
  rngValue: number,
  options?: {
    enemiesByType?: Map<ShipType, BattleShipState[]>;
    shipLookup?: Map<string, BattleShipState>;
  }
): string | null => {
  if (enemies.length === 0) return null;

  const { enemiesByType, shipLookup } = options ?? {};

  // 1. Friction: Keep current target if valid and random check passes
  if (attacker.targetId) {
    const current = shipLookup?.get(attacker.targetId) ?? enemies.find(e => e.shipId === attacker.targetId);
    if (current && current.currentHp > 0 && current.faction !== attacker.faction) {
      // 80% chance to keep target if valid
      if (rngValue > TARGET_REACQUIRE_THRESHOLD) return attacker.targetId;
    }
  }

  const getCandidatesForType = (type: ShipType) => {
    const prefiltered = enemiesByType?.get(type);
    if (prefiltered) return prefiltered;

    return enemies.filter(e => e.type === type && e.currentHp > 0);
  };

  // 2. Priority Selection
  const priorityList = PRIORITIES[attacker.type] || [];
  
  // Try to find targets by priority class
  for (const type of priorityList) {
    const candidates = getCandidatesForType(type);
    if (candidates.length > 0) {
      // Pick random within class
      const idx = Math.floor(rngValue * candidates.length) % candidates.length;
      return candidates[idx].shipId;
    }
  }

  // 3. Fallback: Any living enemy
  const validEnemies = enemiesByType
    ? Array.from(enemiesByType.values()).flatMap(list => list)
    : enemies.filter(e => e.currentHp > 0);

  if (validEnemies.length > 0) {
    const idx = Math.floor(rngValue * validEnemies.length) % validEnemies.length;
    return validEnemies[idx].shipId;
  }

  return null;
};
