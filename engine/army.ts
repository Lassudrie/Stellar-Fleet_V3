
import { Army, ArmyState, FactionId, GameState, ShipEntity, ShipType, Fleet, PlanetBody } from '../types';
import { RNG } from './rng';
import { logger } from '../tools/devLogger';
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
export const sanitizeArmies = (state: GameState): { armies: Army[], logs: string[] } => {
    const validArmies: Army[] = [];
    const logs: string[] = [];
    const claimedArmyIds = new Map<string, string[]>(); // ArmyID -> ShipID[]

    // 1. O(F*S) Pre-calculation: Map all ship-army references
    state.fleets.forEach(fleet => {
        fleet.ships.forEach(ship => {
            if (ship.carriedArmyId) {
                const list = claimedArmyIds.get(ship.carriedArmyId) || [];
                list.push(`${ship.id} (${fleet.id})`);
                claimedArmyIds.set(ship.carriedArmyId, list);
            }
        });
    });

    // 2. Iterate Armies
    for (const army of state.armies) {
        let isValid = true;

        // Check A: Local Integrity (Standard Validation)
        if (!validateArmyState(army, state)) {
            logs.push(`Army ${army.id} failed validation (Orphaned or Invalid State). Removed.`);
            isValid = false;
        }

        // Check B: Reference Integrity (for Embarked armies)
        if (isValid && (army.state === ArmyState.EMBARKED || army.state === ArmyState.IN_TRANSIT)) {
            const carriers = claimedArmyIds.get(army.id);
            
            if (!carriers || carriers.length === 0) {
                // Should have been caught by validateArmyState usually, but double check reverse link
                logs.push(`Army ${army.id} is Embarked but no ship claims it. Removed.`);
                isValid = false;
            } else if (carriers.length > 1) {
                // CRITICAL: Duplication Glitch
                logs.push(`CRITICAL: Army ${army.id} claim conflict. Carried by multiple ships: [${carriers.join(', ')}]. Army destroyed to prevent paradox.`);
                // We destroy the army. The ships will point to a non-existent army ID, 
                // which is "safer" than cloning the army, or we could auto-clean the ships here.
                // For now, removing the army is the safest state convergence.
                isValid = false;
            }
        }

        // Check C: Destruction threshold
        if (isValid) {
            const destructionThreshold = ARMY_DESTROY_THRESHOLD(army.maxStrength);
            if (army.strength <= destructionThreshold) {
                logs.push(`Army ${army.id} removed due to critical strength (${army.strength} <= ${destructionThreshold}).`);
                isValid = false;
            }
        }

        if (isValid) {
            validArmies.push(army);
        }
    }

    return { armies: validArmies, logs };
};

export const sanitizeArmyLinks = (state: GameState): { state: GameState, logs: string[] } => {
    const logs: string[] = [];

    const fleets: Fleet[] = state.fleets.map(fleet => ({
        ...fleet,
        ships: fleet.ships.map(ship => ({ ...ship }))
    }));

    const armies: Army[] = state.armies.map(army => ({ ...army }));
    const armiesById = new Map(armies.map(army => [army.id, army]));

    fleets.forEach(fleet => {
        fleet.ships.forEach(ship => {
            const armyId = ship.carriedArmyId;
            if (!armyId) return;

            if (!armiesById.has(armyId)) {
                logs.push(`Ship ${ship.id} (${fleet.id}) cleared reference to missing army ${armyId}.`);
                ship.carriedArmyId = null;
            }
        });
    });

    const carrierMap = new Map<string, { ship: ShipEntity; fleetId: string }[]>();

    fleets.forEach(fleet => {
        fleet.ships.forEach(ship => {
            if (!ship.carriedArmyId) return;
            const carriers = carrierMap.get(ship.carriedArmyId) || [];
            carriers.push({ ship, fleetId: fleet.id });
            carrierMap.set(ship.carriedArmyId, carriers);
        });
    });

    carrierMap.forEach((carriers, armyId) => {
        if (carriers.length <= 1) return;

        carriers.sort((a, b) => a.ship.id.localeCompare(b.ship.id));
        const [canonical, ...duplicates] = carriers;
        duplicates.forEach(({ ship, fleetId }) => {
            ship.carriedArmyId = null;
            logs.push(`Ship ${ship.id} (${fleetId}) unlinked from shared army ${armyId}; canonical carrier is ${canonical.ship.id} (${canonical.fleetId}).`);
        });
        carrierMap.set(armyId, [canonical]);
    });

    const sanitizedArmies: Army[] = [];
    const validationState: GameState = { ...state, fleets, armies };

    for (const army of armies) {
        let isValid = true;

        if (!validateArmyState(army, validationState)) {
            logs.push(`Army ${army.id} failed validation (missing container or location). Removed.`);
            isValid = false;
        }

        if (isValid && (army.state === ArmyState.EMBARKED || army.state === ArmyState.IN_TRANSIT)) {
            const carriers = carrierMap.get(army.id);
            if (!carriers || carriers.length === 0) {
                logs.push(`Army ${army.id} had no transport ship. Removed to restore consistency.`);
                isValid = false;
            }
        }

        if (isValid) {
            const destructionThreshold = ARMY_DESTROY_THRESHOLD(army.maxStrength);
            if (army.strength <= destructionThreshold) {
                logs.push(`Army ${army.id} removed due to critical strength (${army.strength} <= ${destructionThreshold}).`);
                isValid = false;
            }
        }

        if (!isValid) {
            const carriers = carrierMap.get(army.id) || [];
            carriers.forEach(({ ship }) => {
                if (ship.carriedArmyId === army.id) {
                    ship.carriedArmyId = null;
                }
            });
            continue;
        }

        sanitizedArmies.push(army);
    }

    return {
        state: {
            ...state,
            fleets,
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
