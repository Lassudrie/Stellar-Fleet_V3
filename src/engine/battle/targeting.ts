import { ShipType } from '../../shared/types';
import { BattleShipState } from './types';
import {
  TARGET_CAPITAL_FOCUS_BOMBER_CHANCE,
  TARGET_FRICTION_KEEP_CHANCE,
  TARGET_TRANSPORT_FOCUS_BASE,
  TARGET_TRANSPORT_FOCUS_MAX,
  TARGET_TRANSPORT_FOCUS_PER_ROUND
} from './constants';

// Priority Tables (Lower index = Higher priority)
const PRIORITIES: Record<ShipType, ShipType[]> = {
  [ShipType.CARRIER]: [
    ShipType.CARRIER,
    ShipType.CRUISER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.CRUISER]: [
    ShipType.CARRIER,
    ShipType.CRUISER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.DESTROYER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.FRIGATE]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.FIGHTER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.BOMBER]: [
    ShipType.CARRIER,
    ShipType.CRUISER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.TRANSPORTER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.BUILDER
  ],
  [ShipType.BUILDER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.TRANSPORTER
  ],
  [ShipType.SUPPORT]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.TRANSPORTER,
    ShipType.BUILDER
  ],
  [ShipType.TANKER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.BUILDER
  ],
  [ShipType.EXTRACTOR]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.BUILDER
  ],
};

export const selectTarget = (
  attacker: BattleShipState,
  enemies: BattleShipState[],
  rand: () => number,
  options?: {
    enemiesByType?: Map<ShipType, BattleShipState[]>;
    shipLookup?: Map<string, BattleShipState>;
    round?: number;
  }
): string | null => {
  if (enemies.length === 0) return null;

  const { enemiesByType, shipLookup, round = 1 } = options ?? {};

  // 1. Friction: Keep current target if valid and random check passes
  if (attacker.targetId) {
    const current = shipLookup?.get(attacker.targetId) ?? enemies.find(e => e.shipId === attacker.targetId);
    if (current && current.currentHp > 0 && current.faction !== attacker.faction) {
      // Keep target if valid based on configured friction
      if (rand() < TARGET_FRICTION_KEEP_CHANCE) return attacker.targetId;
    }
  }

  const getCandidatesForType = (type: ShipType) => {
    const prefiltered = enemiesByType?.get(type);
    if (prefiltered) return prefiltered;

    return enemies.filter(e => e.type === type && e.currentHp > 0);
  };

  // 2. Focus logic (probabilistic)
  const transportFocusChance = Math.min(
    TARGET_TRANSPORT_FOCUS_MAX,
    TARGET_TRANSPORT_FOCUS_BASE + TARGET_TRANSPORT_FOCUS_PER_ROUND * (round - 1)
  );

  const transports = getCandidatesForType(ShipType.TRANSPORTER);
  if (transports.length > 0 && rand() < transportFocusChance) {
    const idx = Math.floor(rand() * transports.length) % transports.length;
    return transports[idx].shipId;
  }

  const bombers = getCandidatesForType(ShipType.BOMBER);
  if (
    bombers.length > 0 &&
    (attacker.type === ShipType.CARRIER || attacker.type === ShipType.CRUISER) &&
    rand() < TARGET_CAPITAL_FOCUS_BOMBER_CHANCE
  ) {
    const idx = Math.floor(rand() * bombers.length) % bombers.length;
    return bombers[idx].shipId;
  }

  // 3. Priority Selection
  const priorityList = PRIORITIES[attacker.type] || [];
  
  // Try to find targets by priority class
  for (const type of priorityList) {
    const candidates = getCandidatesForType(type);
    if (candidates.length > 0) {
      // Pick random within class
      const idx = Math.floor(rand() * candidates.length) % candidates.length;
      return candidates[idx].shipId;
    }
  }

  // 4. Fallback: Any living enemy
  const validEnemies = enemiesByType
    ? Array.from(enemiesByType.values()).flatMap(list => list)
    : enemies.filter(e => e.currentHp > 0);

  if (validEnemies.length > 0) {
    const idx = Math.floor(rand() * validEnemies.length) % validEnemies.length;
    return validEnemies[idx].shipId;
  }

  return null;
};
