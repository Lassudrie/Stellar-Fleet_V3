import { Army, ArmyState, FactionId, Fleet, FleetState, GameState, ShipType, StarSystem } from '../types';
import { distSq } from './math/vec3';
import {
  ORBIT_PROXIMITY_RANGE_SQ,
  ORBITAL_BOMBARDMENT_POWER_PER_SHIP,
  ORBITAL_BOMBARDMENT_STRENGTH_LOSS_PER_POWER,
  ORBITAL_BOMBARDMENT_MAX_STRENGTH_LOSS_FRACTION,
  ORBITAL_BOMBARDMENT_MORALE_LOSS_PER_POWER,
  ORBITAL_BOMBARDMENT_MAX_MORALE_LOSS_FRACTION,
  ORBITAL_BOMBARDMENT_MIN_MORALE,
  ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER
} from '../data/static';
import { ARMY_DESTROY_THRESHOLD } from './army';

export interface OrbitalBombardmentTarget {
  systemId: string;
  systemName: string;
  planetId: string;
  planetName: string;
  attackerFactionId: FactionId;
  bombardmentPower: number;
  targetArmies: Army[];
}

export interface OrbitalBombardmentResult {
  updates: Map<string, { strength: number; morale: number }>;
  logs: string[];
  bombardedPlanetIds: Set<string>;
}

const getFactionLabel = (state: GameState, factionId: FactionId): string => {
  const faction = state.factions.find(entry => entry.id === factionId);
  return faction?.name ?? factionId.toUpperCase();
};

const isFleetInSystem = (fleet: Fleet, system: StarSystem): boolean =>
  distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ;

const countBombardmentShips = (fleet: Fleet): number =>
  fleet.ships.filter(ship => ship.type !== ShipType.TROOP_TRANSPORT).length;

const getBombardmentPower = (fleets: Fleet[]): number => {
  const shipCount = fleets.reduce((sum, fleet) => sum + countBombardmentShips(fleet), 0);
  return shipCount * ORBITAL_BOMBARDMENT_POWER_PER_SHIP;
};

const clampFraction = (value: number, max: number): number => Math.min(max, Math.max(0, value));

export const getOrbitalBombardmentTargets = (
  system: StarSystem,
  armies: Army[],
  fleets: Fleet[]
): OrbitalBombardmentTarget[] => {
  const fleetsInSystem = fleets.filter(fleet => fleet.ships.length > 0 && isFleetInSystem(fleet, system));
  if (fleetsInSystem.length === 0) return [];

  const factionsInSystem = new Set(fleetsInSystem.map(fleet => fleet.factionId));
  if (factionsInSystem.size !== 1) return [];

  const attackerFactionId = Array.from(factionsInSystem)[0] as FactionId;
  const bombardmentFleets = fleetsInSystem.filter(
    fleet => fleet.factionId === attackerFactionId && fleet.state === FleetState.ORBIT && countBombardmentShips(fleet) > 0
  );
  if (bombardmentFleets.length === 0) return [];

  const bombardmentPower = getBombardmentPower(bombardmentFleets);
  if (bombardmentPower <= 0) return [];

  const solidPlanets = system.planets
    .filter(planet => planet.isSolid)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  if (solidPlanets.length === 0) return [];

  const planetIds = new Set(solidPlanets.map(planet => planet.id));
  const armiesByPlanetId = new Map<string, Army[]>();

  armies.forEach(army => {
    if (army.state !== ArmyState.DEPLOYED) return;
    if (army.factionId === attackerFactionId) return;
    if (!planetIds.has(army.containerId)) return;
    const list = armiesByPlanetId.get(army.containerId) ?? [];
    list.push(army);
    armiesByPlanetId.set(army.containerId, list);
  });

  const targets: OrbitalBombardmentTarget[] = [];

  solidPlanets.forEach(planet => {
    const targetArmies = armiesByPlanetId.get(planet.id);
    if (!targetArmies || targetArmies.length === 0) return;
    targets.push({
      systemId: system.id,
      systemName: system.name,
      planetId: planet.id,
      planetName: planet.name,
      attackerFactionId,
      bombardmentPower,
      targetArmies: [...targetArmies].sort((a, b) => a.id.localeCompare(b.id))
    });
  });

  return targets;
};

export const getBombardedPlanetIdsForSystem = (
  system: StarSystem,
  armies: Army[],
  fleets: Fleet[]
): Set<string> => {
  const targets = getOrbitalBombardmentTargets(system, armies, fleets);
  return new Set(targets.map(target => target.planetId));
};

const applyBombardment = (
  target: OrbitalBombardmentTarget
): { updates: { armyId: string; strength: number; morale: number }[]; strengthLost: number; moraleLossFraction: number } => {
  const strengthLossFraction = clampFraction(
    target.bombardmentPower * ORBITAL_BOMBARDMENT_STRENGTH_LOSS_PER_POWER,
    ORBITAL_BOMBARDMENT_MAX_STRENGTH_LOSS_FRACTION
  );
  const moraleLossFraction = clampFraction(
    target.bombardmentPower * ORBITAL_BOMBARDMENT_MORALE_LOSS_PER_POWER,
    ORBITAL_BOMBARDMENT_MAX_MORALE_LOSS_FRACTION
  );

  const sortedArmies = target.targetArmies;
  const totalStrength = sortedArmies.reduce((sum, army) => sum + army.strength, 0);
  const totalStrengthLoss = Math.floor(totalStrength * strengthLossFraction);

  let remainingLoss = totalStrengthLoss;
  let appliedLoss = 0;
  const updates: { armyId: string; strength: number; morale: number }[] = [];

  sortedArmies.forEach((army, index) => {
    const minStrength = ARMY_DESTROY_THRESHOLD(army.maxStrength) + ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER;
    const maxLoss = Math.max(0, army.strength - minStrength);
    const isLast = index === sortedArmies.length - 1;
    const proportionalLoss = isLast
      ? remainingLoss
      : totalStrength > 0
        ? Math.floor((totalStrengthLoss * army.strength) / totalStrength)
        : 0;
    const loss = Math.min(maxLoss, Math.max(0, proportionalLoss));
    const newStrength = army.strength - loss;
    remainingLoss -= loss;
    appliedLoss += loss;

    const newMorale = Math.max(ORBITAL_BOMBARDMENT_MIN_MORALE, army.morale * (1 - moraleLossFraction));
    updates.push({ armyId: army.id, strength: newStrength, morale: newMorale });
  });

  return { updates, strengthLost: appliedLoss, moraleLossFraction };
};

export const resolveOrbitalBombardment = (state: GameState): OrbitalBombardmentResult => {
  const updates = new Map<string, { strength: number; morale: number }>();
  const logs: string[] = [];
  const bombardedPlanetIds = new Set<string>();

  state.systems.forEach(system => {
    const targets = getOrbitalBombardmentTargets(system, state.armies, state.fleets);
    if (targets.length === 0) return;

    targets.forEach(target => {
      const { updates: localUpdates, strengthLost, moraleLossFraction } = applyBombardment(target);
      localUpdates.forEach(update => {
        updates.set(update.armyId, { strength: update.strength, morale: update.morale });
      });

      bombardedPlanetIds.add(target.planetId);

      const attackerLabel = getFactionLabel(state, target.attackerFactionId);
      const moraleLossPercent = (moraleLossFraction * 100).toFixed(1);
      logs.push(
        `Orbital bombardment at ${target.planetName} (${target.systemName}) by ${attackerLabel}: -${strengthLost} strength, -${moraleLossPercent}% morale.`
      );
    });
  });

  return { updates, logs, bombardedPlanetIds };
};
