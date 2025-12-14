import { ShipType } from '../../types';
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
  rngValue: number
): string | null => {
  if (enemies.length === 0) return null;

  // 1. Friction: Keep current target if valid and random check passes
  if (attacker.targetId) {
    const current = enemies.find(e => e.shipId === attacker.targetId);
    if (current && current.currentHp > 0) {
      // 80% chance to keep target if valid
      if (rngValue > 0.2) return attacker.targetId;
    }
  }

  // 2. Priority Selection
  const priorityList = PRIORITIES[attacker.type] || [];
  
  // Try to find targets by priority class
  for (const type of priorityList) {
    const candidates = enemies.filter(e => e.type === type && e.currentHp > 0);
    if (candidates.length > 0) {
      // Pick random within class
      const idx = Math.floor(rngValue * candidates.length) % candidates.length;
      return candidates[idx].shipId;
    }
  }

  // 3. Fallback: Any living enemy
  const validEnemies = enemies.filter(e => e.currentHp > 0);
  if (validEnemies.length > 0) {
     const idx = Math.floor(rngValue * validEnemies.length) % validEnemies.length;
     return validEnemies[idx].shipId;
  }

  return null;
};