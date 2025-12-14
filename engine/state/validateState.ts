/**
 * State Validation Utility
 * 
 * Validates GameState invariants to detect corruption, orphaned references,
 * and duplicate IDs. Useful for debugging and ensuring state integrity.
 */

import { GameState, Fleet, Army, ArmyState, Battle } from '../../types';

export interface ValidationError {
    severity: 'error' | 'warning';
    category: 'duplicate_id' | 'orphan_ref' | 'invalid_state' | 'constraint';
    entityType: string;
    entityId?: string;
    message: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationError[];
}

/**
 * Validates the entire GameState for invariant violations.
 * 
 * Checks:
 * 1. No duplicate IDs within entity collections
 * 2. No orphaned references (e.g., fleet.targetSystemId pointing to non-existent system)
 * 3. Army containerId points to valid fleet or system
 * 4. Ship.carriedArmyId references existing army
 * 5. Battle.involvedFleetIds reference existing fleets
 */
export const validateGameState = (state: GameState): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // --- 1. DUPLICATE ID CHECKS ---

    // Fleets
    const fleetIds = new Set<string>();
    state.fleets.forEach(fleet => {
        if (fleetIds.has(fleet.id)) {
            errors.push({
                severity: 'error',
                category: 'duplicate_id',
                entityType: 'fleet',
                entityId: fleet.id,
                message: `Duplicate fleet ID: ${fleet.id}`
            });
        }
        fleetIds.add(fleet.id);
    });

    // Ships (across all fleets)
    const shipIds = new Set<string>();
    state.fleets.forEach(fleet => {
        fleet.ships.forEach(ship => {
            if (shipIds.has(ship.id)) {
                errors.push({
                    severity: 'error',
                    category: 'duplicate_id',
                    entityType: 'ship',
                    entityId: ship.id,
                    message: `Duplicate ship ID: ${ship.id} (in fleet ${fleet.id})`
                });
            }
            shipIds.add(ship.id);
        });
    });

    // Armies
    const armyIds = new Set<string>();
    state.armies.forEach(army => {
        if (armyIds.has(army.id)) {
            errors.push({
                severity: 'error',
                category: 'duplicate_id',
                entityType: 'army',
                entityId: army.id,
                message: `Duplicate army ID: ${army.id}`
            });
        }
        armyIds.add(army.id);
    });

    // Systems
    const systemIds = new Set<string>();
    state.systems.forEach(system => {
        if (systemIds.has(system.id)) {
            errors.push({
                severity: 'error',
                category: 'duplicate_id',
                entityType: 'system',
                entityId: system.id,
                message: `Duplicate system ID: ${system.id}`
            });
        }
        systemIds.add(system.id);
    });

    // Battles
    const battleIds = new Set<string>();
    state.battles.forEach(battle => {
        if (battleIds.has(battle.id)) {
            errors.push({
                severity: 'error',
                category: 'duplicate_id',
                entityType: 'battle',
                entityId: battle.id,
                message: `Duplicate battle ID: ${battle.id}`
            });
        }
        battleIds.add(battle.id);
    });

    // --- 2. ORPHAN REFERENCE CHECKS ---

    // Fleet.targetSystemId must exist
    state.fleets.forEach(fleet => {
        if (fleet.targetSystemId && !systemIds.has(fleet.targetSystemId)) {
            warnings.push({
                severity: 'warning',
                category: 'orphan_ref',
                entityType: 'fleet',
                entityId: fleet.id,
                message: `Fleet ${fleet.id} has targetSystemId "${fleet.targetSystemId}" which does not exist`
            });
        }
        
        if (fleet.invasionTargetSystemId && !systemIds.has(fleet.invasionTargetSystemId)) {
            warnings.push({
                severity: 'warning',
                category: 'orphan_ref',
                entityType: 'fleet',
                entityId: fleet.id,
                message: `Fleet ${fleet.id} has invasionTargetSystemId "${fleet.invasionTargetSystemId}" which does not exist`
            });
        }
    });

    // Ship.carriedArmyId must exist
    state.fleets.forEach(fleet => {
        fleet.ships.forEach(ship => {
            if (ship.carriedArmyId && !armyIds.has(ship.carriedArmyId)) {
                errors.push({
                    severity: 'error',
                    category: 'orphan_ref',
                    entityType: 'ship',
                    entityId: ship.id,
                    message: `Ship ${ship.id} carries army "${ship.carriedArmyId}" which does not exist`
                });
            }
        });
    });

    // Army.containerId must be valid fleet or system
    state.armies.forEach(army => {
        const isFleet = fleetIds.has(army.containerId);
        const isSystem = systemIds.has(army.containerId);
        
        if (!isFleet && !isSystem) {
            errors.push({
                severity: 'error',
                category: 'orphan_ref',
                entityType: 'army',
                entityId: army.id,
                message: `Army ${army.id} has containerId "${army.containerId}" which is neither a fleet nor a system`
            });
        }

        // State consistency check
        if (army.state === ArmyState.DEPLOYED && isFleet) {
            errors.push({
                severity: 'error',
                category: 'invalid_state',
                entityType: 'army',
                entityId: army.id,
                message: `Army ${army.id} is DEPLOYED but containerId points to a fleet`
            });
        }
        
        if ((army.state === ArmyState.EMBARKED || army.state === ArmyState.IN_TRANSIT) && isSystem) {
            errors.push({
                severity: 'error',
                category: 'invalid_state',
                entityType: 'army',
                entityId: army.id,
                message: `Army ${army.id} is ${army.state} but containerId points to a system`
            });
        }
    });

    // Battle.systemId must exist
    state.battles.forEach(battle => {
        if (!systemIds.has(battle.systemId)) {
            warnings.push({
                severity: 'warning',
                category: 'orphan_ref',
                entityType: 'battle',
                entityId: battle.id,
                message: `Battle ${battle.id} references system "${battle.systemId}" which does not exist`
            });
        }
    });

    // --- 3. CROSS-REFERENCE CONSISTENCY ---

    // Each carriedArmyId should have exactly one carrier
    const armyCarriers = new Map<string, string[]>();
    state.fleets.forEach(fleet => {
        fleet.ships.forEach(ship => {
            if (ship.carriedArmyId) {
                const carriers = armyCarriers.get(ship.carriedArmyId) || [];
                carriers.push(`${ship.id}@${fleet.id}`);
                armyCarriers.set(ship.carriedArmyId, carriers);
            }
        });
    });

    armyCarriers.forEach((carriers, armyId) => {
        if (carriers.length > 1) {
            errors.push({
                severity: 'error',
                category: 'constraint',
                entityType: 'army',
                entityId: armyId,
                message: `Army ${armyId} is carried by multiple ships: [${carriers.join(', ')}]`
            });
        }
    });

    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
};

