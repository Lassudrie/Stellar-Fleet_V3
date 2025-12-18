import { Army, ArmyState, Fleet, LogEntry, ShipType, StarSystem } from '../types';
import { shortId } from './idUtils';
import { RNG } from './rng';

export interface ArmyOpsOptions {
    fleetLabel?: string;
    logText?: string | ((count: number) => string);
}

export interface LoadOpsParams extends ArmyOpsOptions {
    fleet: Fleet;
    system: StarSystem;
    armies: Army[];
    day: number;
    rng: RNG;
    allowedArmyIds?: Set<string>;
    allowedShipIds?: Set<string>;
}

export interface UnloadOpsParams extends ArmyOpsOptions {
    fleet: Fleet;
    system: StarSystem;
    armies: Army[];
    day: number;
    rng: RNG;
    allowedArmyIds?: Set<string>;
    allowedShipIds?: Set<string>;
}

export interface ArmyOpsResult {
    fleet: Fleet;
    armies: Army[];
    logs: LogEntry[];
    count: number;
}

const getLogText = (count: number, system: StarSystem, fleetLabel: string, override?: string | ((count: number) => string)) => {
    if (typeof override === 'string') return override;
    if (typeof override === 'function') return override(count);
    return `Fleet ${fleetLabel} unloaded ${count} armies at ${system.name}.`;
};

const getLoadLogText = (count: number, system: StarSystem, fleetLabel: string, override?: string | ((count: number) => string)) => {
    if (typeof override === 'string') return override;
    if (typeof override === 'function') return override(count);
    return `Fleet ${fleetLabel} loaded ${count} armies at ${system.name}.`;
};

export const computeLoadOps = (params: LoadOpsParams): ArmyOpsResult => {
    const { fleet, system, armies, day, rng, fleetLabel, logText, allowedArmyIds, allowedShipIds } = params;
    const label = fleetLabel ?? shortId(fleet.id);

    const availableArmies = armies.filter(army =>
        army.containerId === system.id &&
        army.factionId === fleet.factionId &&
        army.state === ArmyState.DEPLOYED &&
        (!allowedArmyIds || allowedArmyIds.has(army.id))
    );

    const transports = fleet.ships.filter(ship =>
        ship.type === ShipType.TROOP_TRANSPORT &&
        !ship.carriedArmyId &&
        (!allowedShipIds || allowedShipIds.has(ship.id))
    );
    const loadableArmies = Math.min(availableArmies.length, transports.length);

    if (loadableArmies === 0) {
        return { fleet, armies, logs: [], count: 0 };
    }

    const updatedArmies = armies.map(army => {
        if (army.containerId !== system.id) return army;
        if (army.factionId !== fleet.factionId) return army;
        if (army.state !== ArmyState.DEPLOYED) return army;

        const idx = availableArmies.findIndex(a => a.id === army.id);
        if (idx === -1 || idx >= loadableArmies) return army;

        return {
            ...army,
            state: ArmyState.EMBARKED,
            containerId: fleet.id
        };
    });

    let loadedCount = 0;
    const updatedFleet: Fleet = {
        ...fleet,
        ships: fleet.ships.map(ship => {
            if (ship.type !== ShipType.TROOP_TRANSPORT || ship.carriedArmyId) return ship;
            const army = availableArmies[loadedCount];
            if (!army || loadedCount >= loadableArmies) return ship;
            loadedCount++;
            return { ...ship, carriedArmyId: army.id };
        })
    };

    const logs: LogEntry[] = [
        {
            id: rng.id('log'),
            day,
            text: getLoadLogText(loadableArmies, system, label, logText),
            type: 'move'
        }
    ];

    return { fleet: updatedFleet, armies: updatedArmies, logs, count: loadableArmies };
};

export const computeUnloadOps = (params: UnloadOpsParams): ArmyOpsResult => {
    const { fleet, system, armies, day, rng, fleetLabel, logText, allowedArmyIds, allowedShipIds } = params;
    const label = fleetLabel ?? shortId(fleet.id);

    const embarkedArmies = armies.filter(army =>
        army.containerId === fleet.id &&
        army.factionId === fleet.factionId &&
        army.state === ArmyState.EMBARKED &&
        (!allowedArmyIds || allowedArmyIds.has(army.id))
    );

    if (embarkedArmies.length === 0) {
        return { fleet, armies, logs: [], count: 0 };
    }

    const unloadedArmyIds: Set<string> = new Set();
    const updatedFleet: Fleet = {
        ...fleet,
        ships: fleet.ships.map(ship => {
            if (!ship.carriedArmyId) return ship;
            if (allowedShipIds && !allowedShipIds.has(ship.id)) return ship;
            const carryingArmy = embarkedArmies.find(army => army.id === ship.carriedArmyId);
            if (!carryingArmy) return ship;
            unloadedArmyIds.add(carryingArmy.id);
            return { ...ship, carriedArmyId: null };
        })
    };

    if (unloadedArmyIds.size === 0) {
        return { fleet, armies, logs: [], count: 0 };
    }

    const updatedArmies = armies.map(army => {
        if (!unloadedArmyIds.has(army.id)) return army;
        return {
            ...army,
            state: ArmyState.DEPLOYED,
            containerId: system.id
        };
    });

    const logs: LogEntry[] = [
        {
            id: rng.id('log'),
            day,
            text: getLogText(unloadedArmyIds.size, system, label, logText),
            type: 'move'
        }
    ];

    return { fleet: updatedFleet, armies: updatedArmies, logs, count: unloadedArmyIds.size };
};
