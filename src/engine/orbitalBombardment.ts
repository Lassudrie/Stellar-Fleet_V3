import { Army, ArmyState, FactionId, Fleet, FleetState, GameState, GroundBuilding, ShipType, StarSystem } from '../shared/shared';
import {
  ORBITAL_BOMBARDMENT_POWER_PER_SHIP,
  ORBITAL_BOMBARDMENT_STRENGTH_LOSS_PER_POWER,
  ORBITAL_BOMBARDMENT_MAX_STRENGTH_LOSS_FRACTION,
  ORBITAL_BOMBARDMENT_MORALE_LOSS_PER_POWER,
  ORBITAL_BOMBARDMENT_MAX_MORALE_LOSS_FRACTION,
  ORBITAL_BOMBARDMENT_MIN_MORALE,
  ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER
} from '../content/data/static';
import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import { isFleetWithinOrbitProximity } from './orbit';
import { sorted } from '../shared/shared';
import { AO_COEFF } from './ground';
import { resolveSurfaceTileId } from './planetSurface';

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
  updates: Map<string, { members: number; morale: number }>;
  logs: string[];
  bombardedPlanetIds: Set<string>;
  bombardedTileIdsByBodyId: Record<string, number[]>;
}

const getFactionLabel = (state: GameState, factionId: FactionId): string => {
  const faction = state.factions.find(entry => entry.id === factionId);
  return faction?.name ?? factionId.toUpperCase();
};

const isFleetInSystem = (fleet: Fleet, system: StarSystem): boolean =>
  isFleetWithinOrbitProximity(fleet, system);

const countBombardmentShips = (fleet: Fleet): number =>
  fleet.ships.filter(ship => ship.type !== ShipType.TRANSPORTER).length;

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

  const solidPlanets = sorted(
    system.planets.filter(planet => planet.isSolid),
    (a, b) => a.id.localeCompare(b.id)
  );

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
      targetArmies: sorted(targetArmies, (a, b) => a.id.localeCompare(b.id))
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

const DEFAULT_BUNKER_ANTI_ORBITAL = 1;

const getArmyAntiOrbital = (army: Army): number => {
  const stats = GROUND_UNIT_STATS[army.unitType];
  const rating = stats?.antiOrbital ?? 0;
  if (rating <= 0) return 0;
  const ratio = army.maxMembers > 0 ? army.members / army.maxMembers : 0;
  return Math.max(0, rating * ratio);
};

const getBuildingAntiOrbital = (building: GroundBuilding): number => {
  if (Number.isFinite(building.antiOrbital)) return Math.max(0, building.antiOrbital ?? 0);
  if (building.tags?.includes('anti_orbital')) return DEFAULT_BUNKER_ANTI_ORBITAL;
  if (building.type === 'bunker') return DEFAULT_BUNKER_ANTI_ORBITAL;
  return 0;
};

const computeAntiOrbitalProjection = (
  bodyId: string,
  armies: Army[],
  buildings: GroundBuilding[]
): number => {
  let total = 0;
  armies.forEach(army => {
    total += getArmyAntiOrbital(army);
  });
  buildings.forEach(building => {
    if (building.surfacePos.bodyId !== bodyId) return;
    total += getBuildingAntiOrbital(building);
  });
  return total;
};

