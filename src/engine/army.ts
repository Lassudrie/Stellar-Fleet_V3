
import { Army, ArmyState, FactionId, GameState, ShipEntity, ShipType, Fleet, PlanetBody } from '../shared/types';
import { RNG } from './rng';
import { logger } from '../shared/devLogger';
import { getPlanetById } from './planets';

export const MIN_ARMY_CREATION_STRENGTH = 10000;
export const ARMY_DESTROY_THRESHOLD = (maxStrength: number): number => Math.max(100, Math.floor(maxStrength * 0.2));

/**
 * Creates a new Army entity.
 * Enforces the rule: Minimum 10,000 soldiers.
 * 
 * @param factionId The faction owning the army.
 * @param strength Number of soldiers.
 * @param containerId ID of the Fleet (if embarked) or Planet/Moon (if deployed).
 * @param initialState Initial state (default: EMBARKED).
 * @param rng Random Number Generator for ID creation.
 * @returns The created Army object or null if validation fails.
 */
export const createArmy = (
  factionId: FactionId,
  strength: number,
  containerId: string,
  initialState: ArmyState,
  rng: RNG
): Army | null => {
  
  // Rule Check: Minimum Strength
  if (strength < MIN_ARMY_CREATION_STRENGTH) {
    logger.error(`[Army] Creation Failed: Army strength ${strength} is below minimum of ${MIN_ARMY_CREATION_STRENGTH}.`);
    return null;
  }

  // Rule Check: Valid Container ID (Basic check)
  if (!containerId) {
    logger.error('[Army] Creation Failed: No container ID provided.');
    return null;
  }

  const army: Army = {
    id: rng.id('army'),
    factionId,
    strength: Math.floor(strength), // Ensure integer
    maxStrength: Math.floor(strength),
    morale: 1,
    state: initialState,
    containerId
  };

  logger.debug(`[Army] Created Army ${army.id} (${factionId}) with ${strength} soldiers. State: ${initialState}. Container: ${containerId}`);
  return army;
};

/**
 * Validates an Army's integrity within the GameState.
 * Ensures the army is in a valid location based on its state.
 */
export const validateArmyState = (army: Army, state: GameState): boolean => {
  // 1. Strength Integrity
  if (army.maxStrength < MIN_ARMY_CREATION_STRENGTH) {
    // console.warn(`[Army] Invalid Strength: Army ${army.id} has ${army.strength} soldiers.`);
    return false;
  }

  // 2. Location Integrity
  if (army.state === ArmyState.DEPLOYED) {
    const match = getPlanetById(state.systems, army.containerId);
    if (!match || !match.planet.isSolid) {
      // console.warn(`[Army] Orphaned Deployed Army: ${army.id} refers to missing/invalid planet ${army.containerId}.`);
      return false;
    }
  } else if (army.state === ArmyState.EMBARKED || army.state === ArmyState.IN_TRANSIT) {
    // Must be in a valid Fleet
    const fleet = state.fleets.find(f => f.id === army.containerId);
    if (!fleet) {
      // console.warn(`[Army] Orphaned Embarked Army: ${army.id} refers to missing fleet ${army.containerId}.`);
      return false;
    }
    
    // STRICT RULE: Must be linked to a specific ship
    const transportShip = fleet.ships.find(s => s.carriedArmyId === army.id);
    if (!transportShip) {
        // console.warn(`[Army] Floating Army: ${army.id} is in fleet ${fleet.id} but assigned to no ship.`);
        return false;
    }
  }

  return true;
};

/**
 * High-performance integrity check and repair.
 * Detects:
 * - Armies failing validateArmyState (Orphans, Invalid Props)
 * - Reference anomalies (Multiple ships claiming the same Army)
 * 
 * @returns Cleaned army list and a list of log messages describing fixes.
 */
