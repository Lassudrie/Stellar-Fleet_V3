
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
const MIN_TANKER_RESERVE_RATIO = 0.1;

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
const getFuelTransferRate = (type: ShipType): number => SHIP_STATS[type]?.fuelTransferRate ?? 0;

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
            const nextFuel = Math.min(target.capacity, ship.fuel + delta);
            ship.fuel = quantizeFuel(nextFuel);
        }
        remaining -= delta;
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

const applyTankerTransfersToFleet = (fleet: Fleet): Fleet => {
    const transferBudget = fleet.ships.reduce((total, ship) => {
        if (ship.type !== ShipType.TANKER) return total;
        return total + getFuelTransferRate(ship.type);
    }, 0);

    if (transferBudget <= 0) return fleet;

    const tankers = fleet.ships
        .map((ship, index) => ({ ship, index }))
        .filter(({ ship }) => ship.type === ShipType.TANKER)
        .map(({ ship, index }) => {
            const capacity = getFuelCapacity(ship.type);
            const reserve = capacity * MIN_TANKER_RESERVE_RATIO;
            const available = quantizeFuel(Math.max(0, ship.fuel - reserve));
            return { index, available };
        })
        .filter(tanker => tanker.available > 0);

    if (tankers.length === 0) return fleet;

    const targets = fleet.ships
        .map((ship, index) => ({ ship, index }))
        .filter(({ ship }) => ship.type !== ShipType.TANKER)
        .map(({ ship, index }) => {
            const capacity = getFuelCapacity(ship.type);
            const missing = Math.max(0, capacity - ship.fuel);
            return { index, capacity, missing };
        })
        .filter(target => target.capacity > 0 && target.missing > 0);

    if (targets.length === 0) return fleet;

    const ships = fleet.ships.map(ship => ({ ...ship }));
    let remainingBudget = transferBudget;
    let remainingAvailable = tankers.reduce((total, tanker) => total + tanker.available, 0);
    let changed = false;

    for (const target of targets) {
        if (remainingBudget <= 0 || remainingAvailable <= 0) break;

        let missing = target.capacity - ships[target.index].fuel;
        for (const tanker of tankers) {
            if (missing <= 0 || remainingBudget <= 0 || remainingAvailable <= 0) break;
            if (tanker.available <= 0) continue;

            const transferable = Math.min(missing, tanker.available, remainingBudget);
            const transfer = quantizeFuel(transferable);
            if (transfer <= 0) continue;

            const tankerShip = ships[tanker.index];
            const recipient = ships[target.index];

            const updatedRecipientFuel = Math.min(target.capacity, quantizeFuel(recipient.fuel + transfer));
            const updatedTankerFuel = quantizeFuel(tankerShip.fuel - transfer);

            if (updatedRecipientFuel !== recipient.fuel) {
                ships[target.index] = { ...recipient, fuel: updatedRecipientFuel };
                missing = target.capacity - updatedRecipientFuel;
                changed = true;
            } else {
                missing = target.capacity - recipient.fuel;
            }

            if (updatedTankerFuel !== tankerShip.fuel) {
                ships[tanker.index] = { ...tankerShip, fuel: updatedTankerFuel };
                changed = true;
            }

            tanker.available = quantizeFuel(tanker.available - transfer);
            remainingBudget = quantizeFuel(remainingBudget - transfer);
            remainingAvailable = quantizeFuel(remainingAvailable - transfer);
        }
    }

    if (!changed) return fleet;
    return { ...fleet, ships };
};

const applyTankerTransfers = (state: GameState): GameState => {
    if (state.rules?.unlimitedFuel) return state;

    let fleetsChanged = false;
    const fleets = state.fleets.map(fleet => {
        const updated = applyTankerTransfersToFleet(fleet);
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
    const refueledState = applyTankerTransfers(extractedState);

    // 4. Add Tech Logs
    const newLogs = [...refueledState.logs];
    [...carrierLossLogs, ...sanitizationLogs].forEach(txt => {
        newLogs.push({
            id: ctx.rng.id('log'),
            day: ctx.turn,
            text: `[SYSTEM] ${txt}`,
            type: 'info'
        });
    });

    return {
        ...refueledState,
        battles: activeBattles,
        logs: trimLogs(newLogs),
        messages: trimMessages(refueledState.messages)
    };
};