const applyBombardment = (
  target: OrbitalBombardmentTarget,
  mitigation: number
): { updates: { armyId: string; members: number; morale: number }[]; membersLost: number; moraleLossFraction: number } => {
  const strengthLossFraction = clampFraction(
    target.bombardmentPower * ORBITAL_BOMBARDMENT_STRENGTH_LOSS_PER_POWER * mitigation,
    ORBITAL_BOMBARDMENT_MAX_STRENGTH_LOSS_FRACTION
  );
  const moraleLossFraction = clampFraction(
    target.bombardmentPower * ORBITAL_BOMBARDMENT_MORALE_LOSS_PER_POWER * mitigation,
    ORBITAL_BOMBARDMENT_MAX_MORALE_LOSS_FRACTION
  );

  const sortedArmies = target.targetArmies;
  const totalMembers = sortedArmies.reduce((sum, army) => sum + army.members, 0);
  const totalMembersLoss = Math.floor(totalMembers * strengthLossFraction);

  let remainingLoss = totalMembersLoss;
  let appliedLoss = 0;
  const updates: { armyId: string; members: number; morale: number }[] = [];

  sortedArmies.forEach((army, index) => {
    // Legacy buffer retained as a safety margin to avoid erasing tiny remnants too easily.
    // With the new out-of-combat rules, units can still be removed later by cleanup.
    const minMembers = Math.max(0, ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER);
    const maxLoss = Math.max(0, army.members - minMembers);
    const isLast = index === sortedArmies.length - 1;
    const proportionalLoss = isLast
      ? remainingLoss
      : totalMembers > 0
        ? Math.floor((totalMembersLoss * army.members) / totalMembers)
        : 0;
    const loss = Math.min(maxLoss, Math.max(0, proportionalLoss));
    const newMembers = army.members - loss;
    remainingLoss -= loss;
    appliedLoss += loss;

    const newMorale = Math.max(ORBITAL_BOMBARDMENT_MIN_MORALE, army.morale * (1 - moraleLossFraction));
    updates.push({ armyId: army.id, members: newMembers, morale: newMorale });
  });

  return { updates, membersLost: appliedLoss, moraleLossFraction };
};

export const resolveOrbitalBombardment = (state: GameState): OrbitalBombardmentResult => {
  const updates = new Map<string, { members: number; morale: number }>();
  const logs: string[] = [];
  const bombardedPlanetIds = new Set<string>();
  const bombardedTileIdsByBodyId = new Map<string, Set<number>>();
  const buildings = state.groundBuildings ?? [];

  const markBombardedTile = (bodyId: string, tileId: number) => {
    const byBody = bombardedTileIdsByBodyId.get(bodyId) ?? new Set<number>();
    byBody.add(tileId);
    bombardedTileIdsByBodyId.set(bodyId, byBody);
  };

  state.systems.forEach(system => {
    const targets = getOrbitalBombardmentTargets(system, state.armies, state.fleets);
    if (targets.length === 0) return;

    targets.forEach(target => {
      const antiOrbitalProjection = computeAntiOrbitalProjection(target.planetId, target.targetArmies, buildings);
      const mitigation = 1 / (1 + AO_COEFF * antiOrbitalProjection);
      const { updates: localUpdates, membersLost, moraleLossFraction } = applyBombardment(target, mitigation);
      localUpdates.forEach(update => {
        updates.set(update.armyId, { members: update.members, morale: update.morale });
      });

      bombardedPlanetIds.add(target.planetId);

      const attackerLabel = getFactionLabel(state, target.attackerFactionId);
      const moraleLossPercent = (moraleLossFraction * 100).toFixed(1);
      logs.push(
        `Orbital bombardment at ${target.planetName} (${target.systemName}) by ${attackerLabel}: -${membersLost} members, -${moraleLossPercent}% morale.`
      );

      target.targetArmies.forEach(army => {
        if (!army.surfacePos) return;
        const descriptor = state.planetSurfaceDescriptorsByBodyId?.[target.planetId];
        if (!descriptor) return;
        const tileId = resolveSurfaceTileId(descriptor, army.surfacePos);
        if (tileId === null) return;
        markBombardedTile(target.planetId, tileId);
      });
    });
  });

  const bombardedTileIds: Record<string, number[]> = {};
  bombardedTileIdsByBodyId.forEach((tiles, bodyId) => {
    const list = sorted(Array.from(tiles.values()), (a, b) => a - b);
    bombardedTileIds[bodyId] = list;
  });

  return { updates, logs, bombardedPlanetIds, bombardedTileIdsByBodyId: bombardedTileIds };
};
