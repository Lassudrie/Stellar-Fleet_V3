
import { ArmyState, GameState, ShipType, Fleet, StarSystem } from '../../../shared/types';
import { TurnContext } from '../types';
import { pruneBattles } from '../../battle/detection';
import { sanitizeArmies } from '../../army';
import { CAPTURE_RANGE_SQ, SHIP_STATS } from '../../../content/data/static';
import { getOrbitingSystem, isOrbitContested } from '../../orbit';
import { quantizeFuel } from '../../logistics/fuel';
import { distSq } from '../../math/vec3';

const LOG_RETENTION_LIMIT = 2000;
const MESSAGE_RETENTION_LIMIT = 500;

const trimLogs = (logs: GameState['logs']): GameState['logs'] => {
    if (logs.length <= LOG_RETENTION_LIMIT) return logs;
    return logs.slice(-LOG_RETENTION_LIMIT);
};

const trimMessages = (messages: GameState['messages']): GameState['messages'] => {
    if (messages.length <= MESSAGE_RETENTION_LIMIT) return messages;
    return messages.slice(-MESSAGE_RETENTION_LIMIT);
};

const getFuelCapacity = (type: ShipType): number => SHIP_STATS[type]?.fuelCapacity ?? 0;
const getExtractorRate = (): number => SHIP_STATS[ShipType.EXTRACTOR]?.fuelExtractionRate ?? 0;

const getFleetsInCaptureRangeBySystem = (systems: StarSystem[], fleets: Fleet[]): Map<string, Fleet[]> => {
    const gasSystems = systems.filter(system => system.resourceType === 'gas');
    const bySystem = new Map<string, Fleet[]>();

    for (const system of gasSystems) {
        const fleetsInRange = fleets.filter(
            fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= CAPTURE_RANGE_SQ
        );

        if (fleetsInRange.length > 0) {
            bySystem.set(system.id, fleetsInRange);
        }
    }

    return bySystem;
};

const applyGasExtractionToFleet = (fleet: Fleet, system: StarSystem | null, fleetsInRange: Fleet[]): Fleet => {
    if (!system || system.resourceType !== 'gas') return fleet;

    const extractorRate = getExtractorRate();
    if (extractorRate <= 0) return fleet;

    const extractorCount = fleet.ships.filter(ship => ship.type === ShipType.EXTRACTOR).length;
    if (extractorCount === 0) return fleet;

    const hasEnemyInRange = fleetsInRange.some(otherFleet => otherFleet.factionId !== fleet.factionId);
    if (hasEnemyInRange || isOrbitContested(system, fleetsInRange)) return fleet;

    let remaining = extractorCount * extractorRate;
    if (remaining <= 0) return fleet;

    const ships = fleet.ships.map(ship => ({ ...ship }));
    const targets = ships
        .map((ship, index) => {
            const capacity = getFuelCapacity(ship.type);
            const missing = Math.max(0, capacity - ship.fuel);
            return { index, capacity, missing };
        })
        .filter(target => target.capacity > 0 && target.missing > 0);

    if (targets.length === 0) return fleet;

    let remainingTargets = targets.length;
    for (const target of targets) {
        const share = remaining / remainingTargets;
        const delta = Math.min(target.missing, share);
        if (delta > 0) {
            const ship = ships[target.index];
            const currentFuel = ship.fuel;
            const nextFuel = Math.min(target.capacity, currentFuel + delta);
            ship.fuel = quantizeFuel(nextFuel);
            const added = ship.fuel - currentFuel;
            remaining -= added;
        }
        remainingTargets -= 1;
    }

    return { ...fleet, ships };
};

const applyGasExtraction = (state: GameState): GameState => {
    if (state.rules?.unlimitedFuel) return state;

    const fleetsBySystem = getFleetsInCaptureRangeBySystem(state.systems, state.fleets);

    let fleetsChanged = false;
    const fleets = state.fleets.map(fleet => {
        const system = getOrbitingSystem(fleet, state.systems);
        const fleetsInRange = system ? fleetsBySystem.get(system.id) ?? [] : [];
        const updated = applyGasExtractionToFleet(fleet, system, fleetsInRange);
        if (updated !== fleet) fleetsChanged = true;
        return updated;
    });

    if (!fleetsChanged) return state;
    return { ...state, fleets };
};

export const phaseCleanup = (state: GameState, ctx: TurnContext): GameState => {
    // 1. Prune Old Battles
    const activeBattles = pruneBattles(state.battles, ctx.turn);
    const fleetIds = new Set(state.fleets.map(fleet => fleet.id));

    const carrierLossLogs: string[] = [];
    const armiesAfterFleetLoss = state.armies.filter(army => {
        if (army.state === ArmyState.EMBARKED && !fleetIds.has(army.containerId)) {
            carrierLossLogs.push(`Army ${army.id} removed after losing transport fleet ${army.containerId}.`);
            return false;
        }
        return true;
    });
    
    // 2. Sanitize Armies (Remove orphans, fix references)
    // Note: We use a temp state with pruned battles to ensure army logic has fresh context
    const { state: sanitizedArmyState, logs: sanitizationLogs } = sanitizeArmies({
        ...state,
        armies: armiesAfterFleetLoss,
        battles: activeBattles
    });

    // 3. Apply passive gas extraction before final log trim
    const extractedState = applyGasExtraction(sanitizedArmyState);

    // 4. Add Tech Logs
    const newLogs = [...extractedState.logs];
    [...carrierLossLogs, ...sanitizationLogs].forEach(txt => {
        newLogs.push({
            id: ctx.rng.id('log'),
            day: ctx.turn,
            text: `[SYSTEM] ${txt}`,
            type: 'info'
        });
    });

    return {
        ...extractedState,
        battles: activeBattles,
        logs: trimLogs(newLogs),
        messages: trimMessages(extractedState.messages)
    };
};
