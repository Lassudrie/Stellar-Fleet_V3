import { Army, ArmyState, Fleet, LogEntry, ShipType, StarSystem, shortId } from '../shared/shared';
import { RNG } from './rng';
import { getDefaultSolidPlanet } from './planets';

const CONTESTED_UNLOAD_FAILURE_THRESHOLD = 0.35;
const CONTESTED_UNLOAD_LOSS_FRACTION = 0.35;
const CONTESTED_UNLOAD_CONDITION_LOSS = 0.06;
type ContestedLandingMode = 'abort' | 'always_land';

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
export interface ContestedLandingRiskParams {
    mode: ContestedLandingMode;
    armies: Army[];
    targetArmyIds: string[];
    systemName: string;
    planetName?: string;
    targetPlanetId?: string;
    day: number;
    rng: RNG;
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
        ship.type === ShipType.TRANSPORTER &&
        !ship.carriedArmyId &&
        (!allowedShipIds || allowedShipIds.has(ship.id))
    );
    const loadableArmies = Math.min(availableArmies.length, transports.length);

    if (loadableArmies === 0) {
        return { fleet, armies, logs: [], count: 0 };
    }

    const loadSet = new Set(availableArmies.slice(0, loadableArmies).map(a => a.id));
    const updatedArmies = armies.map(army => {
        if (!validPlanetIds.has(army.containerId)) return army;
        if (army.factionId !== fleet.factionId) return army;
        if (army.state !== ArmyState.DEPLOYED) return army;
        if (!loadSet.has(army.id)) return army;

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
            if (ship.type !== ShipType.TRANSPORTER || ship.carriedArmyId) return ship;
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
        return { fleet, armies, logs: [], count: 0, unloadedArmyIds: [] };
    }

    const embarkedArmyMap = new Map(embarkedArmies.map(army => [army.id, army]));
    const unloadedArmyIds: Set<string> = new Set();
    const updatedFleet: Fleet = {
        ...fleet,
        ships: fleet.ships.map(ship => {
            if (!ship.carriedArmyId) return ship;
            if (allowedShipIds && !allowedShipIds.has(ship.id)) return ship;
            const carryingArmy = embarkedArmyMap.get(ship.carriedArmyId);
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

/**
 * Applique le risque d'atterrissage contesté lors du débarquement d'armées.
 *
 * **Contrat sémantique (CRITIQUE)** :
 *
 * - En mode `'always_land'` : toutes les armées débarquent, mais subissent des pertes si elles prennent feu.
 *   L'état des armées (state/containerId) n'est PAS modifié par cette fonction.
 *
 * - En mode `'abort'` : les armées qui prennent feu échouent le débarquement et restent dans leur état actuel.
 *   Les armées qui réussissent sont mises à DEPLOYED avec containerId = targetPlanetId.
 *
 * **Recommandation d'usage (pour éviter les bugs)** :
 *
 * Cette fonction doit être appelée AVANT `computeUnloadOps` si vous utilisez le mode `'abort'`.
 * En cas d'échec en mode abort, les armées restent EMBARKED (containerId = fleet.id) car leur état
 * n'a pas été modifié par cette fonction. Vous pouvez ensuite appeler `computeUnloadOps` uniquement
 * sur les armées qui ont réussi (succeeded).
 *
 * **NE PAS** appeler `computeUnloadOps` puis `applyContestedLandingRisk(mode='abort')` car cela
 * laisserait des armées en état DEPLOYED même si elles ont échoué le débarquement.
 *
 * Exemple correct :
 * ```
 * const riskOutcome = applyContestedLandingRisk({ mode: 'abort', ... });
 * const unloadResult = computeUnloadOps({
 *   ...,
 *   allowedArmyIds: new Set(riskOutcome.succeeded)
 * });
 * ```
 */
export const applyContestedLandingRisk = (params: ContestedLandingRiskParams): {
    armies: Army[];
    logs: LogEntry[];
    succeeded: string[];
    failed: string[];
} => {
    const {
        mode,
        armies,
        targetArmyIds,
        systemName,
        planetName,
        targetPlanetId,
        day,
        rng
    } = params;

    if (targetArmyIds.length === 0) {
        return { armies, logs: [], succeeded: [], failed: [] };
    }

    const targetSet = new Set(targetArmyIds);
    const succeeded: string[] = [];
    const failed: string[] = [];
    const outcomes = new Map<string, { tookFire: boolean; strengthLoss: number; success: boolean }>();

    const updatedArmies = armies.map(army => {
        if (!targetSet.has(army.id)) return army;

        const roll = rng.next();
        const tookFire = roll < CONTESTED_UNLOAD_FAILURE_THRESHOLD;
        const success = mode === 'always_land' || !tookFire;
        const rawLoss = Math.max(1, Math.floor(army.members * CONTESTED_UNLOAD_LOSS_FRACTION));
        const membersLoss = tookFire ? Math.min(army.members, rawLoss) : 0;
        const conditionLoss = tookFire ? CONTESTED_UNLOAD_CONDITION_LOSS : 0;

        outcomes.set(army.id, { tookFire, strengthLoss: membersLoss, success });

        if (mode === 'abort') {
            if (success) {
                succeeded.push(army.id);
                return {
                    ...army,
                    members: Math.max(0, army.members - membersLoss),
                    condition: Math.max(0, Math.min(1, army.condition - conditionLoss)),
                    state: ArmyState.DEPLOYED,
                    containerId: targetPlanetId ?? army.containerId
                };
            }
            failed.push(army.id);
            return {
                ...army,
                members: Math.max(0, army.members - membersLoss),
                condition: Math.max(0, Math.min(1, army.condition - conditionLoss))
            };
        }

        succeeded.push(army.id);
        return {
            ...army,
            members: Math.max(0, army.members - membersLoss),
            condition: Math.max(0, Math.min(1, army.condition - conditionLoss))
        };
    });

    const logs: LogEntry[] = [];
    const locationLabel = planetName ?? systemName;

    targetArmyIds.forEach(armyId => {
        const outcome = outcomes.get(armyId);
        if (!outcome) return;

        if (mode === 'always_land') {
            const text = outcome.tookFire
                ? `Dropships took fire while unloading army ${armyId} at ${locationLabel}, losing ${outcome.strengthLoss} strength.`
                : `Army ${armyId} dodged enemy fire while unloading at ${locationLabel}.`;
            logs.push({
                id: rng.id('log'),
                day,
                text,
                type: 'combat'
            });
        } else if (!outcome.success) {
            logs.push({
                id: rng.id('log'),
                day,
                text: `Dropships took fire while deploying army ${armyId} at ${locationLabel}, losing ${outcome.strengthLoss} strength and aborting landing.`,
                type: 'combat'
            });
        }
    });

    return { armies: updatedArmies, logs, succeeded, failed };
};
