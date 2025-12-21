import { Army, ArmyState, Fleet, LogEntry, ShipType, StarSystem } from '../types';
import { shortId } from './idUtils';
import { RNG } from './rng';
import { getDefaultSolidPlanet } from './planets';
import { CONTESTED_DROP_FAILURE_THRESHOLD, CONTESTED_DROP_LOSS_FRACTION } from './constants/armyOps';

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
    targetPlanetId?: string;
    allowedArmyIds?: Set<string>;
    allowedShipIds?: Set<string>;
}

export interface ArmyOpsResult {
    fleet: Fleet;
    armies: Army[];
    logs: LogEntry[];
    count: number;
    unloadedArmyIds?: string[];
}

const getLogText = (
    count: number,
    system: StarSystem,
    fleetLabel: string,
    planetName?: string,
    override?: string | ((count: number) => string)
) => {
    if (typeof override === 'string') return override;
    if (typeof override === 'function') return override(count);
    const suffix = planetName ? ` on ${planetName}` : '';
    return `Fleet ${fleetLabel} unloaded ${count} armies at ${system.name}${suffix}.`;
};

const getLoadLogText = (count: number, system: StarSystem, fleetLabel: string, override?: string | ((count: number) => string)) => {
    if (typeof override === 'string') return override;
    if (typeof override === 'function') return override(count);
    return `Fleet ${fleetLabel} loaded ${count} armies at ${system.name}.`;
};

export const computeLoadOps = (params: LoadOpsParams): ArmyOpsResult => {
    const { fleet, system, armies, day, rng, fleetLabel, logText, allowedArmyIds, allowedShipIds } = params;
    const label = fleetLabel ?? shortId(fleet.id);

    const validPlanetIds = new Set(system.planets.filter(planet => planet.isSolid).map(planet => planet.id));
    if (validPlanetIds.size === 0) {
        return { fleet, armies, logs: [], count: 0 };
    }

    const availableArmies = armies.filter(army =>
        validPlanetIds.has(army.containerId) &&
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
        if (!validPlanetIds.has(army.containerId)) return army;
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
            if (allowedShipIds && !allowedShipIds.has(ship.id)) return ship;
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
    const { fleet, system, armies, day, rng, fleetLabel, logText, allowedArmyIds, allowedShipIds, targetPlanetId } = params;
    const label = fleetLabel ?? shortId(fleet.id);
    const fallbackPlanet = getDefaultSolidPlanet(system);
    const targetPlanet =
        system.planets.find(planet => planet.id === targetPlanetId && planet.isSolid) ??
        fallbackPlanet;

    if (!targetPlanet) {
        return { fleet, armies, logs: [], count: 0, unloadedArmyIds: [] };
    }

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
        return { fleet, armies, logs: [], count: 0, unloadedArmyIds: [] };
    }

    const updatedArmies = armies.map(army => {
        if (!unloadedArmyIds.has(army.id)) return army;
        return {
            ...army,
            state: ArmyState.DEPLOYED,
            containerId: targetPlanet.id
        };
    });

    const logs: LogEntry[] = [
        {
            id: rng.id('log'),
            day,
            text: getLogText(unloadedArmyIds.size, system, label, targetPlanet.name, logText),
            type: 'move'
        }
    ];

    return { fleet: updatedFleet, armies: updatedArmies, logs, count: unloadedArmyIds.size, unloadedArmyIds: [...unloadedArmyIds] };
};

export const applyContestedUnloadRisk = (
    armies: Army[],
    targetArmyIds: string[],
    systemName: string,
    planetName: string | undefined,
    day: number,
    rng: RNG
): { armies: Army[]; logs: LogEntry[] } => {
    return targetArmyIds.reduce<{
        armies: Army[];
        logs: LogEntry[];
    }>((outcome, targetArmyId) => {
        const roll = rng.next();
        const success = roll >= CONTESTED_DROP_FAILURE_THRESHOLD;
        const logs: LogEntry[] = [];

        if (!success) {
            let appliedLoss = 0;
            const updatedArmies = outcome.armies.map(army => {
                if (army.id !== targetArmyId) return army;
                const strengthLoss = Math.max(1, Math.floor(army.strength * CONTESTED_DROP_LOSS_FRACTION));
                appliedLoss = strengthLoss;
                return { ...army, strength: Math.max(0, army.strength - strengthLoss) };
            });

            logs.push({
                id: rng.id('log'),
                day,
                text: `Dropships took fire while unloading army ${targetArmyId} at ${planetName ?? systemName}, losing ${appliedLoss} strength.`,
                type: 'combat'
            });

            return { armies: updatedArmies, logs: [...outcome.logs, ...logs] };
        }

        logs.push({
            id: rng.id('log'),
            day,
            text: `Army ${targetArmyId} dodged enemy fire while unloading at ${planetName ?? systemName}.`,
            type: 'combat'
        });

        return { armies: outcome.armies, logs: [...outcome.logs, ...logs] };
    }, { armies, logs: [] });
};