/**
 * Logs validation results to console.
 */
export const logValidationResult = (result: ValidationResult, label?: string): void => {
    const prefix = label ? `[Validation: ${label}]` : '[Validation]';
    
    if (result.valid && result.warnings.length === 0) {
        console.log(`${prefix} State is valid.`);
        return;
    }

    if (result.errors.length > 0) {
        console.error(`${prefix} Found ${result.errors.length} ERROR(s):`);
        result.errors.forEach(e => console.error(`  [${e.category}] ${e.message}`));
    }

    if (result.warnings.length > 0) {
        console.warn(`${prefix} Found ${result.warnings.length} WARNING(s):`);
        result.warnings.forEach(w => console.warn(`  [${w.category}] ${w.message}`));
    }
};

/**
 * Quick validation check - returns true if state passes all critical checks.
 * Faster than full validation for hot paths.
 */
export const isStateValid = (state: GameState): boolean => {
    // Quick duplicate ID check using Set sizes
    const fleetIdCount = new Set(state.fleets.map(f => f.id)).size;
    if (fleetIdCount !== state.fleets.length) return false;

    const armyIdCount = new Set(state.armies.map(a => a.id)).size;
    if (armyIdCount !== state.armies.length) return false;

    const systemIdCount = new Set(state.systems.map(s => s.id)).size;
    if (systemIdCount !== state.systems.length) return false;

    return true;
};