export const sanitizeArmies = (state: GameState): { state: GameState, logs: string[] } => {
    const logs: string[] = [];
    const armiesById = new Map(state.armies.map(army => [army.id, army]));
    const fleetUpdates = new Map<string, Fleet>();
    let fleetsChanged = false;

    const getFleetClone = (fleet: Fleet): Fleet => {
        const existing = fleetUpdates.get(fleet.id);
        if (existing) return existing;
        const clone = { ...fleet, ships: fleet.ships.slice() };
        fleetUpdates.set(fleet.id, clone);
        return clone;
    };

    const clearShipArmy = (fleet: Fleet, shipIndex: number, armyId: string) => {
        const fleetClone = getFleetClone(fleet);
        const ship = fleetClone.ships[shipIndex];
        if (!ship || ship.carriedArmyId !== armyId) return;
        fleetClone.ships[shipIndex] = { ...ship, carriedArmyId: null };
        fleetsChanged = true;
    };

    state.fleets.forEach(fleet => {
        fleet.ships.forEach((ship, shipIndex) => {
            const armyId = ship.carriedArmyId;
            if (!armyId) return;

            if (!armiesById.has(armyId)) {
                logs.push(`Ship ${ship.id} (${fleet.id}) cleared reference to missing army ${armyId}.`);
                clearShipArmy(fleet, shipIndex, armyId);
            }
        });
    });

    const buildCarrierMap = (fleets: Fleet[]) => {
        const carrierMap = new Map<string, { fleet: Fleet; shipIndex: number; shipId: string }[]>();
        fleets.forEach(fleet => {
            fleet.ships.forEach((ship, shipIndex) => {
                if (!ship.carriedArmyId) return;
                const carriers = carrierMap.get(ship.carriedArmyId) || [];
                carriers.push({ fleet, shipIndex, shipId: ship.id });
                carrierMap.set(ship.carriedArmyId, carriers);
            });
        });
        return carrierMap;
    };

    const fleetsForValidation = fleetUpdates.size
        ? state.fleets.map(fleet => fleetUpdates.get(fleet.id) ?? fleet)
        : state.fleets;

    const carrierMap = buildCarrierMap(fleetsForValidation);

    carrierMap.forEach((carriers, armyId) => {
        if (carriers.length <= 1) return;

        carriers.sort((a, b) => a.shipId.localeCompare(b.shipId));
        const [canonical, ...duplicates] = carriers;
        duplicates.forEach(({ fleet, shipIndex, shipId }) => {
            clearShipArmy(fleet, shipIndex, armyId);
            logs.push(`Ship ${shipId} (${fleet.id}) unlinked from shared army ${armyId}; canonical carrier is ${canonical.shipId} (${canonical.fleet.id}).`);
        });
    });

    const fleetsAfterDedup = fleetUpdates.size
        ? state.fleets.map(fleet => fleetUpdates.get(fleet.id) ?? fleet)
        : state.fleets;
    const carriersAfterDedup = buildCarrierMap(fleetsAfterDedup);

    const sanitizedArmies: Army[] = [];
    const validationState: GameState = { ...state, fleets: fleetsAfterDedup, armies: state.armies };

    for (const army of state.armies) {
        let isValid = true;
        const carriers = carriersAfterDedup.get(army.id) || [];

        if (army.state === ArmyState.EMBARKED || army.state === ArmyState.IN_TRANSIT) {
            if (carriers.length === 0) {
                logs.push(`Army ${army.id} had no transport ship. Removed to restore consistency.`);
                isValid = false;
            }
        }

        if (isValid && !validateArmyState(army, validationState)) {
            logs.push(`Army ${army.id} failed validation (missing container or location). Removed.`);
            isValid = false;
        }

        if (isValid) {
            const destructionThreshold = ARMY_DESTROY_THRESHOLD(army.maxStrength);
            if (army.strength <= destructionThreshold) {
                logs.push(`Army ${army.id} removed due to critical strength (${army.strength} <= ${destructionThreshold}).`);
                isValid = false;
            }
        }

        if (!isValid) {
            carriers.forEach(({ fleet, shipIndex }) => {
                clearShipArmy(fleet, shipIndex, army.id);
            });
            continue;
        }

        sanitizedArmies.push(army);
    }

    const nextFleets = fleetUpdates.size
        ? state.fleets.map(fleet => fleetUpdates.get(fleet.id) ?? fleet)
        : state.fleets;

    if (!fleetsChanged && sanitizedArmies.length === state.armies.length) {
        return { state, logs };
    }

    return {
        state: {
            ...state,
            fleets: nextFleets,
            armies: sanitizedArmies
        },
        logs
    };
};

// --- TRANSPORT LOGIC ---

/**
 * Checks if a ship is a valid candidate to carry an army.
 * Rule 1: Must be TROOP_TRANSPORT.
 * Rule 2: Must be empty.
 */
export const canLoadArmy = (ship: ShipEntity): boolean => {
    if (ship.type !== ShipType.TROOP_TRANSPORT) return false;
    if (ship.carriedArmyId) return false; // Already full
    return true;
};

/**
 * Loads an army into a transport ship.
 * Updates both the Ship (carriedArmyId) and the Army (state, containerId).
 * 
 * @returns true if successful, false if validation failed.
 */
export const loadArmyIntoShip = (army: Army, ship: ShipEntity, fleet: Fleet): boolean => {
    if (!canLoadArmy(ship)) {
        logger.error(`[Army] Load Failed: Ship ${ship.id} cannot carry army.`);
        return false;
    }
    
    if (army.factionId !== fleet.factionId) {
        logger.error('[Army] Load Failed: Faction mismatch.');
        return false;
    }

    if (army.state !== ArmyState.DEPLOYED) {
        logger.error(`[Army] Load Failed: Army ${army.id} is not deployed (State: ${army.state}).`);
        return false;
    }

    // Mutate State (Simulated)
    ship.carriedArmyId = army.id;
    army.containerId = fleet.id;
    army.state = ArmyState.EMBARKED;
    
    logger.debug(`[Army] ${army.id} EMBARKED into ${ship.type} ${ship.id} (Fleet ${fleet.id}).`);
    return true;
};

/**
 * Unloads an army from a ship to a planet.
 * 
 * @returns true if successful.
 */
export const deployArmyToSystem = (army: Army, ship: ShipEntity, planet: PlanetBody): boolean => {
    if (ship.carriedArmyId !== army.id) {
        logger.warn(`[Army] Deploy Warning: Ship ${ship.id} does not carry army ${army.id}.`);
        return false;
    }

    ship.carriedArmyId = null;
    army.state = ArmyState.DEPLOYED;
    army.containerId = planet.id;
    
    logger.info(`[Army] ${army.id} DEPLOYED to ${planet.name}.`);
    return true;
};

/**
 * Unloads an army from a ship (Generic / Destruction context).
 * Does NOT set new state (Caller must handle that, e.g. deleting army).
 */
export const unloadArmyFromShip = (army: Army, ship: ShipEntity): void => {
    if (ship.carriedArmyId === army.id) {
        ship.carriedArmyId = null;
        logger.info(`[Army] ${army.id} UNLOADED from ${ship.id}.`);
    } else {
        logger.warn(`[Army] Unload Warning: Ship ${ship.id} does not carry army ${army.id}.`);
    }
};

/**
 * Checks if a fleet contains at least one Troop Transport with an embarked army.
 * Used for UI logic (Can I invade?).
 */
export const hasInvadingForce = (fleet: Fleet): boolean => {
    return fleet.ships.some(s => 
        s.type === ShipType.TROOP_TRANSPORT && 
        !!s.carriedArmyId
    );
};
