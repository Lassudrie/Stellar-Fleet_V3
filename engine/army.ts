import { Army, ArmyState, Fleet, ShipEntity } from '../types';

export const MIN_ARMY_STRENGTH = 10000;

// Default scaling used by deterministic ground combat.
// IMPORTANT: This is intentionally duplicated here (instead of importing) to keep the Army module
// independent from optional ground combat modules.
const DEFAULT_GROUND_COMBAT_STRENGTH_UNIT = 1000;
const DEFAULT_INITIAL_MORALE = 100;

const deriveBaseCombatStat = (strengthSoldiers: number): number => {
  const safe = Number.isFinite(strengthSoldiers) ? strengthSoldiers : 0;
  return Math.max(1, Math.floor(safe / DEFAULT_GROUND_COMBAT_STRENGTH_UNIT));
};

export const createArmy = (
  id: string,
  factionId: string,
  strength: number,
  state: ArmyState,
  containerId: string
): Army => {
  const safeStrength = Number.isFinite(strength) ? Math.floor(strength) : MIN_ARMY_STRENGTH;
  const initialStrength = Math.max(MIN_ARMY_STRENGTH, safeStrength);

  // Baseline ground-combat stats are derived from size so that old scenarios remain playable.
  const baseCombatStat = deriveBaseCombatStat(initialStrength);

  return {
    id,
    factionId,
    strength: initialStrength,
    state,
    containerId,

    // Ground combat defaults
    maxStrength: initialStrength,
    morale: DEFAULT_INITIAL_MORALE,
    experience: 0,
    level: 1,
    groundAttack: baseCombatStat,
    groundDefense: baseCombatStat,
  };
};

export const validateArmyState = (army: Army, state: any): boolean => {
  // Keep validation permissive: attrition can reduce armies below MIN_ARMY_STRENGTH.
  if (!Number.isFinite(army.strength) || army.strength <= 0) {
    console.warn(`[validateArmyState] Invalid or dead army strength: ${army.id} (${army.strength})`);
    return false;
  }

  // In deployed state, containerId should be a system id
  if (army.state === ArmyState.DEPLOYED) {
    const systemExists = state.systems.some((s: any) => s.id === army.containerId);
    if (!systemExists) {
      console.warn(`[validateArmyState] Army ${army.id} deployed to non-existent system ${army.containerId}`);
      return false;
    }
    return true;
  }

  // In embarked or in_transit state, containerId should be a fleet id AND linked to a specific transport ship
  if (army.state === ArmyState.EMBARKED || army.state === ArmyState.IN_TRANSIT) {
    const fleet = state.fleets.find((f: any) => f.id === army.containerId);
    if (!fleet) {
      console.warn(`[validateArmyState] Army ${army.id} has invalid fleet container ${army.containerId}`);
      return false;
    }

    // Verify transport ship has this army loaded
    const transportShip = fleet.ships.find((s: ShipEntity) => s.carriedArmyId === army.id);
    if (!transportShip) {
      console.warn(
        `[validateArmyState] Army ${army.id} not found in any transport ship in fleet ${fleet.id}`
      );
      return false;
    }

    return true;
  }

  console.warn(`[validateArmyState] Unknown army state: ${army.id} (${army.state})`);
  return false;
};

export const loadArmyIntoShip = (army: Army, ship: ShipEntity, fleet: Fleet): boolean => {
  if (ship.carriedArmyId) {
    console.warn(`[loadArmyIntoShip] Ship ${ship.id} already carrying army ${ship.carriedArmyId}`);
    return false;
  }

  ship.carriedArmyId = army.id;
  army.state = ArmyState.EMBARKED;
  army.containerId = fleet.id;

  return true;
};

export const unloadArmyFromShip = (army: Army, ship: ShipEntity, systemId: string): boolean => {
  if (ship.carriedArmyId !== army.id) {
    console.warn(`[unloadArmyFromShip] Ship ${ship.id} not carrying army ${army.id}`);
    return false;
  }

  ship.carriedArmyId = null;
  army.state = ArmyState.DEPLOYED;
  army.containerId = systemId;

  return true;
};

export const getFleetArmies = (fleet: Fleet, allArmies: Army[]): Army[] => {
  const armyIds = fleet.ships
    .filter(ship => ship.carriedArmyId)
    .map(ship => ship.carriedArmyId!);

  return allArmies.filter(army => armyIds.includes(army.id));
};

export const getSystemArmies = (systemId: string, allArmies: Army[]): Army[] => {
  return allArmies.filter(army => army.state === ArmyState.DEPLOYED && army.containerId === systemId);
};

export const sanitizeArmies = (state: { armies: Army[] }): { armies: Army[]; logs: string[] } => {
  // Legacy placeholder: retained for compatibility with cleanup phase.
  return { armies: state.armies, logs: [] };
};

export const hasInvadingForce = (fleet: Fleet, armies: Army[]): boolean => {
  return armies.some(army => army.containerId === fleet.id && army.state === ArmyState.EMBARKED);
};
