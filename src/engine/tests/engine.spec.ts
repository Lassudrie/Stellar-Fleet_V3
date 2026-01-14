import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolveGroundConflict } from '../conquest';
import { sanitizeArmies } from '../army';
import { CAPTURE_RANGE, CAPTURE_RANGE_SQ, COLORS, ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER, ORBIT_PROXIMITY_RANGE_SQ } from '../../content/data/static';
import { GROUND_UNIT_STATS } from '../../content/data/groundUnits';
import { detectNewBattles, resolveBattle } from '../battle';
import { SHIP_STATS } from '../../content/data/static';
import { AI_HOLD_TURNS, createEmptyAIState, planAiTurn } from '../ai';
import { applyCommand, GameCommand } from '../commands';
import {
  Army,
  ArmyState,
  Battle,
  GameMessage,
  FactionId,
  FactionState,
  Fleet,
  FleetState,
  GameObjectives,
  GameplayRules,
  GameState,
  FeatureBits,
  PlanetBody,
  PlanetData,
  PlanetSurfaceMap,
  AIState,
  ShipEntity,
  ShipType,
  StarSystem,
  SurfacePos
} from '../../shared/shared';
import { shortId } from '../../shared/shared';
import { Vec3 } from '../math/vec3';
import { GameEngine } from '../GameEngine';
import { runTurn } from '../runTurn';
import { RNG } from '../rng';
import type { TurnContext } from '../runTurn';
import { phaseBattleResolution, phaseCleanup, phaseGround, phaseBattleDetection, phaseMovement, phaseOrbitalBombardment } from '../runTurn';
import ts from 'typescript';
import { getTerritoryOwner } from '../territory';
import { resolveBattleOutcome, FactionRegistry } from '../battle';
import { checkVictoryConditions } from '../objectives';
import { deserializeGameState, serializeGameState } from '../serialization';
import { resolveFleetMovement } from '../movement';
import { areFleetsSharingOrbit, isFleetOrbitingSystem, isFleetWithinOrbitProximity, isOrbitContested } from '../orbit';
import { assignMoonAtmosphere, assignPlanetAtmosphere, generateStellarSystem } from '../worldgen/stellarSystem';
import { findNearestSystem } from '../world';
import { FuelShortageError, quantizeFuel } from '../logistics/fuel';
import { applyFogOfWar, defaultFleetSensors, isFleetVisibleToViewer } from '../fogOfWar';
import { SpatialIndex } from '../spatialIndex';
import { deepFreezeDev } from '../state';
import { buildPlanetBodies } from '../planets';
import {
  axialToIndex,
  buildGeodesicGrid,
  createPlanetSurfaceDescriptor,
  deriveSurfaceParamsFromPlanet,
  fnv1a32,
  generateSurfaceMap,
  generateSurfaceMapForState,
  getSurfaceTileCoordFromId,
  getSurfaceTileCount,
  neighborsAxial,
  resolveSurfaceTileId,
  tileCount
} from '../planetSurface';
import {
  BOMBARD_COMBAT_CONDITION_LOSS,
  BOMBARD_COMBAT_MULT,
  BREAK_THRESHOLD,
  LANDING_BASE,
  ORBIT_CONTESTED_LANDING_PENALTY,
  PREPARED_DEFENSE_MULT,
  RALLY_THRESHOLD,
  computeKBreakdown,
  deriveRoutedAfterMorale,
  deriveTerrainType,
  lineOfSight,
  previewEngagement,
  resolveEngagement,
  rollTriangularCentered
} from '../ground';
import { RNG_SEED_1_SEQUENCE } from './fixtures/rngSequence';
import { RNG_GAUSSIAN_SEED_1_SEQUENCE } from './fixtures/rngGaussianSequence';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: COLORS.blue, isPlayable: true },
  { id: 'red', name: 'Red', color: COLORS.red, isPlayable: true },
  { id: 'green', name: 'Green', color: '#10b981', isPlayable: false, aiProfile: 'aggressive' }
];

const baseVec: Vec3 = { x: 0, y: 0, z: 0 };

const TEST_MEMBER_SCALE = 0.1;

const scaleMembers = (members: number): number =>
  members === 0 ? 0 : Math.max(1, Math.floor(members * TEST_MEMBER_SCALE));

const createPlanet = (systemId: string, ownerFactionId: string | null, index = 1): PlanetBody => ({
  id: `planet-${systemId}-${index}`,
  systemId,
  name: `${systemId} ${index}`,
  bodyType: 'planet',
  class: 'solid',
  ownerFactionId,
  size: 1,
  isSolid: true
});

const createSystem = (id: string, ownerFactionId: string | null): StarSystem => ({
  id,
  name: id,
  position: baseVec,
  color: ownerFactionId === 'blue' ? COLORS.blue : ownerFactionId === 'red' ? COLORS.red : COLORS.star,
  size: 1,
  ownerFactionId,
  resourceType: 'none',
  isHomeworld: false,
  planets: [createPlanet(id, ownerFactionId)]
});

type TestShipInput = Omit<ShipEntity, 'fuel'> & Partial<Pick<ShipEntity, 'fuel'>>;

const withFuel = (ship: TestShipInput): ShipEntity => {
  const stats = SHIP_STATS[ship.type];
  const fuel = ship.fuel ?? stats?.fuelCapacity ?? 0;
  return { ...ship, fuel };
};

const createFleet = (id: string, factionId: string, position: Vec3, ships: TestShipInput[]): Fleet => ({
  id,
  factionId,
  ships: ships.map(withFuel),
  position,
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

const createArmy = (
  id: string,
  factionId: string,
  members: number,
  state: ArmyState,
  containerId: string
): Army => {
  const scaledMembers = scaleMembers(members);
  const stats = GROUND_UNIT_STATS.mechanized_infantry;
  return {
    id,
    factionId,
    unitType: 'mechanized_infantry',
    posture: 'normal',
    maxMembers: scaledMembers,
    members: scaledMembers,
    attack: 1,
    defense: 1,
    condition: 1,
    morale: stats.baseMorale,
    fatigue: stats.baseFatigue,
    rangeMin: stats.rangeMin,
    rangeMax: stats.rangeMax,
    projectionRange: stats.projectionRange,
    state,
    containerId
  };
};

type GroundDefaultsInput = Omit<Army, 'morale' | 'fatigue' | 'rangeMin' | 'rangeMax' | 'projectionRange'> &
  Partial<Pick<Army, 'morale' | 'fatigue' | 'rangeMin' | 'rangeMax' | 'projectionRange'>>;

const withGroundDefaults = (army: GroundDefaultsInput): Army => {
  const stats = GROUND_UNIT_STATS[army.unitType];
  return {
    ...army,
    morale: army.morale ?? stats.baseMorale,
    fatigue: army.fatigue ?? stats.baseFatigue,
    rangeMin: army.rangeMin ?? stats.rangeMin,
    rangeMax: army.rangeMax ?? stats.rangeMax,
    projectionRange: army.projectionRange ?? stats.projectionRange
  };
};

const createBaseState = (overrides: Partial<GameState>): GameState => {
  const defaultRules: GameplayRules = {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: false,
    unlimitedFuel: false
  };

  const defaultObjectives: GameObjectives = {
    conditions: []
  };

  const { rules = defaultRules, objectives = defaultObjectives, ...restOverrides } = overrides;

  return {
    scenarioId: 'test',
    playerFactionId: 'blue',
    factions,
    seed: 1,
    rngState: 1,
    startYear: 0,
    day: 0,
    systems: [],
    fleets: [],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: [],
    selectedFleetId: null,
    winnerFactionId: null,
    objectives,
    rules,
    ...restOverrides
  };
};

const getFactionColor = (factionId: FactionId | null): string =>
  factions.find(faction => faction.id === factionId)?.color ?? COLORS.star;

const findSystemWithSolidBodies = (params: {
  systemId: string;
  seed: number;
  minSolids: number;
  ownerFactionId: FactionId | null;
  resourceType?: StarSystem['resourceType'];
  settlementConfig?: Parameters<typeof createPlanetSurfaceDescriptor>[0]['settlementConfig'];
}): {
  worldSeed: number;
  system: StarSystem;
  solidBodies: PlanetBody[];
  descriptors: Record<string, ReturnType<typeof createPlanetSurfaceDescriptor>>;
} => {
  for (let offset = 0; offset < 25; offset += 1) {
    const worldSeed = params.seed + offset;
    const astro = generateStellarSystem({ worldSeed, systemId: params.systemId });
    const system: StarSystem = {
      id: params.systemId,
      name: params.systemId,
      position: baseVec,
      color: getFactionColor(params.ownerFactionId),
      size: 1,
      ownerFactionId: params.ownerFactionId,
      resourceType: params.resourceType ?? 'none',
      isHomeworld: false,
      astro,
      planets: []
    };
    system.planets = buildPlanetBodies({ id: system.id, name: system.name, ownerFactionId: system.ownerFactionId }, astro, []);
    const solidBodies = system.planets.filter(body => body.isSolid);
    if (solidBodies.length < params.minSolids) continue;

    const descriptors: Record<string, ReturnType<typeof createPlanetSurfaceDescriptor>> = {};
    solidBodies.forEach(body => {
      descriptors[body.id] = createPlanetSurfaceDescriptor({
        gameSeed: worldSeed,
        systemId: params.systemId,
        body,
        settlementConfig: params.settlementConfig
      });
    });

    return { worldSeed, system, solidBodies, descriptors };
  }

  throw new Error(`Unable to find system with ${params.minSolids} solid bodies for ${params.systemId}`);
};

const getSurfaceMapOrThrow = (state: GameState, bodyId: string): PlanetSurfaceMap => {
  const map = generateSurfaceMapForState(state, bodyId);
  assert.ok(map, `Expected surface map for ${bodyId}`);
  return map;
};

const createArmiesOnSettlements = (params: {
  map: PlanetSurfaceMap;
  factionId: FactionId;
  baseId: string;
  members: number;
}): Army[] => {
  assert.ok(params.map.settlements.length > 0, `Expected settlements on ${params.map.bodyId}`);
  return params.map.settlements.map((settlement, index) =>
    withGroundDefaults({
      id: `${params.baseId}-${index}`,
      factionId: params.factionId,
      unitType: 'mechanized_infantry',
      posture: 'normal',
      maxMembers: scaleMembers(params.members),
      members: scaleMembers(params.members),
      attack: 1,
      defense: 1,
      condition: 1,
      state: ArmyState.DEPLOYED,
      containerId: params.map.bodyId,
      surfacePos: settlement.coord
        ? { bodyId: params.map.bodyId, tileId: settlement.tileId, q: settlement.coord.q, r: settlement.coord.r }
        : { bodyId: params.map.bodyId, tileId: settlement.tileId }
    })
  );
};

const tests: TestCase[] = [
  {
    name: 'Battle resolution preserves generic faction winners',
    run: () => {
      const alpha: FactionState = { id: 'alpha', name: 'Alpha', color: '#aaaaaa', isPlayable: true };
      const beta: FactionState = { id: 'beta', name: 'Beta', color: '#bbbbbb', isPlayable: true };

      const alphaFleet = createFleet('fleet-alpha', alpha.id, { ...baseVec }, [
        { id: 'alpha-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null },
        { id: 'alpha-2', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const betaFleet = createFleet('fleet-beta', beta.id, { ...baseVec }, [
        { id: 'beta-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const battle: Battle = {
        id: 'battle-alpha-beta',
        systemId: 'sys-alpha-beta',
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [alphaFleet.id, betaFleet.id],
        logs: []
      };

      const state = createBaseState({
        factions: [alpha, beta],
        systems: [createSystem(battle.systemId, null)],
        fleets: [alphaFleet, betaFleet],
        seed: 1
      });

      const { updatedBattle } = resolveBattle(battle, state, 0);

      assert.strictEqual(updatedBattle.winnerFactionId, 'alpha', 'Winner should match computed surviving faction id');
    }
  },
  {
    name: 'Battle resolution uses the context turn for dating effects',
    run: () => {
      const system = createSystem('sys-turn-sync', null);
      const attackerShip: TestShipInput = {
        id: 'attacker-sync',
        type: ShipType.CRUISER,
        hp: 120,
        maxHp: 120,
        carriedArmyId: null
      };
      const defenderShip: TestShipInput = {
        id: 'defender-sync',
        type: ShipType.FIGHTER,
        hp: 1,
        maxHp: 1,
        carriedArmyId: null
      };

      const attackerFleet = createFleet('fleet-turn-attacker', 'blue', { ...baseVec }, [attackerShip]);
      const defenderFleet = createFleet('fleet-turn-defender', 'red', { ...baseVec }, [defenderShip]);

      const battle: Battle = {
        id: 'battle-turn-sync',
        systemId: system.id,
        turnCreated: 2,
        status: 'scheduled',
        involvedFleetIds: [attackerFleet.id, defenderFleet.id],
        logs: []
      };

      const state = createBaseState({
        day: 2,
        seed: 12,
        systems: [system],
        fleets: [attackerFleet, defenderFleet],
        battles: [battle]
      });

      const ctx = { rng: new RNG(42), turn: 5 };
      const resolved = phaseBattleResolution(state, ctx);
      const survivingFleet = resolved.fleets.find(fleet => fleet.id === attackerFleet.id);
      const survivingShip = survivingFleet?.ships.find(ship => ship.id === attackerShip.id);

      assert.ok(survivingShip, 'Attacking ship should survive the combat');

      const killHistory = survivingShip?.killHistory ?? [];
      assert.ok(killHistory.length > 0, 'Kill history should record the destroyed defender');
      killHistory.forEach(record => {
        assert.strictEqual(record.day, ctx.turn, 'Kill day must match the context turn');
        assert.strictEqual(record.turn, ctx.turn, 'Kill turn must match the context turn');
      });
    }
  },
  {
    name: 'Battle winner is decided before post-combat attrition',
    run: () => {
      const system = createSystem('sys-attrition-winner', 'blue');
      const fragileBlueShip: TestShipInput = {
        id: 'blue-fragile',
        type: ShipType.CRUISER,
        maxHp: 20,
        hp: 10,
        carriedArmyId: null
      };

      const blueFleet = createFleet('fleet-attrition-blue', 'blue', { ...baseVec }, [fragileBlueShip]);

      const battle: Battle = {
        id: 'battle-attrition-winner',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueFleet.id],
        logs: []
      };

      const state = createBaseState({ systems: [system], fleets: [blueFleet], battles: [battle] });

      const { updatedBattle, survivingFleets } = resolveBattle(battle, state, 0);

      assert.strictEqual(updatedBattle.winnerFactionId, 'blue', 'Solo combat should still mark the owner as winner before attrition.');
      const survivorIds = updatedBattle.survivorShipIds ?? [];
      assert.strictEqual(survivorIds.length, 0, 'Attrition can eliminate remaining ships after victory calculation.');
      assert.strictEqual(survivingFleets.length, 0, 'No fleets should persist if attrition destroys the last ship.');
    }
  },
  {
    name: 'Astro payload survives save/load and regenerates when absent',
    run: () => {
      const systemWithAstro = { ...createSystem('sys-astro', null), astro: generateStellarSystem({ worldSeed: 7, systemId: 'sys-astro' }) };
      const expectedAstro = generateStellarSystem({ worldSeed: 99, systemId: 'sys-regen' });

      const withAstroState = createBaseState({
        systems: [systemWithAstro],
        factions,
        seed: 7
      });
      const roundTrip = deserializeGameState(serializeGameState(withAstroState));
      assert.deepStrictEqual(roundTrip.systems[0].astro, systemWithAstro.astro, 'Astro data must persist through serialization');

      const missingAstroState = createBaseState({
        systems: [createSystem('sys-regen', null)],
        factions,
        seed: 99
      });
      const restored = deserializeGameState(serializeGameState(missingAstroState));
      assert.deepStrictEqual(restored.systems[0].astro, expectedAstro, 'Astro data must be regenerated when missing');
    }
  },
  {
    name: 'ORDER_LOAD_MOVE applique le chargement après un runTurn',
    run: () => {
      const system = createSystem('sys-load-runturn', 'blue');
      const transport: TestShipInput = {
        id: 'blue-transport-runturn',
        type: ShipType.TRANSPORTER,
        hp: 40,
        maxHp: 40,
        carriedArmyId: null
      };

      const fleet = createFleet('fleet-blue-runturn', 'blue', { ...baseVec }, [transport]);
      const army = createArmy('army-blue-runturn', 'blue', 12000, ArmyState.DEPLOYED, system.planets[0].id);

      const initialState = createBaseState({ systems: [system], fleets: [fleet], armies: [army] });
      const withOrder = applyCommand(
        initialState,
        { type: 'ORDER_LOAD_MOVE', fleetId: fleet.id, targetSystemId: system.id },
        new RNG(3)
      ).state;

      const result = runTurn(withOrder, new RNG(3));
      const updatedArmy = result.armies.find(a => a.id === army.id);
      const updatedFleet = result.fleets.find(f => f.id === fleet.id);
      const updatedTransport = updatedFleet?.ships.find(ship => ship.id === transport.id);

      assert.strictEqual(updatedArmy?.state, ArmyState.EMBARKED, 'L’armée doit être embarquée après la phase de mouvement');
      assert.strictEqual(
        updatedArmy?.containerId,
        fleet.id,
        'Le conteneur de l’armée doit être la flotte qui a exécuté l’ordre'
      );
      assert.strictEqual(
        updatedTransport?.carriedArmyId,
        army.id,
        'Le transport doit porter l’armée après le runTurn'
      );
      assert.strictEqual(
        updatedFleet?.loadTargetSystemId,
        null,
        'L’ordre de chargement doit être consommé pendant le runTurn'
      );
    }
  },
  {
    name: 'ORDER_LOAD ignore le chargement immédiat pour une flotte en transit',
    run: () => {
      const system = createSystem('sys-load-transit', 'blue');
      const transport: TestShipInput = {
        id: 'blue-transport-transit',
        type: ShipType.TRANSPORTER,
        hp: 40,
        maxHp: 40,
        carriedArmyId: null
      };

      const movingFleet: Fleet = {
        ...createFleet('fleet-blue-transit', 'blue', { ...baseVec }, [transport]),
        state: FleetState.MOVING,
        targetSystemId: system.id,
        targetPosition: { ...system.position }
      };

      const groundArmy = createArmy('army-blue-transit', 'blue', 6000, ArmyState.DEPLOYED, system.planets[0].id);

      const engine = new GameEngine(
        createBaseState({
          systems: [system],
          fleets: [movingFleet],
          armies: [groundArmy],
          seed: 5,
          rngState: 5
        })
      );

      const result = engine.dispatchPlayerCommand({
        type: 'ORDER_LOAD',
        fleetId: movingFleet.id,
        targetSystemId: system.id
      });

      const updatedFleet = engine.state.fleets.find(fleet => fleet.id === movingFleet.id);
      const updatedTransport = updatedFleet?.ships.find(ship => ship.id === transport.id);
      const updatedArmy = engine.state.armies.find(army => army.id === groundArmy.id);

      assert.strictEqual(result.ok, true, 'La commande doit être acceptée pour une flotte en mouvement');
      assert.strictEqual(
        updatedArmy?.state,
        ArmyState.DEPLOYED,
        'L’armée ne doit pas être embarquée tant que la flotte est en transit'
      );
      assert.strictEqual(
        updatedArmy?.containerId,
        system.planets[0].id,
        'L’armée doit rester sur la planète tant que le chargement n’est pas résolu en orbite'
      );
      assert.strictEqual(
        updatedTransport?.carriedArmyId,
        null,
        'Aucune unité ne doit être chargée immédiatement pendant le transit'
      );
      assert.strictEqual(
        updatedFleet?.loadTargetSystemId,
        system.id,
        'L’ordre de chargement doit être programmé pour résolution à l’arrivée'
      );
    }
  },
  {
    name: 'Battle resolution keeps victories for factions outside the core palette',
    run: () => {
      const greenFleet = createFleet('fleet-green-victory', 'green', { ...baseVec }, [
        { id: 'green-1', type: ShipType.CRUISER, hp: 80, maxHp: 80, carriedArmyId: null }
      ]);

      const blueFleet = createFleet('fleet-blue-empty', 'blue', { ...baseVec }, []);

      const battle: Battle = {
        id: 'battle-green-win',
        systemId: 'sys-green-win',
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [greenFleet.id, blueFleet.id],
        logs: []
      };

      const state = createBaseState({
        systems: [createSystem(battle.systemId, null)],
        fleets: [greenFleet, blueFleet],
        seed: 7
      });

      const { updatedBattle } = resolveBattle(battle, state, 0);

      assert.strictEqual(
        updatedBattle.winnerFactionId,
        'green',
        'Non-blue/red factions should remain credited for their victories'
      );
    }
  },
  {
    name: 'Territory ignores neutral systems when evaluating influence',
    run: () => {
      const neutralSystem = { ...createSystem('neutral', null), position: { x: 0, y: 0, z: 0 } };
      const ownedSystem = { ...createSystem('owned', 'blue'), position: { x: 20, y: 0, z: 0 } };

      const owner = getTerritoryOwner([neutralSystem, ownedSystem], { x: 1, y: 0, z: 0 });

      assert.strictEqual(owner, 'blue', 'Owned systems should be considered even if neutral space is closer');
    }
  },
  {
    name: 'Battle outcome reports non-player faction victories by name',
    run: () => {
      const translate = (key: string, params?: Record<string, string | number | undefined>) => {
        if (key === 'battle.victory') return `${params?.winner} VICTORY`;
        if (key === 'battle.draw') return 'DRAW';
        return 'RESULT UNKNOWN';
      };

      const registry: FactionRegistry = {
        blue: { name: 'Alliance Navy', color: '#3b82f6' },
        yellow: { name: 'Nomad League', color: '#facc15' }
      };

      const battle: Battle = {
        id: 'battle-outcome-1',
        systemId: 'sys-x',
        turnCreated: 1,
        status: 'resolved',
        involvedFleetIds: [],
        logs: [],
        winnerFactionId: 'yellow'
      };

      const outcome = resolveBattleOutcome(battle, 'blue', registry, translate);

      assert.strictEqual(outcome.status, 'defeat');
      assert.strictEqual(outcome.label, 'Nomad League VICTORY');
      assert.strictEqual(outcome.color, '#facc15');
      assert.strictEqual(outcome.winnerName, 'Nomad League');
    }
  },
  {
    name: 'Max turns victory triggers on the exact turn limit',
    run: () => {
      const playerFleet = createFleet('fleet-blue-turncap', 'blue', baseVec, [
        { id: 'blue-ship-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const stateAtTurnLimit = createBaseState({
        day: 4,
        fleets: [playerFleet],
        systems: [createSystem('sys-home', 'blue')],
        objectives: { maxTurns: 5, conditions: [{ type: 'survival' }] }
      });

      const nextState = runTurn(stateAtTurnLimit, new RNG(9));

      assert.strictEqual(nextState.day, 5, 'The turn counter should advance to the limit');
      assert.strictEqual(
        nextState.winnerFactionId,
        'blue',
        'Survival objectives should resolve as soon as the max turn is reached'
      );
    }
  },
  {
    name: 'Elimination requires destroying fleets and removing system ownership',
    run: () => {
      const redFleet = createFleet('fleet-red', 'red', baseVec, [
        { id: 'red-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const stateWithSystemsAndFleet = createBaseState({
        systems: [createSystem('sys-blue', 'blue'), createSystem('sys-red', 'red')],
        fleets: [redFleet]
      });

      const initialWinner = checkVictoryConditions(stateWithSystemsAndFleet);
      assert.strictEqual(initialWinner, null, 'Enemy systems should block elimination even without battles');

      const stateWithoutSystem = {
        ...stateWithSystemsAndFleet,
        systems: stateWithSystemsAndFleet.systems.map(system =>
          system.id === 'sys-red' ? { ...system, ownerFactionId: null } : system
        )
      };

      const winnerWithoutSystem = checkVictoryConditions(stateWithoutSystem);
      assert.strictEqual(winnerWithoutSystem, null, 'Enemy fleets should block elimination even after losing systems');

      const stateWithoutFleet = {
        ...stateWithoutSystem,
        fleets: stateWithoutSystem.fleets.filter(fleet => fleet.factionId !== 'red')
      };

      const finalWinner = checkVictoryConditions(stateWithoutFleet);
      assert.strictEqual(finalWinner, 'blue', 'Elimination should require destroying fleets and owning no systems');
    }
  },
  {
    name: 'Battle outcome handles draws without faction assumptions',
    run: () => {
      const translate = (key: string, _params?: Record<string, string | number | undefined>) =>
        (key === 'battle.draw' ? 'DRAW' : 'RESULT UNKNOWN');

      const registry: FactionRegistry = {
        blue: { name: 'Alliance Navy', color: '#3b82f6' }
      };

      const battle: Battle = {
        id: 'battle-outcome-2',
        systemId: 'sys-y',
        turnCreated: 2,
        status: 'resolved',
        involvedFleetIds: [],
        logs: [],
        winnerFactionId: 'draw'
      };

      const outcome = resolveBattleOutcome(battle, 'blue', registry, translate);

      assert.strictEqual(outcome.status, 'draw');
      assert.strictEqual(outcome.label, 'DRAW');
      assert.strictEqual(outcome.winnerName, null);
    }
  },
  {
    name: 'Equidistant factions contest territory deterministically',
    run: () => {
      const blueSystem = { ...createSystem('blue-core', 'blue'), position: { x: 10, y: 0, z: 0 } };
      const redSystem = { ...createSystem('red-core', 'red'), position: { x: -10, y: 0, z: 0 } };

      const owner = getTerritoryOwner([blueSystem, redSystem], { x: 0, y: 0, z: 0 });

      assert.strictEqual(owner, null, 'Equal influence from different factions should contest the territory');
    }
  },
  {
    name: 'findNearestSystem uses tolerance to break near ties deterministically',
    run: () => {
      const slightlyCloser = { ...createSystem('beta-near', null), position: { x: 1, y: 0, z: 0 } };
      const almostEqual = { ...createSystem('alpha-near', null), position: { x: 1 + 4e-7, y: 0, z: 0 } };

      const nearest = findNearestSystem([slightlyCloser, almostEqual], { x: 0, y: 0, z: 0 });

      assert.strictEqual(
        nearest?.id,
        'alpha-near',
        'Near ties should pick the lexicographically smaller ID when within the epsilon'
      );
    }
  },
  {
    name: 'Unopposed deployments skip combat resolution',
    run: () => {
      const system = createSystem('sys-1', 'red');

      const blueArmy = createArmy('army-blue', 'blue', 12000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [blueArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);
      assert.strictEqual(result, null, 'Unopposed armies should not generate combat resolution');
    }
  },
  {
    name: 'Orbit is only contested when multiple factions are present',
    run: () => {
      const system = createSystem('sys-2a', 'blue');

      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [
        { id: 'blue-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const stateWithSingleFaction = createBaseState({ systems: [system], fleets: [blueFleet] });
      assert.strictEqual(
        isOrbitContested(system, stateWithSingleFaction),
        false,
        'Single faction presence should not contest orbit'
      );

      const greenFleet = createFleet('fleet-green', 'green', { x: CAPTURE_RANGE - 1, y: 0, z: 0 }, [
        { id: 'green-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const stateWithTwoFactions = createBaseState({ systems: [system], fleets: [blueFleet, greenFleet] });
      assert.strictEqual(
        isOrbitContested(system, stateWithTwoFactions),
        true,
        'Different factions in range should contest orbit'
      );

      const emptyRedFleet = createFleet('fleet-red', 'red', { x: CAPTURE_RANGE - 1, y: 0, z: 0 }, []);
      const stateWithEmptyFleet = createBaseState({ systems: [system], fleets: [blueFleet, emptyRedFleet] });
      assert.strictEqual(
        isOrbitContested(system, stateWithEmptyFleet),
        false,
        'Fleets without ships should not contribute to contesting'
      );
    }
  },
  {
    name: 'Orbit proximity helpers enforce distance and state invariants',
    run: () => {
      const system = createSystem('sys-orbit-helpers', 'blue');
      const sharedShip: TestShipInput = { id: 'orbit-helper', type: ShipType.FIGHTER, hp: 30, maxHp: 30, carriedArmyId: null };

      const orbitingFleet = createFleet('fleet-orbiting-helpers', 'blue', { ...baseVec }, [sharedShip]);
      const movingFleet: Fleet = { ...orbitingFleet, id: 'fleet-moving-helpers', state: FleetState.MOVING };
      const offset = Math.sqrt(ORBIT_PROXIMITY_RANGE_SQ) + 1;
      const distantFleet = createFleet(
        'fleet-distant-helpers',
        'blue',
        { x: offset, y: 0, z: 0 },
        [{ ...sharedShip, id: 'orbit-helper-distant' }]
      );

      assert.ok(isFleetWithinOrbitProximity(orbitingFleet, system), 'Orbit proximity should be true at system position');
      assert.ok(
        !isFleetWithinOrbitProximity(distantFleet, system),
        'Orbit proximity should fail once outside the threshold'
      );
      assert.ok(isFleetOrbitingSystem(orbitingFleet, system), 'Orbiting state is required alongside proximity');
      assert.ok(!isFleetOrbitingSystem(movingFleet, system), 'Non-orbiting fleets should fail the orbiting check');
      assert.ok(
        areFleetsSharingOrbit(orbitingFleet, orbitingFleet),
        'Co-located orbiting fleets should share the same orbit envelope'
      );
      assert.ok(
        !areFleetsSharingOrbit(orbitingFleet, distantFleet),
        'Separated fleets should not be treated as sharing orbit'
      );
    }
  },
  {
    name: 'Gas extraction refuels fleets in safe orbit',
    run: () => {
      const gasSystem: StarSystem = { ...createSystem('sys-gas-safe', null), resourceType: 'gas' };
      const extractor: TestShipInput = {
        id: 'extractor-safe',
        type: ShipType.EXTRACTOR,
        hp: 50,
        maxHp: 50,
        fuel: 0,
        carriedArmyId: null
      };

      const blueFleet = createFleet('fleet-blue-extract', 'blue', { ...baseVec }, [extractor]);
      const state = createBaseState({ systems: [gasSystem], fleets: [blueFleet] });
      const ctx = { turn: state.day + 1, rng: new RNG(29) };

      const nextState = phaseCleanup(state, ctx);
      const updatedFleet = nextState.fleets.find(fleet => fleet.id === blueFleet.id);
      const updatedExtractor = updatedFleet?.ships.find(ship => ship.id === extractor.id);
      const baseFuel = extractor.fuel ?? 0;

      assert.ok(updatedExtractor, 'Extractor ship should persist after cleanup');
      assert.ok(updatedExtractor?.fuel !== undefined && updatedExtractor.fuel > baseFuel, 'Extractor should gain fuel when orbit is safe');
    }
  },
  {
    name: 'Gas extraction is blocked when enemies share gas orbit',
    run: () => {
      const gasSystem: StarSystem = { ...createSystem('sys-gas-block', null), resourceType: 'gas' };
      const extractor: TestShipInput = {
        id: 'extractor-block',
        type: ShipType.EXTRACTOR,
        hp: 50,
        maxHp: 50,
        fuel: 0,
        carriedArmyId: null
      };
      const blueFleet = createFleet('fleet-blue-block', 'blue', { ...baseVec }, [extractor]);
      const redFleet = createFleet('fleet-red-block', 'red', { ...baseVec }, [
        { id: 'red-ship-block', type: ShipType.FIGHTER, hp: 30, maxHp: 30, carriedArmyId: null }
      ]);

      const state = createBaseState({ systems: [gasSystem], fleets: [blueFleet, redFleet] });
      const ctx = { turn: state.day + 1, rng: new RNG(31) };

      const nextState = phaseCleanup(state, ctx);
      const updatedFleet = nextState.fleets.find(fleet => fleet.id === blueFleet.id);
      const updatedExtractor = updatedFleet?.ships.find(ship => ship.id === extractor.id);
      const baselineFuel = extractor.fuel ?? 0;

      assert.ok(updatedExtractor, 'Extractor ship should persist after contested cleanup');
      assert.strictEqual(
        updatedExtractor?.fuel,
        baselineFuel,
        'Extraction should not add fuel when enemy fleets contest the orbit'
      );
    }
  },
  {
    name: 'Orbital bombardment applies to all enemy planets in a secured system',
    run: () => {
      const system = createSystem('sys-bombard', 'blue');
      const secondPlanet = createPlanet(system.id, 'blue', 2);
      const systemWithTwo = { ...system, planets: [system.planets[0], secondPlanet] };

      const blueFleet = createFleet('fleet-blue-bombard', 'blue', { ...baseVec }, [
        { id: 'blue-bombard-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const redArmyA = createArmy('army-red-a', 'red', 12000, ArmyState.DEPLOYED, systemWithTwo.planets[0].id);
      const redArmyB = createArmy('army-red-b', 'red', 10000, ArmyState.DEPLOYED, systemWithTwo.planets[1].id);

      const state = createBaseState({
        systems: [systemWithTwo],
        fleets: [blueFleet],
        armies: [redArmyA, redArmyB]
      });
      const ctx = { turn: state.day + 1, rng: new RNG(11) };

      const nextState = phaseOrbitalBombardment(state, ctx);
      const updatedA = nextState.armies.find(army => army.id === redArmyA.id);
      const updatedB = nextState.armies.find(army => army.id === redArmyB.id);

      assert.ok(updatedA && updatedA.members < redArmyA.members, 'Bombardment should reduce members on planet 1');
      assert.ok(updatedB && updatedB.members < redArmyB.members, 'Bombardment should reduce members on planet 2');
      assert.ok(updatedA && updatedA.morale < redArmyA.morale, 'Bombardment should reduce morale on planet 1');
      assert.ok(updatedB && updatedB.morale < redArmyB.morale, 'Bombardment should reduce morale on planet 2');
      assert.ok(
        nextState.logs.some(log => log.text.includes('Orbital bombardment')),
        'Bombardment should log results'
      );
    }
  },
  {
    name: 'Orbital bombardment is blocked by enemy fleets in system',
    run: () => {
      const system = createSystem('sys-bombard-block', 'red');

      const blueFleet = createFleet('fleet-blue-block', 'blue', { ...baseVec }, [
        { id: 'blue-block-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);
      const redFleet = createFleet('fleet-red-block', 'red', { ...baseVec }, [
        { id: 'red-block-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const redArmy = createArmy('army-red-block', 'red', 12000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet, redFleet],
        armies: [redArmy]
      });
      const ctx = { turn: state.day + 1, rng: new RNG(13) };

      const nextState = phaseOrbitalBombardment(state, ctx);
      const updated = nextState.armies.find(army => army.id === redArmy.id);

      assert.strictEqual(updated?.members, redArmy.members, 'Contested orbit should prevent bombardment losses');
      assert.strictEqual(updated?.morale, redArmy.morale, 'Contested orbit should prevent morale loss');
    }
  },
  {
    name: 'Orbital bombardment requires uncontested orbital dominance',
    run: () => {
      const system = createSystem('sys-bombard-dominance', 'blue');

      const blueFleet = createFleet('fleet-blue-dominance', 'blue', { ...baseVec }, [
        { id: 'blue-dominance-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);
      const redFleet = createFleet('fleet-red-dominance', 'red', { ...baseVec }, [
        { id: 'red-dominance-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const redArmy = createArmy('army-red-dominance', 'red', 12000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet, redFleet],
        armies: [redArmy]
      });
      const ctx = { turn: state.day + 1, rng: new RNG(23) };

      const nextState = phaseOrbitalBombardment(state, ctx);
      const updated = nextState.armies.find(army => army.id === redArmy.id);

      assert.strictEqual(updated?.members, redArmy.members, 'Contested orbit should skip bombardment resolution');
      assert.strictEqual(updated?.morale, redArmy.morale, 'Contested orbit should leave morale unchanged');
      assert.strictEqual(
        nextState.logs.length,
        state.logs.length,
        'Contested orbit should not add bombardment logs'
      );
    }
  },
  {
    name: 'Troop transports alone cannot trigger orbital bombardment',
    run: () => {
      const system = createSystem('sys-bombard-transport', null);
      const transportFleet = createFleet('fleet-transport-only', 'blue', { ...baseVec }, [
        { id: 'blue-transport', type: ShipType.TRANSPORTER, hp: 2000, maxHp: 2000, carriedArmyId: null }
      ]);

      const redArmy = createArmy('army-red-transport', 'red', 12000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({
        systems: [system],
        fleets: [transportFleet],
        armies: [redArmy]
      });
      const ctx = { turn: state.day + 1, rng: new RNG(17) };

      const nextState = phaseOrbitalBombardment(state, ctx);
      const updated = nextState.armies.find(army => army.id === redArmy.id);

      assert.strictEqual(updated?.members, redArmy.members, 'Transport-only fleets should not bombard');
      assert.strictEqual(updated?.morale, redArmy.morale, 'Transport-only fleets should not affect morale');
    }
  },
  {
    name: 'Orbital bombardment does not reduce armies below destruction thresholds',
    run: () => {
      const system = createSystem('sys-bombard-floor', 'blue');
      const blueFleet = createFleet('fleet-blue-floor', 'blue', { ...baseVec }, [
        { id: 'blue-floor-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const minMembers = ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER;
      const redArmy = withGroundDefaults({
        id: 'army-red-floor',
        factionId: 'red',
        unitType: 'mechanized_infantry',
        posture: 'normal',
        maxMembers: scaleMembers(10000),
        members: minMembers,
        attack: 1,
        defense: 1,
        condition: 1,
        state: ArmyState.DEPLOYED,
        containerId: system.planets[0].id
      });

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet],
        armies: [redArmy]
      });
      const ctx = { turn: state.day + 1, rng: new RNG(19) };

      const nextState = phaseOrbitalBombardment(state, ctx);
      const updated = nextState.armies.find(army => army.id === redArmy.id);

      assert.ok(
        updated && updated.members >= minMembers,
        'Bombardment should not drop members below the minimum buffer'
      );
    }
  },
  {
    name: '1k vs 1k armies survive initial clash under new threshold',
    run: () => {
      const system = createSystem('sys-2', 'blue');
      const blueArmy = createArmy('army-blue-1k', 'blue', 10000, ArmyState.DEPLOYED, system.planets[0].id);
      const redArmy = createArmy('army-red-1k', 'red', 10000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);
      assert.ok(result, 'Ground conflict should resolve');
      assert.strictEqual(result?.winnerFactionId, 'draw', 'Balanced forces should stalemate');
      assert.deepStrictEqual(result?.armiesDestroyed, [], 'Units should not be auto-removed in the legacy resolver unless out of combat');

      const blueUpdate = result?.armyUpdates.find(update => update.armyId === blueArmy.id);
      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(blueUpdate && blueUpdate.members > 0, 'Blue army should survive with members remaining');
      assert.ok(redUpdate && redUpdate.members > 0, 'Red army should survive with members remaining');
    }
  },
  {
    name: 'Damaged attackers are still removed when defenders already own the system',
    run: () => {
      const system = createSystem('sys-5', 'blue');
      const blueArmy = createArmy('army-blue-hold', 'blue', 12000, ArmyState.DEPLOYED, system.planets[0].id);
      const redArmy = withGroundDefaults({
        id: 'army-red-broken',
        factionId: 'red',
        unitType: 'mechanized_infantry',
        posture: 'normal',
        maxMembers: scaleMembers(20000),
        members: scaleMembers(1500),
        attack: 1,
        defense: 1,
        condition: 0.19,
        state: ArmyState.DEPLOYED,
        containerId: system.planets[0].id
      });

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);
      assert.ok(result, 'Ground conflict should be reported even without conquest');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Defenders should be considered the winners');
      assert.ok(result?.armiesDestroyed.includes(redArmy.id), 'Damaged attackers should be destroyed');

      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(redUpdate, 'Red army should receive an update before removal');
      assert.ok(redUpdate!.members < redArmy.members, 'Red army should lose members from the fight');
    }
  },
  {
    name: 'Planet owner defends ground battles even when system owner differs',
    run: () => {
      const planet = createPlanet('sys-planet-def', 'red', 1);
      const system: StarSystem = {
        ...createSystem('sys-planet-def', 'blue'),
        planets: [planet]
      };

      const defendingArmy = createArmy('army-red-defender', 'red', 9000, ArmyState.DEPLOYED, planet.id);
      const attackingArmy = createArmy('army-blue-attacker', 'blue', 6000, ArmyState.DEPLOYED, planet.id);

      const state = createBaseState({ systems: [system], armies: [defendingArmy, attackingArmy] });

      const result = resolveGroundConflict(planet, system, state);

      assert.ok(result, 'Ground conflict should resolve when both factions are present');
      assert.strictEqual(result?.winnerFactionId, 'red', 'Defending faction should use the planet owner even if the system owner differs');
      assert.ok(
        result?.logs.some(log => log.includes('attacker coalition vs defender')),
        'Resolution should follow the defender-versus-attacker rule'
      );
    }
  },
  {
    name: 'LOAD_ARMY respecte le ciblage du vaisseau imposé',
    run: () => {
      const system = createSystem('sys-load-targeted', null);
      const allowedTransport: TestShipInput = {
        id: 'blue-transport-allowed',
        type: ShipType.TRANSPORTER,
        hp: 50,
        maxHp: 50,
        carriedArmyId: null
      };
      const blockedTransport: TestShipInput = {
        id: 'blue-transport-blocked',
        type: ShipType.TRANSPORTER,
        hp: 50,
        maxHp: 50,
        carriedArmyId: null
      };

      const blueArmy = createArmy('army-blue-load', 'blue', 7000, ArmyState.DEPLOYED, system.planets[0].id);
      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [allowedTransport, blockedTransport]);
      const rng = new RNG(9);

      const updated = applyCommand(
        createBaseState({ systems: [system], fleets: [blueFleet], armies: [blueArmy] }),
        { type: 'LOAD_ARMY', fleetId: blueFleet.id, shipId: allowedTransport.id, armyId: blueArmy.id, systemId: system.id },
        rng
      ).state;

      const loadedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.strictEqual(loadedArmy?.state, ArmyState.EMBARKED, 'Army must embark after load');
      assert.strictEqual(loadedArmy?.containerId, blueFleet.id, 'Army container should move to the fleet');

      const updatedFleet = updated.fleets.find(fleet => fleet.id === blueFleet.id);
      const allowedShip = updatedFleet?.ships.find(ship => ship.id === allowedTransport.id);
      const blockedShip = updatedFleet?.ships.find(ship => ship.id === blockedTransport.id);

      assert.strictEqual(allowedShip?.carriedArmyId, blueArmy.id, 'Allowed transport should carry the army');
      assert.strictEqual(blockedShip?.carriedArmyId, null, 'Blocked transport must remain empty');
    }
  },
  {
    name: 'ORDER_LOAD_MOVE charge une armée alliée à l’arrivée',
    run: () => {
      const system = createSystem('sys-load-move-arrival', 'blue');
      const transport: TestShipInput = {
        id: 'blue-transport-move-load',
        type: ShipType.TRANSPORTER,
        hp: 40,
        maxHp: 40,
        carriedArmyId: null
      };

      const movingFleet: Fleet = {
        ...createFleet('fleet-blue-move-load', 'blue', { ...baseVec }, [transport]),
        state: FleetState.MOVING,
        targetSystemId: system.id,
        targetPosition: { ...system.position },
        loadTargetSystemId: system.id,
        invasionTargetSystemId: null,
        unloadTargetSystemId: null
      };

      const groundArmy = createArmy('army-blue-ground', 'blue', 6000, ArmyState.DEPLOYED, system.planets[0].id);
      const rng = new RNG(11);

      const state = createBaseState({ systems: [system], fleets: [movingFleet], armies: [groundArmy] });
      const result = resolveFleetMovement(state, movingFleet, [system], [groundArmy], 3, rng, [movingFleet]);

      const updatedFleet = result.nextFleet;
      const loadedShip = updatedFleet.ships.find(ship => ship.id === transport.id);
      const loadUpdate = result.armyUpdates.find(update => update.id === groundArmy.id);

      assert.strictEqual(loadedShip?.carriedArmyId, groundArmy.id, 'Le transport doit embarquer l’armée après le mouvement');
      assert.strictEqual(
        loadUpdate?.changes.state,
        ArmyState.EMBARKED,
        'L’armée doit passer à l’état EMBARKED lors de la séquence de mouvement'
      );
      assert.strictEqual(
        loadUpdate?.changes.containerId,
        movingFleet.id,
        'L’armée doit être rattachée à la flotte ayant exécuté l’ordre de chargement'
      );
      assert.strictEqual(updatedFleet.loadTargetSystemId, null, 'L’ordre de chargement doit être consommé après l’arrivée');
      assert.strictEqual(updatedFleet.unloadTargetSystemId, null, 'Aucun ordre de déchargement ne doit rester actif');
      assert.strictEqual(updatedFleet.invasionTargetSystemId, null, 'Aucun ordre d’invasion ne doit persister');
    }
  },
  {
    name: 'Unloading proceeds safely when orbit is clear',
    run: () => {
      const system = createSystem('sys-unload-clear', null);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: 1, systemId: system.id, body: system.planets[0] });
      const transport: TestShipInput = {
        id: 'blue-transport',
        type: ShipType.TRANSPORTER,
        hp: 50,
        maxHp: 50,
        carriedArmyId: 'army-blue-unload'
      };

      const blueArmy = createArmy(transport.carriedArmyId!, 'blue', 8000, ArmyState.EMBARKED, 'fleet-blue');
      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [transport]);

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet],
        armies: [blueArmy],
        planetSurfaceDescriptorsByBodyId: { [system.planets[0].id]: descriptor }
      });
      const rng = new RNG(1);

      const updated = applyCommand(
        state,
        {
          type: 'UNLOAD_ARMY',
          fleetId: blueFleet.id,
          shipId: transport.id,
          armyId: blueArmy.id,
          systemId: system.id,
          planetId: system.planets[0].id
        },
        rng
      ).state;

      const queuedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.ok(queuedArmy, 'Army should still exist after unload command');
      assert.strictEqual(queuedArmy?.state, ArmyState.EMBARKED, 'UNLOAD_ARMY should schedule a landing (army stays embarked)');
      assert.strictEqual(queuedArmy?.containerId, blueFleet.id, 'Army remains attached to the carrier fleet until landing resolves');
      assert.ok(queuedArmy?.landingOrder, 'UNLOAD_ARMY should schedule a landingOrder');
      assert.strictEqual(queuedArmy?.landingOrder?.type, 'land', 'Landing order must be of type land');
      assert.strictEqual(queuedArmy?.landingOrder?.to.bodyId, system.planets[0].id, 'Landing order must target the selected planet');

      assert.strictEqual(updated.logs.length, state.logs.length, 'UNLOAD_ARMY does not emit logs (landing is resolved in phaseGround)');

      const afterGround = phaseGround(updated, { turn: 1, rng: new RNG(2) });
      const landedArmy = afterGround.armies.find(army => army.id === blueArmy.id);
      assert.ok(landedArmy, 'Army should still exist after landing resolution');
      assert.strictEqual(landedArmy?.state, ArmyState.DEPLOYED, 'Landing should deploy the army onto the surface');
      assert.strictEqual(landedArmy?.containerId, system.planets[0].id, 'Deployed army must be placed on the target planet');
      assert.ok(landedArmy?.surfacePos, 'Deployed army must have a surfacePos');
      assert.strictEqual(landedArmy?.landingOrder, undefined, 'Landing order should be cleared after deployment');
      const expectedLosses = Math.round(blueArmy.members * LANDING_BASE);
      assert.strictEqual(landedArmy?.members, blueArmy.members - expectedLosses, 'Base landing attrition should apply');
    }
  },
  {
    name: 'Contested orbit applies deterministic risk to unloading armies',
    run: () => {
      const system = createSystem('sys-unload-risk', null);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: 1, systemId: system.id, body: system.planets[0] });
      const transport: TestShipInput = {
        id: 'blue-risk-transport',
        type: ShipType.TRANSPORTER,
        hp: 50,
        maxHp: 50,
        carriedArmyId: 'army-blue-risk'
      };

      const blueArmy = createArmy(transport.carriedArmyId!, 'blue', 9000, ArmyState.EMBARKED, 'fleet-blue-risk');
      const blueFleet = createFleet('fleet-blue-risk', 'blue', { ...baseVec }, [transport]);
      const redFleet = createFleet(
        'fleet-red-risk',
        'red',
        { x: CAPTURE_RANGE - 0.5, y: 0, z: 0 },
        [{ id: 'red-escort', type: ShipType.FIGHTER, hp: 40, maxHp: 40, carriedArmyId: null }]
      );

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet, redFleet],
        armies: [blueArmy],
        planetSurfaceDescriptorsByBodyId: { [system.planets[0].id]: descriptor }
      });
      const rng = new RNG(4); // Deterministic roll below threshold to trigger losses

      const updated = applyCommand(
        state,
        {
          type: 'UNLOAD_ARMY',
          fleetId: blueFleet.id,
          shipId: transport.id,
          armyId: blueArmy.id,
          systemId: system.id,
          planetId: system.planets[0].id
        },
        rng
      ).state;

      const queuedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.ok(queuedArmy, 'Army should persist after issuing UNLOAD_ARMY');
      assert.strictEqual(queuedArmy?.state, ArmyState.EMBARKED, 'UNLOAD_ARMY schedules landing even under contested orbit');
      assert.ok(queuedArmy?.landingOrder, 'Landing order should be queued');
      assert.strictEqual(updated.logs.length, state.logs.length, 'UNLOAD_ARMY does not emit logs directly');

      const afterGround = phaseGround(updated, { turn: 1, rng: new RNG(5) });
      const landedArmy = afterGround.armies.find(army => army.id === blueArmy.id);
      assert.ok(landedArmy, 'Army should still exist after landing resolution');
      assert.strictEqual(landedArmy?.state, ArmyState.DEPLOYED, 'Landing should deploy the army even under contested orbit');
      const expectedLosses = Math.round(blueArmy.members * (LANDING_BASE + ORBIT_CONTESTED_LANDING_PENALTY));
      assert.strictEqual(landedArmy?.members, blueArmy.members - expectedLosses, 'Contested orbit should increase landing attrition');
    }
  },
  {
    name: 'TRANSFER_ARMY_PLANET moves a deployed army using an idle transport',
    run: () => {
      const system = createSystem('sys-transfer', 'blue');
      system.planets.push(createPlanet(system.id, 'blue', 2));

      const fromPlanet = system.planets[0];
      const toPlanet = system.planets[1];

      const army = createArmy('army-transfer', 'blue', 6000, ArmyState.DEPLOYED, fromPlanet.id);
      const transport: TestShipInput = {
        id: 'transfer-ship',
        type: ShipType.TRANSPORTER,
        hp: 50,
        maxHp: 50,
        carriedArmyId: null
      };
      const fleet = createFleet('fleet-transfer', 'blue', { ...baseVec }, [transport]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [army], day: 4 });
      const rng = new RNG(5);

      const updated = applyCommand(
        state,
        {
          type: 'TRANSFER_ARMY_PLANET',
          armyId: army.id,
          fromPlanetId: fromPlanet.id,
          toPlanetId: toPlanet.id,
          systemId: system.id
        },
        rng
      ).state;

      const movedArmy = updated.armies.find(current => current.id === army.id);
      const updatedShip = updated.fleets[0].ships[0];

      assert.strictEqual(movedArmy?.containerId, toPlanet.id, 'Army should move to the destination planet');
      assert.strictEqual(updatedShip.transferBusyUntilDay, state.day, 'Transport should be marked busy for the current day');
    }
  },
  {
    name: 'Fleet movement commands stamp stateStartTurn using provided turn or current day',
    run: () => {
      const system = createSystem('sys-move-time', null);
      const fleet = createFleet('fleet-move-time', 'blue', { ...baseVec }, []);
      const rng = new RNG(3);

      const stateAtDay = createBaseState({ day: 5, systems: [system], fleets: [fleet] });
      const moved = applyCommand(
        stateAtDay,
        { type: 'MOVE_FLEET', fleetId: fleet.id, targetSystemId: system.id },
        rng
      ).state;

      const movedFleet = moved.fleets.find(f => f.id === fleet.id);
      assert.strictEqual(
        movedFleet?.stateStartTurn,
        stateAtDay.day,
        'Movement without an explicit turn should use the current day'
      );

      const customTurn = 12;
      const movedWithTurn = applyCommand(
        stateAtDay,
        { type: 'ORDER_INVASION_MOVE', fleetId: fleet.id, targetSystemId: system.id, turn: customTurn },
        rng
      ).state;

      const invasionFleet = movedWithTurn.fleets.find(f => f.id === fleet.id);
      assert.strictEqual(
        invasionFleet?.stateStartTurn,
        customTurn,
        'Movement commands should respect an explicit turn override'
      );
    }
  },
  {
    name: 'Fleet movement errors report per-ship fuel shortages',
    run: () => {
      const sourceSystem = createSystem('sys-fuel-source', null);
      const targetSystem = { ...createSystem('sys-fuel-target', null), position: { x: 1, y: 0, z: 0 } };

      const ship: TestShipInput = {
        id: 'fuel-poor-1',
        type: ShipType.FIGHTER,
        hp: 50,
        maxHp: 50,
        carriedArmyId: null,
        fuel: 1
      };

      const fleet = createFleet('fleet-fuel', 'blue', { ...baseVec }, [ship]);
      const state = createBaseState({ systems: [sourceSystem, targetSystem], fleets: [fleet] });

      const result = applyCommand(
        state,
        { type: 'MOVE_FLEET', fleetId: fleet.id, targetSystemId: targetSystem.id },
        new RNG(13)
      );

      assert.strictEqual(result.ok, false, 'Movement should fail when fuel is insufficient');
      assert.ok(result.error && typeof result.error !== 'string', 'Fuel shortage should return structured error details');
      const error = result.error as FuelShortageError;

      assert.strictEqual(error.code, 'INSUFFICIENT_FUEL', 'Error code should identify insufficient fuel');
      assert.ok(error.shortages.length > 0, 'Shortage list should include affected ships');
      const shortage = error.shortages[0];
      assert.strictEqual(shortage.shipId, ship.id, 'Shortage should reference the ship ID');
      assert.strictEqual(shortage.shipType, ship.type, 'Shortage should include the ship type');
      assert.ok(shortage.missingFuel > 0, 'Missing fuel should be greater than zero');
      assert.ok(
        error.message.includes(ship.id) && error.message.includes(shortage.missingFuel.toFixed(2)),
        'Error message should summarize the missing fuel per ship'
      );
    }
  },
  {
    name: 'Combat fleets ignore movement commands in AI/replay flows',
    run: () => {
      const system = createSystem('sys-combat-locked', null);
      const combatFleet: Fleet = {
        ...createFleet('fleet-combat-locked', 'blue', { ...baseVec }, []),
        state: FleetState.COMBAT,
        targetSystemId: 'engaged-system',
        stateStartTurn: 7
      };

      const baseState = createBaseState({ day: 3, systems: [system], fleets: [combatFleet] });

      const commands: GameCommand[] = [
        { type: 'MOVE_FLEET', fleetId: combatFleet.id, targetSystemId: system.id },
        { type: 'ORDER_INVASION_MOVE', fleetId: combatFleet.id, targetSystemId: system.id },
        { type: 'ORDER_LOAD_MOVE', fleetId: combatFleet.id, targetSystemId: system.id },
        { type: 'ORDER_UNLOAD_MOVE', fleetId: combatFleet.id, targetSystemId: system.id }
      ];

      commands.forEach(command => {
        const result = applyCommand(baseState, command, new RNG(11));
        assert.strictEqual(
          result.state,
          baseState,
          `${command.type} should be ignored when the fleet is locked in combat`
        );
        assert.ok(!result.ok, `${command.type} should return an error result in combat`);
      });
    }
  },
  {
    name: 'Combat fleets ignore split and merge commands in AI/replay flows',
    run: () => {
      const combatFleet: Fleet = {
        ...createFleet('fleet-combat-split', 'blue', { ...baseVec }, [
          { id: 'split-ship-1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null },
          { id: 'split-ship-2', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }
        ]),
        state: FleetState.COMBAT,
        targetSystemId: 'enemy-system'
      };

      const mergeTarget: Fleet = createFleet('fleet-merge-target', 'blue', { ...baseVec }, [
        { id: 'merge-ship-1', type: ShipType.FRIGATE, hp: 80, maxHp: 80, carriedArmyId: null }
      ]);

      const state = createBaseState({
        systems: [createSystem('sys-combat-merge', null)],
        fleets: [combatFleet, mergeTarget]
      });

      const splitResult = applyCommand(
        state,
        { type: 'SPLIT_FLEET', originalFleetId: combatFleet.id, shipIds: ['split-ship-1'] },
        new RNG(12)
      );

      assert.strictEqual(splitResult.state, state, 'SPLIT_FLEET should be ignored for combat-locked fleets');
      assert.ok(!splitResult.ok, 'SPLIT_FLEET should return an error when combat-locked');

      const mergeResult = applyCommand(
        state,
        { type: 'MERGE_FLEETS', sourceFleetId: combatFleet.id, targetFleetId: mergeTarget.id },
        new RNG(13)
      );

      assert.strictEqual(mergeResult.state, state, 'MERGE_FLEETS should be ignored when either fleet is in combat');
      assert.ok(!mergeResult.ok, 'MERGE_FLEETS should return an error when combat-locked');
    }
  },
  {
    name: 'Auto invasion assigns armies to highest defended planets with per-army outcomes',
    run: () => {
      const systemId = 'sys-priority';
      const planetA = createPlanet(systemId, 'red', 1);
      const planetB = createPlanet(systemId, 'red', 2);

      const system: StarSystem = {
        ...createSystem(systemId, 'red'),
        position: { x: 0, y: 0, z: 0 },
        planets: [planetA, planetB]
      };

      const defenderA = createArmy('def-A', 'red', 2000, ArmyState.DEPLOYED, planetA.id);
      const defenderB = createArmy('def-B', 'red', 5000, ArmyState.DEPLOYED, planetB.id);

      const attackerArmy1 = createArmy('atk-1', 'blue', 4000, ArmyState.EMBARKED, 'fleet-priority');
      const attackerArmy2 = createArmy('atk-2', 'blue', 4000, ArmyState.EMBARKED, 'fleet-priority');

      const fleet: Fleet = {
        ...createFleet('fleet-priority', 'blue', { x: 0, y: 0, z: 0 }, [
          { id: 'ship-1', type: ShipType.TRANSPORTER, hp: 100, maxHp: 100, carriedArmyId: attackerArmy1.id },
          { id: 'ship-2', type: ShipType.TRANSPORTER, hp: 100, maxHp: 100, carriedArmyId: attackerArmy2.id }
        ]),
        state: FleetState.MOVING,
        targetSystemId: system.id,
        targetPosition: { ...system.position },
        invasionTargetSystemId: system.id
      };

      const rng = new RNG(17);

      const descriptors = {
        [planetA.id]: createPlanetSurfaceDescriptor({ gameSeed: 1, systemId, body: planetA }),
        [planetB.id]: createPlanetSurfaceDescriptor({ gameSeed: 1, systemId, body: planetB })
      };

      const state = createBaseState({
        systems: [system],
        fleets: [fleet],
        armies: [attackerArmy1, attackerArmy2, defenderA, defenderB],
        planetSurfaceDescriptorsByBodyId: descriptors
      });

      const arrival = resolveFleetMovement(state, fleet, [system], [attackerArmy1, attackerArmy2, defenderA, defenderB], 0, rng, [fleet]);

      const updatedArmies = [attackerArmy1, attackerArmy2, defenderA, defenderB].map(army => {
        const update = arrival.armyUpdates.find(change => change.id === army.id);
        return update ? { ...army, ...update.changes } : army;
      });

      const landedArmy1 = updatedArmies.find(army => army.id === attackerArmy1.id);
      const landedArmy2 = updatedArmies.find(army => army.id === attackerArmy2.id);

      assert.strictEqual(
        landedArmy1?.landingOrder?.to.bodyId,
        planetB.id,
        'First army should target the strongest defended planet'
      );
      assert.strictEqual(landedArmy2?.landingOrder?.to.bodyId, planetA.id, 'Second army should rotate to the next target');

      const invasionLog = arrival.logs.find(log => log.type === 'combat' && log.text.includes('INVASION STARTED'));
      assert.ok(invasionLog, 'Arrival should queue landings and emit an invasion log');
      assert.ok(invasionLog?.text.includes(planetB.name), 'Log should mention the primary defended target');
      assert.ok(invasionLog?.text.includes(planetA.name), 'Log should mention the other target assignment');
    }
  },
  {
    name: 'Auto invasion distributes armies across defended planets in priority order',
    run: () => {
      const systemId = 'sys-distribute';
      const planetStrong = createPlanet(systemId, 'red', 1);
      const planetMedium = createPlanet(systemId, 'red', 2);
      const planetWeak = createPlanet(systemId, 'red', 3);

      const system: StarSystem = {
        ...createSystem(systemId, 'red'),
        position: { x: 0, y: 0, z: 0 },
        planets: [planetStrong, planetMedium, planetWeak]
      };

      const defenders = [
        createArmy('def-strong', 'red', 7000, ArmyState.DEPLOYED, planetStrong.id),
        createArmy('def-medium', 'red', 5000, ArmyState.DEPLOYED, planetMedium.id),
        createArmy('def-weak', 'red', 3000, ArmyState.DEPLOYED, planetWeak.id)
      ];

      const attackers = [
        createArmy('atk-1', 'blue', 4000, ArmyState.EMBARKED, 'fleet-distribute'),
        createArmy('atk-2', 'blue', 4000, ArmyState.EMBARKED, 'fleet-distribute'),
        createArmy('atk-3', 'blue', 4000, ArmyState.EMBARKED, 'fleet-distribute'),
        createArmy('atk-4', 'blue', 4000, ArmyState.EMBARKED, 'fleet-distribute')
      ];

      const transports: TestShipInput[] = attackers.map(army => ({
        id: `ship-${army.id}`,
        type: ShipType.TRANSPORTER,
        hp: 100,
        maxHp: 100,
        carriedArmyId: army.id
      }));

      const fleet: Fleet = {
        ...createFleet('fleet-distribute', 'blue', { ...system.position }, transports),
        state: FleetState.MOVING,
        targetSystemId: system.id,
        targetPosition: { ...system.position },
        invasionTargetSystemId: system.id
      };

      const rng = new RNG(27);

      const descriptors = {
        [planetStrong.id]: createPlanetSurfaceDescriptor({ gameSeed: 1, systemId, body: planetStrong }),
        [planetMedium.id]: createPlanetSurfaceDescriptor({ gameSeed: 1, systemId, body: planetMedium }),
        [planetWeak.id]: createPlanetSurfaceDescriptor({ gameSeed: 1, systemId, body: planetWeak })
      };

      const state = createBaseState({
        systems: [system],
        fleets: [fleet],
        armies: [...attackers, ...defenders],
        planetSurfaceDescriptorsByBodyId: descriptors
      });

      const arrival = resolveFleetMovement(state, fleet, [system], [...attackers, ...defenders], 0, rng, [fleet]);

      const armiesAfterArrival = [...attackers, ...defenders].map(army => {
        const update = arrival.armyUpdates.find(change => change.id === army.id);
        return update ? { ...army, ...update.changes } : army;
      });

      const targetByArmy = new Map<string, string>();
      armiesAfterArrival.forEach(army => {
        const target = army.landingOrder?.to.bodyId ?? null;
        if (target && [planetStrong.id, planetMedium.id, planetWeak.id].includes(target)) {
          targetByArmy.set(army.id, target);
        }
      });

      assert.strictEqual(targetByArmy.get('atk-1'), planetStrong.id, 'First landing should prioritize the strongest defended planet');
      assert.strictEqual(targetByArmy.get('atk-2'), planetMedium.id, 'Second landing should target the next defended planet');
      assert.strictEqual(targetByArmy.get('atk-3'), planetWeak.id, 'Third landing should use the last defended planet before rotating');
      assert.strictEqual(targetByArmy.get('atk-4'), planetStrong.id, 'Assignments should rotate back to the top of the defended queue');

      const invasionLog = arrival.logs.find(log => log.type === 'combat' && log.text.includes('INVASION STARTED'));
      assert.ok(invasionLog, 'Arrival should queue landings and emit an invasion log');
      assert.ok(invasionLog?.text.includes(planetStrong.name), 'Log should mention the strongest defended target');
      assert.ok(invasionLog?.text.includes(planetMedium.name), 'Log should mention the medium defended target');
      assert.ok(invasionLog?.text.includes(planetWeak.name), 'Log should mention the weakest defended target');
    }
  },
  {
    name: 'Invasion movement deploys embarked armies and logs the landing on arrival',
    run: () => {
      const system: StarSystem = { ...createSystem('sys-invasion', 'red'), position: { x: 0, y: 0, z: 0 } };
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: 1, systemId: system.id, body: system.planets[0] });

      const transport: TestShipInput = {
        id: 'transport-invasion',
        type: ShipType.TRANSPORTER,
        hp: 2000,
        maxHp: 2000,
        carriedArmyId: 'army-invasion'
      };

      const army = createArmy(transport.carriedArmyId!, 'blue', 8000, ArmyState.EMBARKED, 'fleet-invasion');
      const movingFleet: Fleet = {
        ...createFleet('fleet-invasion', 'blue', { x: -30, y: 0, z: 0 }, [transport]),
        state: FleetState.MOVING,
        targetSystemId: system.id,
        targetPosition: { ...system.position },
        invasionTargetSystemId: system.id
      };

      const rng = new RNG(9);

      const baseState = createBaseState({
        systems: [system],
        fleets: [movingFleet],
        armies: [army],
        planetSurfaceDescriptorsByBodyId: { [system.planets[0].id]: descriptor }
      });

      const initialStep = resolveFleetMovement(baseState, movingFleet, [system], [army], 0, rng, [movingFleet]);
      const fleetsAfterFirstStep = [initialStep.nextFleet];
      const armiesAfterFirstStep = [army];

      const stateAfterFirstStep = { ...baseState, fleets: fleetsAfterFirstStep, armies: armiesAfterFirstStep };
      const arrivalStep = resolveFleetMovement(
        stateAfterFirstStep,
        initialStep.nextFleet,
        [system],
        armiesAfterFirstStep,
        1,
        rng,
        fleetsAfterFirstStep
      );

      const armiesAfterArrival = armiesAfterFirstStep.map(currentArmy => {
        const update = arrivalStep.armyUpdates.find(change => change.id === currentArmy.id);
        return update ? { ...currentArmy, ...update.changes } : currentArmy;
      });

      const landedArmy = armiesAfterArrival.find(updatedArmy => updatedArmy.id === army.id);
      assert.strictEqual(landedArmy?.state, ArmyState.EMBARKED, 'Invasion arrival should queue landing orders (deployment happens in phaseGround)');
      assert.ok(landedArmy?.landingOrder, 'Invasion arrival should queue a landingOrder for the army');
      assert.strictEqual(landedArmy?.landingOrder?.to.bodyId, system.planets[0].id, 'Queued landing must target the invaded planet');

      const invasionLog = arrivalStep.logs.find(log => log.type === 'combat' && log.text.includes('INVASION STARTED'));
      assert.ok(invasionLog, 'Arrival should generate an invasion log entry');
    }
  },
  {
    name: 'Arriving at a gas system logs the aborted invasion and clears the order',
    run: () => {
      const gasSystem: StarSystem = {
        ...createSystem('sys-gas', 'blue'),
        planets: [
          {
            id: 'gas-only-planet',
            systemId: 'sys-gas',
            name: 'Gas Haven',
            bodyType: 'planet',
            class: 'gas_giant',
            ownerFactionId: 'blue',
            size: 10,
            isSolid: false
          }
        ],
        position: { x: 0, y: 0, z: 0 }
      };

      const transport: TestShipInput = {
        id: 'transport-gas',
        type: ShipType.TRANSPORTER,
        hp: 2000,
        maxHp: 2000,
        carriedArmyId: 'army-gas'
      };

      const embarkedArmy = createArmy(transport.carriedArmyId!, 'blue', 5000, ArmyState.EMBARKED, 'fleet-gas');
      const movingFleet: Fleet = {
        ...createFleet('fleet-gas', 'blue', { x: -1, y: 0, z: 0 }, [transport]),
        state: FleetState.MOVING,
        targetSystemId: gasSystem.id,
        targetPosition: { ...gasSystem.position },
        invasionTargetSystemId: gasSystem.id
      };

      const rng = new RNG(11);
      const state = createBaseState({ systems: [gasSystem], fleets: [movingFleet], armies: [embarkedArmy] });
      const arrival = resolveFleetMovement(state, movingFleet, [gasSystem], [embarkedArmy], 0, rng, [movingFleet]);

      assert.strictEqual(
        arrival.nextFleet.invasionTargetSystemId,
        null,
        'Invasion order should be cleared even when no solid planet is available'
      );

      const failureLog = arrival.logs.find(log => log.text.includes('no solid bodies to land on'));
      assert.ok(
        failureLog,
        'Arrival on a gas-only system should emit a clear business log about the aborted invasion'
      );
      assert.strictEqual(arrival.armyUpdates.length, 0, 'Armies should remain unchanged when invasion cannot proceed');
    }
  },
  {
    name: 'Multi-faction ground battle with a defender uses the attacker coalition rule',
    run: () => {
      const system = createSystem('sys-coalition-hold', 'red');

      const redArmy = createArmy('army-red', 'red', 10000, ArmyState.DEPLOYED, system.planets[0].id);
      const blueArmy = createArmy('army-blue', 'blue', 4000, ArmyState.DEPLOYED, system.planets[0].id);
      const greenArmy = createArmy('army-green', 'green', 3000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [redArmy, blueArmy, greenArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);

      assert.ok(result, 'Ground conflict should be resolved when multiple factions are present');
      assert.strictEqual(result?.winnerFactionId, 'red', 'Defenders should keep control against a weaker coalition');
      assert.strictEqual(result?.casualties.length, 3, 'All involved factions should be tracked in the casualty report');
      assert.ok(
        result?.logs.some(log => log.includes('attacker coalition vs defender')),
        'Logs should describe the coalition vs defender resolution rule'
      );
    }
  },
  {
    name: 'The strongest surviving attacker claims conquest after a coalition victory',
    run: () => {
      const system = createSystem('sys-coalition-win', 'red');

      const redArmy = createArmy('army-red-win', 'red', 3000, ArmyState.DEPLOYED, system.planets[0].id);
      const blueArmy = createArmy('army-blue-win', 'blue', 9000, ArmyState.DEPLOYED, system.planets[0].id);
      const greenArmy = createArmy('army-green-win', 'green', 7000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [redArmy, blueArmy, greenArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);

      assert.ok(result, 'Ground conflict should resolve for coalition attacks');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Top surviving attacker should be credited with the coalition win');
      assert.ok(
        result?.logs.some(log => log.includes('attacker coalition vs defender')),
        'Logs should highlight the coalition rule when attackers cooperate'
      );
    }
  },
  {
    name: 'Free-for-all fights remain supported on neutral ground',
    run: () => {
      const system = createSystem('sys-ffa', null);

      const alphaArmy = createArmy('army-alpha', 'blue', 6000, ArmyState.DEPLOYED, system.planets[0].id);
      const betaArmy = createArmy('army-beta', 'red', 4000, ArmyState.DEPLOYED, system.planets[0].id);
      const gammaArmy = createArmy('army-gamma', 'green', 2000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [alphaArmy, betaArmy, gammaArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);

      assert.ok(result, 'Free-for-all ground conflicts should resolve');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Highest remaining ground power should win on neutral ground');
      assert.ok(result?.logs.some(log => log.includes('free-for-all')), 'Logs should describe the free-for-all rule');
    }
  },
  {
    name: 'Exhausted invaders are cleared so the ground battle does not loop',
    run: () => {
      const system = createSystem('sys-loop-1', 'blue');
      const blueArmy = createArmy('army-blue-loop', 'blue', 18000, ArmyState.DEPLOYED, system.planets[0].id);
      const redArmy = withGroundDefaults({
        id: 'army-red-loop',
        factionId: 'red',
        unitType: 'mechanized_infantry',
        posture: 'normal',
        maxMembers: scaleMembers(20000),
        members: 0,
        attack: 1,
        defense: 1,
        condition: 0.8,
        state: ArmyState.DEPLOYED,
        containerId: system.planets[0].id
      });

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const firstResult = resolveGroundConflict(system.planets[0], system, state);
      assert.ok(firstResult, 'Ground conflict should resolve even with exhausted invaders present');
      assert.strictEqual(firstResult?.winnerFactionId, 'blue', 'Defenders should secure their own system');
      assert.ok(firstResult?.armiesDestroyed.includes(redArmy.id), 'Invading army at zero strength must be removed');

      const updatedState: GameState = {
        ...state,
        armies: state.armies
          .map(army => {
            const update = firstResult?.armyUpdates.find(entry => entry.armyId === army.id);
            return update ? { ...army, members: update.members, condition: update.condition } : army;
          })
          .filter(army => !(firstResult?.armiesDestroyed || []).includes(army.id))
      };

      const followUp = resolveGroundConflict(system.planets[0], system, updatedState);
      assert.strictEqual(followUp, null, 'Once the attacker is destroyed, the ground battle should not loop');
    }
  },
  {
    name: 'Fleet orders are cleared when battle detection locks combat',
    run: () => {
      const system = createSystem('sys-combat-lock', 'red');

      const blueFleet = {
        ...createFleet('fleet-blue-lock', 'blue', { ...baseVec }, [
          { id: 'blue-lock', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
        ]),
        state: FleetState.MOVING,
        targetSystemId: system.id,
        targetPosition: { ...baseVec },
        invasionTargetSystemId: 'pending-invasion',
        loadTargetSystemId: 'load-target',
        unloadTargetSystemId: 'unload-target'
      };

      const redFleet = {
        ...createFleet('fleet-red-lock', 'red', { ...baseVec }, [
          { id: 'red-lock', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
        ])
      };

      const state = createBaseState({ systems: [system], fleets: [blueFleet, redFleet] });
      const ctx = { turn: 3, rng: new RNG(5) };

      const nextState = phaseBattleDetection(state, ctx);

      const lockedFleet = nextState.fleets.find(fleet => fleet.id === blueFleet.id);
      assert.ok(lockedFleet, 'Fleet should still exist after detection');
      assert.strictEqual(lockedFleet?.state, FleetState.COMBAT, 'Fleet must be set to COMBAT state');
      assert.strictEqual(lockedFleet?.targetSystemId, null, 'Movement target is cleared when combat locks the fleet');
      assert.strictEqual(lockedFleet?.targetPosition, null, 'Target position is cleared when combat locks the fleet');
      assert.strictEqual(
        lockedFleet?.invasionTargetSystemId,
        null,
        'Pending invasion order is cleared when combat locks the fleet'
      );
      assert.strictEqual(lockedFleet?.loadTargetSystemId, null, 'Load order is cleared when combat locks the fleet');
      assert.strictEqual(lockedFleet?.unloadTargetSystemId, null, 'Unload order is cleared when combat locks the fleet');
    }
  },
  {
    name: 'Embarked armies are lost if their transport dies before invasion',
    run: () => {
      const system = createSystem('sys-contested', 'red');

      const blueArmy = createArmy('army-blue-embarked', 'blue', 12000, ArmyState.EMBARKED, 'fleet-blue-transport');
      const blueTransport = createFleet('fleet-blue-transport', 'blue', { ...baseVec }, [
        { id: 'blue-transport', type: ShipType.TRANSPORTER, hp: 1, maxHp: 2000, carriedArmyId: blueArmy.id }
      ]);

      const redFleet = createFleet('fleet-red-intercept', 'red', { ...baseVec }, [
        { id: 'red-cruiser', type: ShipType.CRUISER, hp: 1200, maxHp: 1200, carriedArmyId: null }
      ]);

      const scheduledBattle: Battle = {
        id: 'battle-contested',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueTransport.id, redFleet.id],
        logs: []
      };

      const state = createBaseState({
        systems: [system],
        armies: [blueArmy],
        fleets: [
          { ...blueTransport, state: FleetState.COMBAT, invasionTargetSystemId: system.id },
          { ...redFleet, state: FleetState.COMBAT }
        ],
        battles: [scheduledBattle]
      });

      const nextState = runTurn(state, new RNG(7));

      const survivingBlueFleet = nextState.fleets.find(fleet => fleet.id === blueTransport.id);
      assert.strictEqual(survivingBlueFleet, undefined, 'Transport fleet should be destroyed in the space battle');

      const remainingArmy = nextState.armies.find(army => army.id === blueArmy.id);
      assert.ok(!remainingArmy || remainingArmy.state !== ArmyState.DEPLOYED, 'Embarked army must not land after carrier loss');

      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);
      assert.strictEqual(updatedSystem?.ownerFactionId, 'red', 'Defenders should retain control when orbit is contested and transport dies');
    }
  },
  {
    name: 'Space battle resolution reports embarked armies lost with destroyed transports',
    run: () => {
      const system = createSystem('sys-transport-loss', 'red');

      const embarkedArmy = createArmy('army-transport-loss', 'blue', 12000, ArmyState.EMBARKED, 'fleet-blue-carrier');
      const transportFleet = createFleet('fleet-blue-carrier', 'blue', { ...baseVec }, [
        { id: 'blue-transport-loss', type: ShipType.TRANSPORTER, hp: 1, maxHp: 2000, carriedArmyId: embarkedArmy.id }
      ]);
      const attackerFleet = createFleet('fleet-red-destroyer', 'red', { ...baseVec }, [
        { id: 'red-destroyer-loss', type: ShipType.CRUISER, hp: 1200, maxHp: 1200, carriedArmyId: null }
      ]);

      const battle: Battle = {
        id: 'battle-transport-loss',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [transportFleet.id, attackerFleet.id],
        logs: []
      };

      const state = createBaseState({
        systems: [system],
        armies: [embarkedArmy],
        fleets: [transportFleet, attackerFleet],
        seed: 17
      });

      const result = resolveBattle(battle, state, 0);

      assert.ok(result.destroyedArmyIds.includes(embarkedArmy.id), 'Carried army should be flagged as destroyed with its transport');
      assert.strictEqual(
        result.survivingFleets.some(fleet => fleet.id === transportFleet.id),
        false,
        'Transport fleet should not survive overwhelming opposition'
      );
    }
  },
  {
    name: 'Phase battle resolution removes armies whose transports are destroyed',
    run: () => {
      const system = createSystem('sys-battle-clean', 'red');

      const embarkedArmy = createArmy('army-battle-clean', 'blue', 12000, ArmyState.EMBARKED, 'fleet-blue-clean');
      const carrierFleet = createFleet('fleet-blue-clean', 'blue', { ...baseVec }, [
        { id: 'blue-clean-transport', type: ShipType.TRANSPORTER, hp: 1, maxHp: 2000, carriedArmyId: embarkedArmy.id }
      ]);
      const interceptorFleet = createFleet('fleet-red-clean', 'red', { ...baseVec }, [
        { id: 'red-clean-cruiser', type: ShipType.CRUISER, hp: 1200, maxHp: 1200, carriedArmyId: null }
      ]);

      const scheduledBattle: Battle = {
        id: 'battle-battle-clean',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [carrierFleet.id, interceptorFleet.id],
        logs: []
      };

      const state = createBaseState({
        systems: [system],
        armies: [embarkedArmy],
        fleets: [
          { ...carrierFleet, state: FleetState.COMBAT },
          { ...interceptorFleet, state: FleetState.COMBAT }
        ],
        battles: [scheduledBattle],
        day: 2,
        seed: 23
      });

      const ctx = { turn: state.day, rng: new RNG(11) };
      const afterBattle = phaseBattleResolution(state, ctx);

      assert.strictEqual(
        afterBattle.armies.some(army => army.id === embarkedArmy.id),
        false,
        'Destroyed transports should purge embarked armies during battle resolution'
      );

      const lossLog = afterBattle.logs.find(
        log => log.type === 'combat' && log.text.includes(embarkedArmy.id) && log.text.includes(system.name)
      );
      assert.ok(lossLog, 'Army loss should be recorded in combat logs for visibility');
    }
  },
  {
    name: 'Space battle survivors exit combat needing repairs and updated metrics',
    run: () => {
      const system = createSystem('sys-repair', 'blue');
      const cruiserStats = SHIP_STATS[ShipType.CRUISER];
      const blueFleet = createFleet('fleet-repair', 'blue', { ...baseVec }, [
        { id: 'blue-cruiser-repair', type: ShipType.CRUISER, hp: cruiserStats.maxHp, maxHp: cruiserStats.maxHp, carriedArmyId: null }
      ]);

      const battle: Battle = {
        id: 'battle-repair',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueFleet.id],
        logs: []
      };

      const state = createBaseState({ systems: [system], fleets: [blueFleet], battles: [battle] });

      const { updatedBattle, survivingFleets } = resolveBattle(battle, state, 0);

      assert.strictEqual(survivingFleets.length, 1, 'Fleet without opponents should persist after attrition');
      const survivingShip = survivingFleets[0].ships.find(ship => ship.id === blueFleet.ships[0].id);

      assert.ok(survivingShip, 'Original ship should survive minimal attrition');
      assert.ok(
        survivingShip.hp < blueFleet.ships[0].hp,
        'Survivors must leave combat needing repairs instead of staying at full strength'
      );
      assert.deepStrictEqual(
        updatedBattle.survivorShipIds ?? [],
        [blueFleet.ships[0].id],
        'Survivor metrics should list ships that remain operational after attrition'
      );
      assert.strictEqual(updatedBattle.shipsLost?.blue, 0, 'No additional blue losses should be counted when attrition is non-lethal');
    }
  },
  {
    name: 'Space battle survivors snap to the contested system position',
    run: () => {
      const system = { ...createSystem('sys-position', 'blue'), position: { x: 10, y: -5, z: 3 } };
      const cruiserStats = SHIP_STATS[ShipType.CRUISER];
      const blueFleet = {
        ...createFleet('fleet-position', 'blue', { x: -2, y: -2, z: -2 }, [
          { id: 'blue-cruiser-position', type: ShipType.CRUISER, hp: cruiserStats.maxHp, maxHp: cruiserStats.maxHp, carriedArmyId: null }
        ]),
        state: FleetState.COMBAT,
        targetSystemId: system.id,
        targetPosition: { x: 1, y: 2, z: 3 }
      };

      const battle: Battle = {
        id: 'battle-position',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueFleet.id],
        logs: []
      };

      const state = createBaseState({ systems: [system], fleets: [blueFleet], seed: 15 });

      const { survivingFleets } = resolveBattle(battle, state, 0);

      assert.strictEqual(survivingFleets.length, 1, 'Fleet should persist after uncontested battle resolution');
      assert.deepStrictEqual(
        survivingFleets[0].position,
        system.position,
        'Surviving fleets must snap to the battle system position when exiting combat'
      );
      assert.strictEqual(
        survivingFleets[0].state,
        FleetState.ORBIT,
        'Survivors should return to ORBIT state after combat resolution'
      );
    }
  },
  {
    name: 'Space battle aggregates faction ammunition usage with conserved totals',
    run: () => {
      const system = createSystem('sys-ammo', null);
      const cruiserStats = SHIP_STATS[ShipType.CRUISER];
      const fighterStats = SHIP_STATS[ShipType.FIGHTER];

      const blueFleet = createFleet('fleet-blue-ammo', 'blue', { ...baseVec }, [
        { id: 'blue-cruiser-ammo', type: ShipType.CRUISER, hp: cruiserStats.maxHp, maxHp: cruiserStats.maxHp, carriedArmyId: null }
      ]);
      const redFleet = createFleet('fleet-red-ammo', 'red', { ...baseVec }, [
        { id: 'red-fighter-ammo', type: ShipType.FIGHTER, hp: fighterStats.maxHp, maxHp: fighterStats.maxHp, carriedArmyId: null }
      ]);

      const battle: Battle = {
        id: 'battle-ammo',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueFleet.id, redFleet.id],
        logs: []
      };

      const state = createBaseState({ systems: [system], fleets: [blueFleet, redFleet], seed: 99, day: 5 });

      const { updatedBattle, survivingFleets } = resolveBattle(battle, state, 5);

      assert.strictEqual(updatedBattle.winnerFactionId, 'blue', 'Heavier fleet should secure victory');
      assert.ok(updatedBattle.ammunitionByFaction, 'Ammunition summary should be recorded on the battle result');
      assert.ok(updatedBattle.logs.length > 0, 'Battle resolution should emit detailed combat logs');
      assert.ok(
        updatedBattle.logs.every(entry => entry.startsWith('[Turn 5]')),
        'All battle logs should be prefixed with the turn reference'
      );

      const blueTotals = updatedBattle.ammunitionByFaction?.blue;
      const redTotals = updatedBattle.ammunitionByFaction?.red;

      assert.ok(blueTotals, 'Blue faction should include aggregated ammunition data');
      assert.ok(redTotals, 'Red faction should include aggregated ammunition data');

      const verifyTally = (label: string, tally: { initial: number; used: number; remaining: number }) => {
        assert.ok(tally.initial >= 0 && tally.used >= 0 && tally.remaining >= 0, `${label} should never be negative`);
        assert.strictEqual(tally.initial, tally.used + tally.remaining, `${label} must conserve ammunition totals`);
      };

      verifyTally('Blue offensive missiles', blueTotals!.offensiveMissiles);
      verifyTally('Blue torpedoes', blueTotals!.torpedoes);
      verifyTally('Blue interceptors', blueTotals!.interceptors);
      verifyTally('Red offensive missiles', redTotals!.offensiveMissiles);
      verifyTally('Red torpedoes', redTotals!.torpedoes);
      verifyTally('Red interceptors', redTotals!.interceptors);

      assert.strictEqual(
        blueTotals!.offensiveMissiles.initial,
        cruiserStats.offensiveMissileStock,
        'Blue initial missile stock should match cruiser loadout'
      );
      assert.strictEqual(
        redTotals!.offensiveMissiles.initial,
        fighterStats.offensiveMissileStock,
        'Red initial missile stock should match fighter loadout'
      );
      assert.strictEqual(redTotals!.offensiveMissiles.remaining, 0, 'Destroyed ships should not retain remaining stock');
      assert.strictEqual(redTotals!.torpedoes.remaining, 0, 'Destroyed ships should lose torpedoes alongside hulls');
      assert.strictEqual(redTotals!.interceptors.remaining, 0, 'Destroyed ships should lose interceptors alongside hulls');

      const survivingShips = survivingFleets.flatMap(fleet => fleet.ships);
      const killLogEntries = survivingShips.flatMap(ship => ship.killHistory ?? []);

      assert.ok(killLogEntries.length > 0, 'Survivors should record confirmed kills when defeating opponents');
      killLogEntries.forEach(entry => {
        assert.strictEqual(entry.turn, 5, 'Kill log turn should use the active turn reference');
        assert.strictEqual(entry.day, 5, 'Kill log day should align with the chosen turn reference');
      });
    }
  },
  {
    name: 'Massive space battles resolve within expected time using pre-indexed targets',
    run: () => {
      const system = createSystem('sys-massive', null);
      const createShips = (prefix: string, type: ShipType, count: number): TestShipInput[] => {
        const stats = SHIP_STATS[type];
        return Array.from({ length: count }, (_, idx) => ({
          id: `${prefix}-${idx}`,
          type,
          hp: stats.maxHp,
          maxHp: stats.maxHp,
          carriedArmyId: null
        }));
      };

      const blueFleet = createFleet('fleet-blue-massive', 'blue', { ...baseVec }, [
        ...createShips('blue-fighter', ShipType.FIGHTER, 80),
        ...createShips('blue-destroyer', ShipType.DESTROYER, 40)
      ]);
      const redFleet = createFleet('fleet-red-massive', 'red', { ...baseVec }, [
        ...createShips('red-bomber', ShipType.BOMBER, 60),
        ...createShips('red-cruiser', ShipType.CRUISER, 50)
      ]);
      const greenFleet = createFleet('fleet-green-massive', 'green', { ...baseVec }, [
        ...createShips('green-frigate', ShipType.FRIGATE, 50),
        ...createShips('green-carrier', ShipType.CARRIER, 20)
      ]);

      const battle: Battle = {
        id: 'battle-massive',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueFleet.id, redFleet.id, greenFleet.id],
        logs: []
      };

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet, redFleet, greenFleet],
        day: 12,
        seed: 2025
      });

      const start = performance.now();
      const { updatedBattle, survivingFleets } = resolveBattle(battle, state, 1);
      const duration = performance.now() - start;

      assert.ok(duration < 3000, `Large-scale battle should resolve quickly (took ${duration.toFixed(2)}ms)`);
      assert.ok((updatedBattle.roundsPlayed ?? 0) > 0, 'Large battle should play at least one round');
      assert.ok(updatedBattle.logs.length > 0, 'Large battle should produce combat logs');
      assert.ok(updatedBattle.ammunitionByFaction?.blue, 'Ammunition summary should remain available for large battles');
      assert.ok(survivingFleets.length > 0, 'At least one fleet should exit the battle to validate survivor handling');
    }
  },
  {
    name: 'Ground phase stays idle without ground activity',
    run: () => {
      const { system, solidBodies, descriptors } = findSystemWithSolidBodies({
        systemId: 'sys-green-capture',
        seed: 120,
        minSolids: 1,
        ownerFactionId: 'red'
      });

      const body = solidBodies[0];
      const systemWithBody = { ...system, planets: [body] };
      const stateBase = createBaseState({
        systems: [systemWithBody],
        planetSurfaceDescriptorsByBodyId: { [body.id]: descriptors[body.id] }
      });

      const map = getSurfaceMapOrThrow(stateBase, body.id);
      assert.ok(map.settlements.length > 0, 'Expected settlements to validate idle ground phase.');

      const ctx = { rng: new RNG(1), turn: stateBase.day + 1 };
      const nextState = phaseGround(stateBase, ctx);

      assert.deepStrictEqual(nextState.settlementControl, {}, 'Idle ground phase should not pre-seed settlement control.');
    }
  },
  {
    name: 'Phase ground conquest uses faction color and AI hold updates for any winner',
    run: () => {
      const { system, solidBodies, descriptors } = findSystemWithSolidBodies({
        systemId: 'sys-green-capture',
        seed: 120,
        minSolids: 1,
        ownerFactionId: 'red'
      });
      const body = solidBodies[0];
      const systemWithBody = { ...system, planets: [body] };
      const stateBase = createBaseState({
        systems: [systemWithBody],
        planetSurfaceDescriptorsByBodyId: { [body.id]: descriptors[body.id] },
        aiStates: {}
      });
      const map = getSurfaceMapOrThrow(stateBase, body.id);
      const greenArmies = createArmiesOnSettlements({ map, factionId: 'green', baseId: 'army-green', members: 8000 });

      const state = { ...stateBase, armies: greenArmies };
      const ctx = { rng: new RNG(21), turn: state.day + 1 };

      const nextState = phaseGround(state, ctx);
      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);

      assert.strictEqual(updatedSystem?.ownerFactionId, 'green', 'Green forces should capture an unopposed enemy world');
      assert.strictEqual(updatedSystem?.color, factions[2].color, 'Captured system color should match the winner faction color');
      assert.ok(nextState.aiStates?.green, 'AI state should be initialized for AI-controlled victors');
      assert.strictEqual(
        nextState.aiStates?.green?.holdUntilTurnBySystemId?.[system.id],
        ctx.turn + AI_HOLD_TURNS,
        'AI hold orders should be scheduled for newly conquered systems'
      );
    }
  },
  {
    name: 'Systems fall when only one faction keeps ground armies',
    run: () => {
      const { system, solidBodies, descriptors } = findSystemWithSolidBodies({
        systemId: 'sys-shared',
        seed: 160,
        minSolids: 2,
        ownerFactionId: 'red'
      });
      const [bodyA, bodyB] = solidBodies;
      const systemWithBodies = { ...system, planets: [bodyA, bodyB] };
      const stateBase = createBaseState({
        systems: [systemWithBodies],
        planetSurfaceDescriptorsByBodyId: { [bodyA.id]: descriptors[bodyA.id], [bodyB.id]: descriptors[bodyB.id] }
      });
      const mapA = getSurfaceMapOrThrow(stateBase, bodyA.id);
      const mapB = getSurfaceMapOrThrow(stateBase, bodyB.id);
      const blueArmies = [
        ...createArmiesOnSettlements({ map: mapA, factionId: 'blue', baseId: 'army-blue-a', members: 6000 }),
        ...createArmiesOnSettlements({ map: mapB, factionId: 'blue', baseId: 'army-blue-b', members: 6000 })
      ];
      const state = { ...stateBase, armies: blueArmies };
      const ctx = { rng: new RNG(42), turn: state.day + 1 };

      const nextState = phaseGround(state, ctx);
      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);
      const bodyBAfter = updatedSystem?.planets.find(body => body.id === bodyB.id);

      assert.strictEqual(updatedSystem?.ownerFactionId, 'blue', 'System should be captured once all solid bodies are controlled');
      assert.strictEqual(bodyBAfter?.ownerFactionId, 'blue', 'System conquest grants ownership of all solid bodies once captured');
    }
  },
  {
    name: 'System ownership logs reflect cleared ground resistance',
    run: () => {
      const { system, solidBodies, descriptors } = findSystemWithSolidBodies({
        systemId: 'sys-unified',
        seed: 190,
        minSolids: 2,
        ownerFactionId: 'red'
      });
      const [bodyA, bodyB] = solidBodies;
      const systemWithBodies = { ...system, planets: [bodyA, bodyB] };
      const stateBase = createBaseState({
        systems: [systemWithBodies],
        planetSurfaceDescriptorsByBodyId: { [bodyA.id]: descriptors[bodyA.id], [bodyB.id]: descriptors[bodyB.id] }
      });
      const mapA = getSurfaceMapOrThrow(stateBase, bodyA.id);
      const mapB = getSurfaceMapOrThrow(stateBase, bodyB.id);
      const greenArmies = [
        ...createArmiesOnSettlements({ map: mapA, factionId: 'green', baseId: 'army-green-a', members: 4000 }),
        ...createArmiesOnSettlements({ map: mapB, factionId: 'green', baseId: 'army-green-b', members: 4000 })
      ];

      const state = { ...stateBase, armies: greenArmies };
      const ctx = { rng: new RNG(17), turn: state.day + 1 };

      const nextState = phaseGround(state, ctx);
      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);
      const lastLog = nextState.logs[nextState.logs.length - 1]?.text ?? '';

      assert.strictEqual(updatedSystem?.ownerFactionId, 'green', 'System ownership should flip when all solid bodies are captured');
      assert.match(lastLog, /System .* control set/i, 'System capture log should mention ground conquest');
    }
  },
  {
    name: 'Neutral systems fall after capturing all solid bodies',
    run: () => {
      const { system, solidBodies, descriptors } = findSystemWithSolidBodies({
        systemId: 'sys-neutral',
        seed: 210,
        minSolids: 2,
        ownerFactionId: null,
        settlementConfig: { neutralOutpostChance: 1 }
      });
      const [bodyA, bodyB] = solidBodies;
      const systemWithBodies = { ...system, planets: [bodyA, bodyB], color: COLORS.star, ownerFactionId: null };
      const stateBase = createBaseState({
        systems: [systemWithBodies],
        planetSurfaceDescriptorsByBodyId: { [bodyA.id]: descriptors[bodyA.id], [bodyB.id]: descriptors[bodyB.id] }
      });
      const mapA = getSurfaceMapOrThrow(stateBase, bodyA.id);
      const mapB = getSurfaceMapOrThrow(stateBase, bodyB.id);
      const redArmies = [
        ...createArmiesOnSettlements({ map: mapA, factionId: 'red', baseId: 'army-red-a', members: 6000 }),
        ...createArmiesOnSettlements({ map: mapB, factionId: 'red', baseId: 'army-red-b', members: 6000 })
      ];

      const state = { ...stateBase, armies: redArmies };
      const ctx = { rng: new RNG(13), turn: state.day + 1 };

      const nextState = phaseGround(state, ctx);
      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);
      const bodyBAfter = updatedSystem?.planets.find(planet => planet.id === bodyB.id);

      assert.strictEqual(updatedSystem?.ownerFactionId, 'red', 'Neutral systems should be captured when all solid bodies are held');
      assert.strictEqual(bodyBAfter?.ownerFactionId, 'red', 'System conquest claims all solid bodies once captured');
    }
  },
  {
    name: 'Multi-planet systems change owner only after every solid world falls',
    run: () => {
      const { system, solidBodies, descriptors } = findSystemWithSolidBodies({
        systemId: 'sys-multi-solid',
        seed: 240,
        minSolids: 2,
        ownerFactionId: 'red',
        resourceType: 'gas'
      });
      const [bodyA, bodyB] = solidBodies;
      const gasGiant: PlanetBody = {
        ...createPlanet(system.id, system.ownerFactionId ?? null, 3),
        class: 'gas_giant',
        isSolid: false
      };

      const systemWithBodies = { ...system, planets: [bodyA, bodyB, gasGiant] };
      const stateBase = createBaseState({
        systems: [systemWithBodies],
        planetSurfaceDescriptorsByBodyId: { [bodyA.id]: descriptors[bodyA.id], [bodyB.id]: descriptors[bodyB.id] }
      });
      const mapA = getSurfaceMapOrThrow(stateBase, bodyA.id);
      const mapB = getSurfaceMapOrThrow(stateBase, bodyB.id);

      const blueAssaultA = createArmiesOnSettlements({ map: mapA, factionId: 'blue', baseId: 'army-blue-a', members: 20000 });
      const redGarrisonB = createArmiesOnSettlements({ map: mapB, factionId: 'red', baseId: 'army-red-b', members: 8000 });

      const initialState = { ...stateBase, armies: [...blueAssaultA, ...redGarrisonB] };
      const ctxFirst = { rng: new RNG(25), turn: initialState.day + 1 };

      const afterFirst = phaseGround(initialState, ctxFirst);
      const systemAfterFirst = afterFirst.systems.find(sys => sys.id === system.id);
      const bodyAAfter = systemAfterFirst?.planets.find(planet => planet.id === bodyA.id);
      const bodyBAfter = systemAfterFirst?.planets.find(planet => planet.id === bodyB.id);

      assert.strictEqual(bodyAAfter?.ownerFactionId, 'blue', 'First conquered planet should switch to the attacker');
      assert.strictEqual(bodyBAfter?.ownerFactionId, 'red', 'Remaining defended planet should stay with the original owner');
      assert.strictEqual(
        systemAfterFirst?.ownerFactionId,
        'red',
        'System owner should remain unchanged while a solid planet is still defended'
      );

      const blueAssaultB = createArmiesOnSettlements({ map: mapB, factionId: 'blue', baseId: 'army-blue-b', members: 15000 });
      const reinforcedState: GameState = {
        ...afterFirst,
        armies: [...afterFirst.armies.filter(army => !army.id.startsWith('army-red-b')), ...blueAssaultB]
      };
      const ctxSecond = { rng: new RNG(27), turn: ctxFirst.turn + 1 };

      const afterSecond = phaseGround(reinforcedState, ctxSecond);
      const systemAfterSecond = afterSecond.systems.find(sys => sys.id === system.id);
      const gasOwner = systemAfterSecond?.planets.find(planet => planet.id === gasGiant.id)?.ownerFactionId;

      assert.strictEqual(systemAfterSecond?.ownerFactionId, 'blue', 'System owner should flip once all solid planets are captured');
      assert.strictEqual(
        gasOwner,
        'red',
        'Non-solid bodies should not block conquest and should retain their previous owner'
      );
    }
  },
  {
    name: 'Conquest exports remain referenced outside their module',
    run: () => {
      const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
      const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
      const tsConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(tsConfig.config, ts.sys, projectRoot);
      const fileNames = parsedConfig.fileNames.filter(file => !file.includes('node_modules'));

      const languageServiceHost: ts.LanguageServiceHost = {
        getScriptFileNames: () => fileNames,
        getScriptVersion: () => '0',
        getScriptSnapshot: fileName => {
          const fileText = ts.sys.readFile(fileName);
          return fileText === undefined ? undefined : ts.ScriptSnapshot.fromString(fileText);
        },
        getCurrentDirectory: () => projectRoot,
        getCompilationSettings: () => parsedConfig.options,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory
      };

      const service = ts.createLanguageService(languageServiceHost, ts.createDocumentRegistry());
      const program = service.getProgram();

      assert.ok(program, 'Unable to create TypeScript program for orphan helper detection');

      const conquestPathSuffix = '/engine/conquest.ts';
      const conquestPath = fileNames.find(file =>
        file.replace(/\\/g, '/').toLowerCase().endsWith(conquestPathSuffix)
      );
      assert.ok(conquestPath, 'Conquest source should be part of the TypeScript program');
      const conquestSource = program!.getSourceFile(conquestPath!);
      assert.ok(conquestSource, 'Conquest source should be part of the TypeScript program');

      const checker = program!.getTypeChecker();
      const conquestSymbol = checker.getSymbolAtLocation(conquestSource!);
      assert.ok(conquestSymbol, 'Conquest module symbol should be available for analysis');

      const exportedValues = checker
        .getExportsOfModule(conquestSymbol!)
        .filter(symbol => symbol.getEscapedName() !== 'default' && (symbol.getFlags() & ts.SymbolFlags.Value));

      const orphans: string[] = [];

      exportedValues.forEach(symbol => {
        const declarations = symbol.getDeclarations() ?? [];
        const hasExternalReference = declarations.some(declaration => {
          const declarationName = ts.getNameOfDeclaration(declaration);
          if (!declarationName || !ts.isIdentifier(declarationName)) {
            return false;
          }

          const references = service.findReferences(conquestPath, declarationName.getStart());
          return references?.flatMap(ref => ref.references).some(ref => ref.fileName !== conquestPath && !ref.isDefinition) ?? false;
        });

        if (!hasExternalReference) {
          orphans.push(symbol.getName());
        }
      });

      if (orphans.length > 0) {
        throw new Error(`Orphan exports in engine/conquest.ts: ${orphans.join(', ')}`);
      }
    }
  },
  {
    name: 'System colors fallback to faction or default during save round-trip',
    run: () => {
      const redSystem: StarSystem = { ...createSystem('sys-red-fallback', 'red'), color: '' };
      const neutralSystem: StarSystem = { ...createSystem('sys-neutral-fallback', null), color: '' };

      const state = createBaseState({ systems: [redSystem, neutralSystem] });

      const saved = serializeGameState(state);
      const restored = deserializeGameState(saved);

      const reloadedRed = restored.systems.find(system => system.id === redSystem.id);
      const reloadedNeutral = restored.systems.find(system => system.id === neutralSystem.id);

      const redColor = factions.find(faction => faction.id === 'red')?.color;

      assert.strictEqual(reloadedRed?.color, redColor, 'Owned systems should inherit their faction color when unset');
      assert.strictEqual(
        reloadedNeutral?.color,
        '#ffffff',
        'Neutral systems should default to white when missing an explicit color'
      );
    }
  },
  {
    name: 'AI planning remains deterministic after save/load',
    run: () => {
      const greenHome: StarSystem = { ...createSystem('sys-green-core', 'green'), position: { x: 0, y: 0, z: 0 } };
      const greenOutpost: StarSystem = { ...createSystem('sys-green-outpost', 'green'), position: { x: 50, y: 0, z: 0 } };
      const redFront: StarSystem = { ...createSystem('sys-red-front', 'red'), position: { x: 100, y: 0, z: 0 } };

      const greenFleet = createFleet('fleet-green-det', 'green', { ...greenHome.position }, [
        { id: 'ship-green-1', type: ShipType.FIGHTER, hp: 100, maxHp: 100, carriedArmyId: null }
      ]);

      const redFleet = createFleet('fleet-red-det', 'red', { ...redFront.position }, [
        { id: 'ship-red-1', type: ShipType.FIGHTER, hp: 100, maxHp: 100, carriedArmyId: null }
      ]);

      const aiState: AIState = {
        ...createEmptyAIState(),
        holdUntilTurnBySystemId: {
          [greenOutpost.id]: 4,
          [greenHome.id]: 3
        },
        targetPriorities: {
          [redFront.id]: 200,
          [greenOutpost.id]: 110
        },
        systemLastSeen: {
          [greenHome.id]: 0,
          [greenOutpost.id]: 0,
          [redFront.id]: 0
        },
        lastOwnerBySystemId: {
          [greenHome.id]: 'green',
          [greenOutpost.id]: 'green',
          [redFront.id]: 'red'
        }
      };

      const rules: GameplayRules = { fogOfWar: false, useAdvancedCombat: true, aiEnabled: true, totalWar: false, unlimitedFuel: false };

      const state = createBaseState({
        day: 2,
        systems: [greenHome, greenOutpost, redFront],
        fleets: [greenFleet, redFleet],
        aiStates: { green: aiState },
        rules
      });

      const seed = 99;
      const commandsBefore = planAiTurn(state, 'green', aiState, new RNG(seed));

      const restored = deserializeGameState(serializeGameState(state));
      assert.ok(restored.aiStates?.green, 'Restored AI state should be preserved after serialization');
      const commandsAfter = planAiTurn(restored, 'green', restored.aiStates?.green, new RNG(seed));

      assert.deepStrictEqual(commandsAfter, commandsBefore, 'AI commands should remain stable after serialization round-trip');
    }
  },
  {
    name: 'AI threat evaluation does not double-count visible fleets as memory',
    run: () => {
      const aiFaction: FactionState = { id: 'ai-threat', name: 'AI Threat', color: '#00ff00', isPlayable: false, aiProfile: 'aggressive' };
      const enemyFaction: FactionState = { id: 'enemy-threat', name: 'Enemy Threat', color: '#ff0000', isPlayable: true };

      const homeSystem: StarSystem = { ...createSystem('threat-home', aiFaction.id), position: { x: 0, y: 0, z: 0 } };
      const targetSystem: StarSystem = {
        ...createSystem('threat-target', enemyFaction.id),
        position: { x: 100, y: 0, z: 0 },
        resourceType: 'gas'
      };

      const fighterShip: TestShipInput = { id: 'fighter-template', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null };
      const aiFleet = createFleet('ai-fleet-threat', aiFaction.id, { ...homeSystem.position }, [
        { ...fighterShip, id: 'ai-fighter-1' },
        { ...fighterShip, id: 'ai-fighter-2' }
      ]);
      const enemyFleet = createFleet('enemy-fleet-threat', enemyFaction.id, { ...targetSystem.position }, [
        { ...fighterShip, id: 'enemy-fighter-1' }
      ]);

      const state = createBaseState({
        factions: [aiFaction, enemyFaction],
        systems: [homeSystem, targetSystem],
        fleets: [aiFleet, enemyFleet],
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: true, totalWar: false, unlimitedFuel: false },
        playerFactionId: enemyFaction.id
      });

      const commands = planAiTurn(state, aiFaction.id, createEmptyAIState(), new RNG(13));
      const moveCommands = commands.filter((cmd): cmd is Extract<GameCommand, { type: 'MOVE_FLEET' }> => cmd.type === 'MOVE_FLEET');

      const hasAttackMove = moveCommands.some(
        cmd => cmd.targetSystemId === targetSystem.id && (cmd.reason?.includes('ATTACK') ?? false)
      );
      assert.ok(hasAttackMove, 'Expected AI to attack when a visible fleet contributes only once to threat');

      const hasScoutMove = moveCommands.some(
        cmd => cmd.targetSystemId === targetSystem.id && (cmd.reason?.includes('SCOUT') ?? false)
      );
      assert.strictEqual(hasScoutMove, false, 'Expected AI to avoid SCOUT fallback when threat is not inflated');
    }
  },
  {
    name: 'AI observed systems include non-commandable fleets under fog of war',
    run: () => {
      const aiFaction: FactionState = { id: 'ai-observe', name: 'AI Observe', color: '#00ff00', isPlayable: false, aiProfile: 'aggressive' };
      const enemyFaction: FactionState = { id: 'enemy-observe', name: 'Enemy Observe', color: '#ff0000', isPlayable: true };

      const enemySystem: StarSystem = { ...createSystem('observe-target', enemyFaction.id), position: { x: 0, y: 0, z: 0 } };
      const fighterShip: TestShipInput = { id: 'fighter-template', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null };
      const observerFleet: Fleet = {
        ...createFleet('ai-observer', aiFaction.id, { ...enemySystem.position }, [{ ...fighterShip, id: 'ai-observer-ship' }]),
        state: FleetState.COMBAT
      };

      const state = createBaseState({
        day: 5,
        factions: [aiFaction, enemyFaction],
        systems: [enemySystem],
        fleets: [observerFleet],
        rules: { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: false, unlimitedFuel: false },
        playerFactionId: enemyFaction.id
      });

      const commands = planAiTurn(state, aiFaction.id, createEmptyAIState(), new RNG(7));
      const update = commands.find((cmd): cmd is Extract<GameCommand, { type: 'AI_UPDATE_STATE' }> => cmd.type === 'AI_UPDATE_STATE');
      assert.ok(update, 'Expected AI_UPDATE_STATE command to be generated');

      assert.strictEqual(
        update.newState.systemLastSeen[enemySystem.id],
        state.day,
        'Observed system should refresh systemLastSeen even if the observing fleet is in combat'
      );
      assert.strictEqual(
        update.newState.lastOwnerBySystemId[enemySystem.id],
        enemyFaction.id,
        'Observed system owner should refresh even if the observing fleet is in combat'
      );
    }
  },
  {
    name: 'Cleanup drops embarked armies when their fleet no longer exists',
    run: () => {
      const system = createSystem('sys-cleanup-loss', null);
      const strandedArmy = createArmy('army-cleanup-loss', 'blue', 12000, ArmyState.EMBARKED, 'fleet-missing');

      const state = createBaseState({ systems: [system], armies: [strandedArmy], fleets: [] });
      const ctx = { rng: new RNG(31), turn: 4 };

      const cleaned = phaseCleanup(state, ctx);

      assert.strictEqual(
        cleaned.armies.some(army => army.id === strandedArmy.id),
        false,
        'Cleanup should remove embarked armies that lost their transport fleet'
      );

      const removalLog = cleaned.logs.find(
        log => log.text.includes(strandedArmy.id) && log.text.includes('transport fleet')
      );
      assert.ok(removalLog, 'Cleanup should record removal of embarked armies missing a fleet');
    }
  },
  {
    name: 'Orphan carriedArmyId is cleared during cleanup',
    run: () => {
      const system = createSystem('sys-3', 'blue');
      const fleet = createFleet('fleet-clean', 'blue', baseVec, [
        { id: 'transport-clean', type: ShipType.TRANSPORTER, hp: 2000, maxHp: 2000, carriedArmyId: 'missing-army' }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [] });

      const { state: sanitized, logs } = sanitizeArmies(state);
      const cleanedShip = sanitized.fleets[0].ships[0];

      assert.strictEqual(cleanedShip.carriedArmyId, null, 'Transport should drop orphaned army reference');
      assert.ok(logs.some(entry => entry.includes('missing army missing-army')), 'Cleanup should log the fix');
    }
  },
  {
    name: 'Duplicate claims resolve deterministically to a single carrier',
    run: () => {
      const system = createSystem('sys-4', 'blue');
      const army = createArmy('army-shared', 'blue', 15000, ArmyState.EMBARKED, 'fleet-shared');

      const fleet = createFleet('fleet-shared', 'blue', baseVec, [
        { id: 'ship-a', type: ShipType.TRANSPORTER, hp: 2000, maxHp: 2000, carriedArmyId: army.id },
        { id: 'ship-b', type: ShipType.TRANSPORTER, hp: 2000, maxHp: 2000, carriedArmyId: army.id }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [army] });

      const { state: sanitized, logs } = sanitizeArmies(state);
      const [shipA, shipB] = sanitized.fleets[0].ships;

      assert.strictEqual(shipA.carriedArmyId, army.id, 'Canonical carrier should retain the army');
      assert.strictEqual(shipB.carriedArmyId, null, 'Secondary carrier should be unlinked');
      assert.ok(logs.some(entry => entry.includes('canonical carrier is ship-a')), 'Cleanup log should cite canonical carrier');
      assert.strictEqual(sanitized.armies.length, 1, 'Army should survive cleanup with a single carrier');
    }
  },
  {
    name: 'Embarked armies without a carrier are destroyed during sanitization',
    run: () => {
      const system = createSystem('sys-5', 'blue');
      const strandedArmy = createArmy('army-stranded', 'blue', 15000, ArmyState.EMBARKED, 'fleet-stranded');

      const fleet = createFleet('fleet-stranded', 'blue', baseVec, [
        { id: 'ship-stranded', type: ShipType.TRANSPORTER, hp: 2000, maxHp: 2000, carriedArmyId: null }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [strandedArmy] });

      const { state: sanitized, logs } = sanitizeArmies(state);

      assert.strictEqual(sanitized.armies.length, 0, 'Embarked armies without transport should be removed');
      assert.strictEqual(
        sanitized.fleets[0].ships[0].carriedArmyId,
        null,
        'Transport should remain unassigned after removing orphan army'
      );
      assert.ok(logs.some(entry => entry.includes('had no transport ship')), 'Cleanup should log stranded embarked armies');
    }
  },
  {
    name: 'Army removal clears carrier links when destroyed by attrition',
    run: () => {
      const system = createSystem('sys-6', 'blue');
      const weakArmy: Army = {
        ...createArmy('army-weak', 'blue', 15000, ArmyState.EMBARKED, 'fleet-weak'),
        members: 0,
        condition: 0.1
      };

      const fleet = createFleet('fleet-weak', 'blue', baseVec, [
        { id: 'carrier-weak', type: ShipType.TRANSPORTER, hp: 2000, maxHp: 2000, carriedArmyId: weakArmy.id }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [weakArmy] });

      const { state: sanitized, logs } = sanitizeArmies(state);
      const cleanedCarrier = sanitized.fleets[0].ships[0];

      assert.strictEqual(cleanedCarrier.carriedArmyId, null, 'Carrier should free missing or destroyed armies');
      assert.strictEqual(sanitized.armies.length, 0, 'Weak embarked armies should be removed');
      assert.ok(logs.some(entry => entry.includes('out of combat')), 'Cleanup should log out-of-combat removals');
    }
  },
  {
    name: 'Player commands delegate through dispatchCommand pipeline',
    run: () => {
      const system = createSystem('alpha', 'blue');
      const fleet = createFleet('fleet-dispatch', 'blue', baseVec, []);

      const engine = new GameEngine(
        createBaseState({
          systems: [system],
          fleets: [fleet],
          rngState: 3
        })
      );

      let delegated = false;
      const originalDispatch = engine.dispatchCommand.bind(engine);
      engine.dispatchCommand = (cmd: GameCommand) => {
        delegated = true;
        return originalDispatch(cmd);
      };

      const result = engine.dispatchPlayerCommand({
        type: 'MOVE_FLEET',
        fleetId: fleet.id,
        targetSystemId: system.id
      });

      const updatedFleet = engine.state.fleets.find(f => f.id === fleet.id);

      assert.ok(result.ok, 'Player dispatch should succeed');
      assert.ok(delegated, 'dispatchPlayerCommand should call dispatchCommand for shared handling');
      assert.strictEqual(updatedFleet?.state, FleetState.MOVING, 'Shared dispatcher should perform the move');
    }
  },
  {
    name: 'AI command application matches dispatcher results',
    run: () => {
      const origin = createSystem('origin', 'blue');
      const target = { ...createSystem('target', null), position: { x: 10, y: 0, z: 0 } };
      const fleet = createFleet('fleet-ai', 'blue', baseVec, []);

      const baseState = createBaseState({
        systems: [origin, target],
        fleets: [fleet],
        day: 4,
        rngState: 5,
        seed: 99
      });

      const command: GameCommand = {
        type: 'MOVE_FLEET',
        fleetId: fleet.id,
        targetSystemId: target.id,
        turn: baseState.day,
        reason: 'ai-move'
      };

      const engine = new GameEngine(baseState);
      engine.dispatchCommand(command);

      const applied = applyCommand(baseState, command, new RNG(baseState.seed)).state;

      const dispatchedFleet = engine.state.fleets.find(f => f.id === fleet.id);
      const appliedFleet = applied.fleets.find(f => f.id === fleet.id);

      assert.deepStrictEqual(dispatchedFleet, appliedFleet, 'Dispatcher and applyCommand paths should align for AI commands');
    }
  },
  {
    name: 'Player commands are blocked when fleet is in combat',
    run: () => {
      const fleet = { ...createFleet('combat-fleet', 'blue', baseVec, []), state: FleetState.COMBAT };
      const system = createSystem('alpha', 'blue');

      const engine = new GameEngine(
        createBaseState({
          systems: [system],
          fleets: [fleet]
        })
      );

      const result = engine.dispatchPlayerCommand({
        type: 'MOVE_FLEET',
        fleetId: fleet.id,
        targetSystemId: system.id
      });

      assert.ok(!result.ok, 'Command should be blocked in combat');
      assert.strictEqual(result.error, 'Fleet is in combat and cannot receive commands.');
    }
  },
  {
    name: 'AI ignores fleets in combat when scheduling commands',
    run: () => {
      const aiFaction: FactionState = { id: 'ai', name: 'AI', color: '#00ff00', isPlayable: false, aiProfile: 'aggressive' };
      const enemyFaction: FactionState = { id: 'enemy', name: 'Enemy', color: '#ff0000', isPlayable: true };

      const systems: StarSystem[] = [
        { ...createSystem('ai-home', aiFaction.id), position: { x: 0, y: 0, z: 0 }, resourceType: 'gas' as const },
        { ...createSystem('frontier', enemyFaction.id), position: { x: 150, y: 0, z: 0 }, resourceType: 'gas' as const }
      ];

      const idleFleet = createFleet('ai-idle', aiFaction.id, { ...systems[0].position }, [
        { id: 'ai-idle-1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null },
        { id: 'ai-idle-2', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }
      ]);
      const combatFleet: Fleet = {
        ...createFleet('ai-combat', aiFaction.id, { ...systems[0].position }, [
          { id: 'ai-combat-1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }
        ]),
        state: FleetState.COMBAT
      };

      const enemyBattleFleet: Fleet = {
        ...createFleet('enemy-raid', enemyFaction.id, { ...systems[0].position }, [
          { id: 'enemy-raid-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
        ]),
        state: FleetState.COMBAT
      };
      const battle: Battle = {
        id: 'battle-frontier',
        systemId: systems[0].id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [combatFleet.id, enemyBattleFleet.id],
        logs: []
      };

      const state = createBaseState({
        factions: [aiFaction, enemyFaction],
        systems,
        fleets: [idleFleet, combatFleet, enemyBattleFleet],
        battles: [battle],
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: true, totalWar: false, unlimitedFuel: false },
        playerFactionId: enemyFaction.id
      });

      const commands = planAiTurn(state, aiFaction.id, createEmptyAIState(), new RNG(99));
      const moveCommands = commands.filter(cmd => cmd.type === 'MOVE_FLEET');

      assert.strictEqual(moveCommands.length, 1, 'AI should issue one move toward the frontier system');
      assert.strictEqual(moveCommands[0].fleetId, idleFleet.id, 'Only commandable fleets should be moved');
      assert.ok(
        !commands.some(
          cmd => cmd.type !== 'AI_UPDATE_STATE' && 'fleetId' in cmd && (cmd as { fleetId?: string }).fleetId === combatFleet.id
        ),
        'Combat fleets must be ignored'
      );
    }
  },
  {
    name: 'AI ignores retreating fleets when scheduling commands',
    run: () => {
      const aiFaction: FactionState = { id: 'ai-retreat', name: 'AI Retreat', color: '#00ff00', isPlayable: false, aiProfile: 'aggressive' };
      const enemyFaction: FactionState = { id: 'enemy-retreat', name: 'Enemy Retreat', color: '#ff0000', isPlayable: true };

      const systems: StarSystem[] = [
        { ...createSystem('retreat-home', aiFaction.id), position: { x: 0, y: 0, z: 0 }, resourceType: 'gas' as const },
        { ...createSystem('retreat-frontier', enemyFaction.id), position: { x: 200, y: 0, z: 0 }, resourceType: 'gas' as const }
      ];

      const retreatingFleet: Fleet = {
        ...createFleet('ai-retreating', aiFaction.id, { ...systems[0].position }, [
          { id: 'ai-retreating-1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }
        ]),
        retreating: true
      };
      const readyFleet = createFleet('ai-ready', aiFaction.id, { ...systems[0].position }, [
        { id: 'ai-ready-1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }
      ]);

      const enemyFrontierFleet = createFleet('enemy-retreat-frontier', enemyFaction.id, { ...systems[1].position }, [
        { id: 'enemy-retreat-1', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const state = createBaseState({
        factions: [aiFaction, enemyFaction],
        systems,
        fleets: [retreatingFleet, readyFleet, enemyFrontierFleet],
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: true, totalWar: false, unlimitedFuel: false },
        playerFactionId: enemyFaction.id
      });

      const commands = planAiTurn(state, aiFaction.id, createEmptyAIState(), new RNG(7));
      const moveCommands = commands.filter(cmd => cmd.type === 'MOVE_FLEET');

      assert.strictEqual(moveCommands.length, 1, 'AI should still act with available fleets');
      assert.strictEqual(moveCommands[0].fleetId, readyFleet.id, 'Only non-retreating fleets should move');
      assert.ok(
        !commands.some(
          cmd => cmd.type !== 'AI_UPDATE_STATE' && 'fleetId' in cmd && (cmd as { fleetId?: string }).fleetId === retreatingFleet.id
        ),
        'Retreating fleets must be ignored'
      );
    }
  },
  {
    name: 'AI increases required power when ground defenders are present',
    run: () => {
      const aiFaction: FactionState = { id: 'ai-ground', name: 'AI Ground', color: '#00ff00', isPlayable: false, aiProfile: 'aggressive' };
      const enemyFaction: FactionState = { id: 'enemy-ground', name: 'Enemy Ground', color: '#ff0000', isPlayable: true };

      const homeSystem = { ...createSystem('ground-home', aiFaction.id), resourceType: 'gas' as const };
      const targetSystem = { ...createSystem('ground-target', enemyFaction.id), resourceType: 'gas' as const };
      const fighterShip: TestShipInput = { id: 'fighter-template', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null };

      const createAssaultFleet = (id: string): Fleet =>
        createFleet(id, aiFaction.id, { ...homeSystem.position }, [
          { ...fighterShip, id: `${id}-ship-1` },
          { ...fighterShip, id: `${id}-ship-2` }
        ]);

      const assaultFleetA = createAssaultFleet('ai-assault-a');
      const assaultFleetB = createAssaultFleet('ai-assault-b');

      const defenders: Army[] = [
        createArmy('enemy-def-1', enemyFaction.id, 4000, ArmyState.DEPLOYED, targetSystem.planets[0].id),
        createArmy('enemy-def-2', enemyFaction.id, 4000, ArmyState.DEPLOYED, targetSystem.planets[0].id),
        createArmy('enemy-def-3', enemyFaction.id, 4000, ArmyState.DEPLOYED, targetSystem.planets[0].id)
      ];

      const state = createBaseState({
        factions: [aiFaction, enemyFaction],
        systems: [homeSystem, targetSystem],
        fleets: [assaultFleetA, assaultFleetB],
        armies: defenders,
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: true, totalWar: false, unlimitedFuel: false },
        playerFactionId: enemyFaction.id
      });

      const commands = planAiTurn(state, aiFaction.id, createEmptyAIState(), new RNG(13));
      const moveCommands = commands.filter((cmd): cmd is Extract<GameCommand, { type: 'MOVE_FLEET' }> => cmd.type === 'MOVE_FLEET');

      assert.strictEqual(moveCommands.length, 2, 'AI should commit multiple fleets to overcome ground defenses');
      moveCommands.forEach(cmd => {
        assert.strictEqual(cmd.targetSystemId, targetSystem.id, 'Target system should be prioritized despite defenders');
      });
    }
  }
];

// ============================================================
// Additional consolidated engine tests (was: engine/tests/*.spec.ts)
// ============================================================

// --- rangeConsistency.spec.ts ---

tests.push(
  {
    name: 'Squared capture range matches base constant and orbit proximity stays in sync',
    run: () => {
      assert.strictEqual(CAPTURE_RANGE_SQ, CAPTURE_RANGE * CAPTURE_RANGE, 'CAPTURE_RANGE_SQ should match squared base range');
      assert.strictEqual(
        ORBIT_PROXIMITY_RANGE_SQ >= CAPTURE_RANGE_SQ,
        true,
        'Orbit proximity envelope should not be narrower than capture range'
      );
    }
  },
  {
    name: 'Fleets within capture range contest orbit and trigger battle detection',
    run: () => {
      const inRange = CAPTURE_RANGE - 0.1;
      const localFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const system: StarSystem = {
        id: 'alpha',
        name: 'alpha',
        position: { x: 0, y: 0, z: 0 },
        color: '#ffffff',
        size: 1,
        ownerFactionId: null,
        resourceType: 'none',
        isHomeworld: false,
        planets: []
      };

      const mkFleet = (id: string, factionId: string, x: number): Fleet => ({
        id,
        factionId,
        ships: [
          {
            id: `${id}-ship`,
            type: ShipType.FRIGATE,
            hp: 100,
            maxHp: 100,
            fuel: 100,
            carriedArmyId: null
          }
        ],
        position: { x, y: 0, z: 0 },
        state: FleetState.ORBIT,
        targetSystemId: null,
        targetPosition: null,
        radius: 1,
        stateStartTurn: 0
      });

      const state: GameState = {
        scenarioId: 'test',
        playerFactionId: 'blue',
        factions: localFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [system],
        fleets: [mkFleet('fleet-blue', 'blue', inRange), mkFleet('fleet-red', 'red', -inRange)],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        aiStates: {},
        objectives: { conditions: [] },
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: false, totalWar: false, unlimitedFuel: false }
      };

      const orbitContested = isOrbitContested(state.systems[0], state.fleets);
      const battles = detectNewBattles(state, 0);

      assert.strictEqual(orbitContested, true, 'Orbit should be contested when fleets are inside capture range');
      assert.strictEqual(battles.length, 1, 'Battle should be scheduled when multiple factions contest a system');
    }
  },
  {
    name: 'Fleets outside capture range neither contest nor trigger battles',
    run: () => {
      const outOfRange = CAPTURE_RANGE + 0.01;
      const localFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const system: StarSystem = {
        id: 'alpha',
        name: 'alpha',
        position: { x: 0, y: 0, z: 0 },
        color: '#ffffff',
        size: 1,
        ownerFactionId: null,
        resourceType: 'none',
        isHomeworld: false,
        planets: []
      };

      const mkFleet = (id: string, factionId: string, x: number): Fleet => ({
        id,
        factionId,
        ships: [
          {
            id: `${id}-ship`,
            type: ShipType.FRIGATE,
            hp: 100,
            maxHp: 100,
            fuel: 100,
            carriedArmyId: null
          }
        ],
        position: { x, y: 0, z: 0 },
        state: FleetState.ORBIT,
        targetSystemId: null,
        targetPosition: null,
        radius: 1,
        stateStartTurn: 0
      });

      const state: GameState = {
        scenarioId: 'test',
        playerFactionId: 'blue',
        factions: localFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [system],
        fleets: [mkFleet('fleet-blue', 'blue', outOfRange), mkFleet('fleet-red', 'red', -outOfRange)],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        aiStates: {},
        objectives: { conditions: [] },
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: false, totalWar: false, unlimitedFuel: false }
      };

      const orbitContested = isOrbitContested(state.systems[0], state.fleets);
      const battles = detectNewBattles(state, 0);

      assert.strictEqual(orbitContested, false, 'Orbit should not be contested just outside capture range');
      assert.strictEqual(battles.length, 0, 'No battle should be scheduled when fleets are out of range');
    }
  },
  {
    name: 'Battle detection tie-breaks by system id when distances are equal',
    run: () => {
      const localFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const systemAlpha: StarSystem = {
        id: 'alpha',
        name: 'alpha',
        position: { x: -1, y: 0, z: 0 },
        color: '#ffffff',
        size: 1,
        ownerFactionId: null,
        resourceType: 'none',
        isHomeworld: false,
        planets: []
      };

      const systemBeta: StarSystem = {
        id: 'beta',
        name: 'beta',
        position: { x: 1, y: 0, z: 0 },
        color: '#ffffff',
        size: 1,
        ownerFactionId: null,
        resourceType: 'none',
        isHomeworld: false,
        planets: []
      };

      const mkFleet = (id: string, factionId: string): Fleet => ({
        id,
        factionId,
        ships: [
          {
            id: `${id}-ship`,
            type: ShipType.FRIGATE,
            hp: 100,
            maxHp: 100,
            fuel: 100,
            carriedArmyId: null
          }
        ],
        position: { x: 0, y: 0, z: 0 },
        state: FleetState.ORBIT,
        targetSystemId: null,
        targetPosition: null,
        radius: 1,
        stateStartTurn: 0
      });

      const state: GameState = {
        scenarioId: 'test',
        playerFactionId: 'blue',
        factions: localFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [systemBeta, systemAlpha],
        fleets: [mkFleet('fleet-blue', 'blue'), mkFleet('fleet-red', 'red')],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        aiStates: {},
        objectives: { conditions: [] },
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: false, totalWar: false, unlimitedFuel: false }
      };

      const battles = detectNewBattles(state, 0);
      assert.strictEqual(battles.length, 1, 'Battle should be scheduled when contested');
      assert.strictEqual(battles[0].systemId, 'alpha', 'Tie-breaker should pick the lowest system id');
    }
  }
);

// --- stellarSystemGen.spec.ts ---

const engine_isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

tests.push(
  {
    name: 'Stellar system generation is deterministic for same inputs',
    run: () => {
      const a = generateStellarSystem({ worldSeed: 42, systemId: 'sys_test_1' });
      const b = generateStellarSystem({ worldSeed: 42, systemId: 'sys_test_1' });
      assert.deepStrictEqual(a, b);
    }
  },
  {
    name: 'Per-system astro generation is isolated from call order',
    run: () => {
      const a1 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_A' });
      const b1 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_B' });

      const b2 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_B' });
      const a2 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_A' });

      assert.deepStrictEqual(a1, a2);
      assert.deepStrictEqual(b1, b2);
    }
  },
  {
    name: 'Generated astro payload respects basic numeric invariants',
    run: () => {
      for (let seed = 1; seed <= 50; seed++) {
        const sys = generateStellarSystem({ worldSeed: seed, systemId: `sys_${seed}` });

        assert.ok(engine_isFiniteNumber(sys.seed));
        assert.ok(sys.starCount >= 1 && sys.starCount <= 3);
        assert.ok(Array.isArray(sys.stars) && sys.stars.length >= 1);
        assert.ok(Array.isArray(sys.planets));
        assert.ok(sys.planets.length <= 10);

        assert.ok(engine_isFiniteNumber(sys.derived.luminosityTotalLSun) && sys.derived.luminosityTotalLSun > 0);
        assert.ok(engine_isFiniteNumber(sys.derived.snowLineAu) && sys.derived.snowLineAu >= 0);
        assert.ok(engine_isFiniteNumber(sys.derived.hzInnerAu) && sys.derived.hzInnerAu >= 0);
        assert.ok(engine_isFiniteNumber(sys.derived.hzOuterAu) && sys.derived.hzOuterAu >= sys.derived.hzInnerAu);

        for (const star of sys.stars) {
          assert.ok(engine_isFiniteNumber(star.massSun) && star.massSun > 0);
          assert.ok(engine_isFiniteNumber(star.radiusSun) && star.radiusSun > 0);
          assert.ok(engine_isFiniteNumber(star.luminositySun) && star.luminositySun > 0);
          assert.ok(engine_isFiniteNumber(star.teffK) && star.teffK > 0);
          if (star.role === 'companion') {
            assert.ok(star.orbit, 'Companion stars should include orbit data');
            assert.ok(engine_isFiniteNumber(star.orbit?.semiMajorAxisAu) && star.orbit?.semiMajorAxisAu > 0);
            assert.ok(engine_isFiniteNumber(star.orbit?.periodDays) && star.orbit?.periodDays > 0);
            assert.ok(engine_isFiniteNumber(star.orbit?.phaseDeg));
            assert.ok(engine_isFiniteNumber(star.orbit?.inclinationDeg));
            assert.ok(engine_isFiniteNumber(star.orbit?.ascendingNodeDeg));
          }
        }

        let lastA = 0;
        for (const planet of sys.planets) {
          assert.ok(engine_isFiniteNumber(planet.semiMajorAxisAu));
          assert.ok(planet.semiMajorAxisAu >= 0.03 && planet.semiMajorAxisAu <= 60);
          assert.ok(planet.semiMajorAxisAu >= lastA);
          lastA = planet.semiMajorAxisAu;

          assert.ok(engine_isFiniteNumber(planet.eccentricity));
          assert.ok(planet.eccentricity >= 0 && planet.eccentricity <= 0.95);
          assert.ok(engine_isFiniteNumber(planet.orbitInclinationDeg));
          assert.ok(planet.orbitInclinationDeg >= 0 && planet.orbitInclinationDeg <= 60);
          assert.ok(engine_isFiniteNumber(planet.orbitAscendingNodeDeg));

          assert.ok(engine_isFiniteNumber(planet.massEarth) && planet.massEarth > 0);
          assert.ok(engine_isFiniteNumber(planet.radiusEarth) && planet.radiusEarth > 0);
          assert.ok(engine_isFiniteNumber(planet.gravityG) && planet.gravityG > 0);

          const expectedG = planet.massEarth / (planet.radiusEarth * planet.radiusEarth);
          assert.ok(Math.abs(planet.gravityG - expectedG) < 1e-9);

          assert.ok(engine_isFiniteNumber(planet.climateK));
          assert.ok(planet.climateK >= 30 && planet.climateK <= 2000);
          assert.ok(engine_isFiniteNumber(planet.greenhouseK));
          assert.ok(planet.greenhouseK >= 0);
          assert.ok(engine_isFiniteNumber(planet.airMassIndex));
          assert.ok(planet.airMassIndex >= 0 && planet.airMassIndex <= 1);
          assert.ok(engine_isFiniteNumber(planet.temperatureK));
          assert.ok(planet.temperatureK >= 30 && planet.temperatureK <= 2000);

          for (const moon of planet.moons) {
            assert.ok(engine_isFiniteNumber(moon.orbitDistanceRp));
            assert.ok(moon.orbitDistanceRp >= 6 && moon.orbitDistanceRp <= 400);
            assert.ok(engine_isFiniteNumber(moon.massEarth) && moon.massEarth >= 0);
            assert.ok(engine_isFiniteNumber(moon.radiusEarth) && moon.radiusEarth > 0);
            assert.ok(engine_isFiniteNumber(moon.gravityG) && moon.gravityG >= 0);
            assert.ok(engine_isFiniteNumber(moon.climateK));
            assert.ok(moon.climateK >= 30 && moon.climateK <= 2000);
            assert.ok(engine_isFiniteNumber(moon.greenhouseK));
            assert.ok(moon.greenhouseK >= 0);
            assert.ok(engine_isFiniteNumber(moon.airMassIndex));
            assert.ok(moon.airMassIndex >= 0 && moon.airMassIndex <= 1);
            assert.ok(engine_isFiniteNumber(moon.temperatureK));
            assert.ok(moon.temperatureK >= 30 && moon.temperatureK <= 2000);
          }
        }
      }
    }
  }
);

// --- planetSurfaceGen.spec.ts ---

const engine_hashSurface = (map: ReturnType<typeof generateSurfaceMap>): number => {
  let h = fnv1a32(`${map.bodyId}|${map.systemId}|${map.seaLevelElev}|${map.descriptor.seed}`);
  for (const t of map.tiles) {
    h = fnv1a32(`${h}|${t.elev}|${t.tempC2}|${t.moist}|${t.biome}|${t.featureBits}`);
  }
  for (const s of map.settlements) {
    h = fnv1a32(`${h}|${s.id}|${s.type}|${s.factionId ?? ''}|${s.coord.q},${s.coord.r}|${s.population}|${s.isCapital ? 1 : 0}`);
  }
  return h >>> 0;
};

const engine_isWaterBiome = (biome: string): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';

const ENGINE_MIN_LIQUID_WATER_PRESSURE_BAR = 0.08;
const ENGINE_FREEZE_POINT_BASE_K = 273.15;
const ENGINE_FREEZE_POINT_MIN_PRESSURE_K = 276;
const ENGINE_BOILING_POINT_K = 373.15;

const engine_computeEffectiveFreezingPointK = (pressureBar: number): number => {
  const normalized = Math.max(
    0,
    Math.min(1, (pressureBar - ENGINE_MIN_LIQUID_WATER_PRESSURE_BAR) / (1 - ENGINE_MIN_LIQUID_WATER_PRESSURE_BAR))
  );
  return ENGINE_FREEZE_POINT_MIN_PRESSURE_K + (ENGINE_FREEZE_POINT_BASE_K - ENGINE_FREEZE_POINT_MIN_PRESSURE_K) * normalized;
};

const engine_resolveHydrologyMode = (
  planetData: PlanetData,
  maxLiquidWaterK?: number
): 'none' | 'frozen' | 'liquid' => {
  if (planetData.atmosphere === 'None') return 'none';
  if (!engine_isFiniteNumber(planetData.pressureBar) || planetData.pressureBar < ENGINE_MIN_LIQUID_WATER_PRESSURE_BAR) return 'none';
  const climateK = engine_isFiniteNumber(planetData.climateK) ? planetData.climateK : planetData.temperatureK;
  const liquidCapK = engine_isFiniteNumber(maxLiquidWaterK) ? maxLiquidWaterK : Number.POSITIVE_INFINITY;
  if (climateK > liquidCapK) return 'none';
  const freezePointK = engine_computeEffectiveFreezingPointK(planetData.pressureBar);
  return climateK < freezePointK ? 'frozen' : 'liquid';
};

const engine_labelComponents = (mask: Uint8Array, w: number, h: number, wrapX: boolean): { labels: Int32Array; sizes: number[] } => {
  const n = w * h;
  const labels = new Int32Array(n);
  labels.fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(n);
  let label = 0;

  for (let i = 0; i < n; i += 1) {
    if (labels[i] !== -1) continue;
    if (!mask[i]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    let size = 0;

    while (head < tail) {
      const idx = queue[head++];
      size += 1;
      const c = { q: idx % w, r: Math.floor(idx / w) };
      const ns = neighborsAxial(c, w, h, wrapX);
      for (const nCoord of ns) {
        const ni = nCoord.r * w + nCoord.q;
        if (labels[ni] !== -1) continue;
        if (!mask[ni]) continue;
        labels[ni] = label;
        queue[tail++] = ni;
      }
    }

    sizes[label] = size;
    label += 1;
  }

  return { labels, sizes };
};

const engine_getFirstSolidPlanet = (
  worldSeed: number,
  systemId: string
): { body: PlanetBody; planetData: PlanetData } => {
  const astro = generateStellarSystem({ worldSeed, systemId });
  const system = { id: systemId, name: 'Test', ownerFactionId: null as any };
  const bodies = buildPlanetBodies(system, astro, []);
  const first = bodies.find(b => b.isSolid && b.bodyType === 'planet');
  assert.ok(first, 'Expected at least one solid planet body');

  const match = new RegExp(`^planet-${systemId}-(\\d+)$`).exec(first.id);
  assert.ok(match, `Expected a canonical planet id, got ${first.id}`);
  const planetIndex = Number(match[1]) - 1;
  assert.ok(Number.isFinite(planetIndex) && planetIndex >= 0);
  const planetData = astro.planets[planetIndex];
  assert.ok(planetData, 'Expected matching planet data');
  return { body: first, planetData };
};

tests.push(
  {
    name: 'Planet surface generation is deterministic for same descriptor + astro inputs',
    run: () => {
      const worldSeed = 42;
      const systemId = 'sys_surface_test';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);

      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const a = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: 'blue' });
      const b = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: 'blue' });
      assert.strictEqual(engine_hashSurface(a), engine_hashSurface(b));
    }
  },
  {
    name: 'Generated surface respects grid dimensions and tile count',
    run: () => {
      const worldSeed = 7;
      const systemId = 'sys_surface_dims';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });
      const expectedTiles = getSurfaceTileCount(descriptor);
      assert.strictEqual(map.tiles.length, expectedTiles);
    }
  },
  {
    name: 'Settlements never spawn on water tiles',
    run: () => {
      const worldSeed = 99;
      const systemId = 'sys_surface_settlements';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: 'blue' });

      for (const s of map.settlements) {
        const idx = s.tileId;
        assert.ok(idx >= 0 && idx < map.tiles.length, `Settlement tileId ${idx} out of bounds`);
        const biome = map.tiles[idx].biome;
        assert.ok(biome !== 'ocean' && biome !== 'coast' && biome !== 'lake', `Settlement spawned on water biome '${biome}'`);
      }
    }
  },
  {
    name: 'Atmosphere generation: low-mass rocky bodies are airless',
    run: () => {
      const rng = new RNG(1);
      const derived = { semiMajorAxisAu: 1, hzInnerAu: 0.95, hzOuterAu: 1.5 };
      const result = assignPlanetAtmosphere(rng, 'Terrestrial', 0.02, 0.05, 220, 1, derived);
      assert.strictEqual(result.atmosphere, 'None');
    }
  },
  {
    name: 'Atmosphere generation: massive cold super-Earth can retain primary H2/He',
    run: () => {
      const rng = new RNG(1);
      const derived = { semiMajorAxisAu: 5, hzInnerAu: 0.4, hzOuterAu: 1.2 };
      const result = assignPlanetAtmosphere(rng, 'Terrestrial', 4.2, 1.6, 140, 0.3, derived);
      assert.strictEqual(result.atmosphere, 'H2He');
      assert.ok(engine_isFiniteNumber(result.pressureBar));
    }
  },
  {
    name: 'Atmosphere generation: irregular moons remain airless',
    run: () => {
      const rng = new RNG(2);
      const result = assignMoonAtmosphere(rng, {
        moonType: 'Irregular',
        massEarth: 0.01,
        gravityG: 0.12,
        teqK: 200,
        fluxEarth: 1,
        tidalBonusK: 0
      });
      assert.strictEqual(result.atmosphere, 'None');
      assert.strictEqual(result.pressureBar, undefined);
    }
  },
  {
    name: 'Water fraction roughly matches derived waterFraction (quantile sea level invariant)',
    run: () => {
      const worldSeed = 123;
      const systemId = 'sys_surface_water';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const maxLiquidWaterK = descriptor.config.generatorVersion >= 5 ? ENGINE_BOILING_POINT_K : undefined;
      const params = deriveSurfaceParamsFromPlanet(planetData, { maxLiquidWaterK });
      const hydrologyMode = engine_resolveHydrologyMode(planetData, maxLiquidWaterK);
      const water =
        hydrologyMode === 'none'
          ? 0
          : map.tiles.filter(t => t.elev <= map.seaLevelElev).length;
      const frac = water / map.tiles.length;
      const expected = hydrologyMode === 'none' ? 0 : params.waterFraction;
      const tolerance = expected === 0 ? 0 : 0.08;

      assert.ok(Math.abs(frac - expected) <= tolerance, `Water fraction ${frac} deviates from expected ${expected}`);
    }
  },
  {
    name: 'Surface hydrology blocks liquid water on airless worlds',
    run: () => {
      const systemId = 'sys_surface_airless_rule';
      const body: PlanetBody = {
        id: `planet-${systemId}-1`,
        systemId,
        name: 'Airless',
        bodyType: 'planet',
        class: 'solid',
        ownerFactionId: null,
        size: 0.9,
        isSolid: true
      };
      const planetData: PlanetData = {
        type: 'Terrestrial',
        semiMajorAxisAu: 0.7,
        eccentricity: 0,
        orbitInclinationDeg: 0,
        orbitAscendingNodeDeg: 0,
        axialTiltDeg: 0,
        massEarth: 0.45,
        radiusEarth: 0.72,
        gravityG: 0.85,
        albedo: 0.12,
        teqK: 265,
        atmosphere: 'None',
        greenhouseK: 0,
        climateK: 265,
        airMassIndex: 0,
        temperatureK: 265,
        seasonalDeltaK: 0,
        moons: []
      };

      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: 11, systemId, body, generatorVersion: 4 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      for (const tile of map.tiles) {
        assert.ok(!engine_isWaterBiome(tile.biome), `Unexpected water biome on airless world: ${tile.biome}`);
        assert.strictEqual(tile.featureBits & FeatureBits.River, 0, 'Unexpected river on airless world');
      }
    }
  },
  {
    name: 'Surface hydrology freezes water and disables rivers on frozen worlds',
    run: () => {
      const systemId = 'sys_surface_frozen_rule';
      const body: PlanetBody = {
        id: `planet-${systemId}-1`,
        systemId,
        name: 'Frozen',
        bodyType: 'planet',
        class: 'solid',
        ownerFactionId: null,
        size: 1,
        isSolid: true
      };
      const planetData: PlanetData = {
        type: 'Terrestrial',
        semiMajorAxisAu: 1.8,
        eccentricity: 0,
        orbitInclinationDeg: 0,
        orbitAscendingNodeDeg: 0,
        axialTiltDeg: 0,
        massEarth: 1,
        radiusEarth: 1,
        gravityG: 1,
        albedo: 0.35,
        teqK: 230,
        atmosphere: 'Earthlike',
        pressureBar: 1,
        greenhouseK: 12,
        climateK: 245,
        airMassIndex: 0.6,
        temperatureK: 245,
        seasonalDeltaK: 0,
        moons: []
      };

      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: 12, systemId, body, generatorVersion: 4 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      let iceCount = 0;
      for (const tile of map.tiles) {
        assert.ok(!engine_isWaterBiome(tile.biome), `Unexpected liquid water biome on frozen world: ${tile.biome}`);
        if (tile.biome === 'ice') iceCount += 1;
        assert.strictEqual(tile.featureBits & FeatureBits.River, 0, 'Unexpected river on frozen world');
      }
      assert.ok(iceCount > 0, 'Expected some ice tiles on frozen world');
    }
  },
  {
    name: 'Surface hydrology blocks liquid water on boiling worlds',
    run: () => {
      const systemId = 'sys_surface_boiling_rule';
      const body: PlanetBody = {
        id: `planet-${systemId}-1`,
        systemId,
        name: 'Boiling',
        bodyType: 'planet',
        class: 'solid',
        ownerFactionId: null,
        size: 1,
        isSolid: true
      };
      const planetData: PlanetData = {
        type: 'Terrestrial',
        semiMajorAxisAu: 0.45,
        eccentricity: 0,
        orbitInclinationDeg: 0,
        orbitAscendingNodeDeg: 0,
        axialTiltDeg: 0,
        massEarth: 0.9,
        radiusEarth: 0.95,
        gravityG: 0.95,
        albedo: 0.1,
        teqK: 380,
        atmosphere: 'Earthlike',
        pressureBar: 1,
        greenhouseK: 10,
        climateK: 385,
        airMassIndex: 0.6,
        temperatureK: 385,
        seasonalDeltaK: 0,
        moons: []
      };

      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: 13, systemId, body, generatorVersion: 5 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      for (const tile of map.tiles) {
        assert.ok(!engine_isWaterBiome(tile.biome), `Unexpected liquid water biome on boiling world: ${tile.biome}`);
        assert.strictEqual(tile.featureBits & FeatureBits.River, 0, 'Unexpected river on boiling world');
      }
    }
  },
  {
    name: 'Surface v3 ocean tiles belong to the largest water component',
    run: () => {
      const worldSeed = 314;
      const systemId = 'sys_surface_ocean';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 3 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const { w, h, wrapX } = map.descriptor.config;
      const waterMask = new Uint8Array(map.tiles.length);
      let oceanTiles = 0;
      for (let i = 0; i < map.tiles.length; i += 1) {
        if (engine_isWaterBiome(map.tiles[i].biome)) waterMask[i] = 1;
        if (map.tiles[i].biome === 'ocean') oceanTiles += 1;
      }
      const { labels, sizes } = engine_labelComponents(waterMask, w, h, wrapX);
      if (sizes.length === 0 || oceanTiles === 0) return;

      let largestIdx = 0;
      let largestSize = sizes[0] ?? 0;
      for (let i = 1; i < sizes.length; i += 1) {
        if ((sizes[i] ?? 0) > largestSize) {
          largestSize = sizes[i] ?? 0;
          largestIdx = i;
        }
      }

      for (let i = 0; i < map.tiles.length; i += 1) {
        if (map.tiles[i].biome !== 'ocean') continue;
        assert.strictEqual(labels[i], largestIdx, 'Ocean tiles should belong to the largest water component');
      }
    }
  },
  {
    name: 'Surface v3 wrapX seam elevation deltas are within internal range',
    run: () => {
      const worldSeed = 271;
      const systemId = 'sys_surface_seam';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 3 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const { w, h, wrapX } = map.descriptor.config;
      if (!wrapX || w < 2) return;

      const seamDiffs: number[] = [];
      const internalDiffs: number[] = [];
      for (let r = 0; r < h; r += 1) {
        const leftIdx = r * w;
        const rightIdx = r * w + (w - 1);
        seamDiffs.push(Math.abs(map.tiles[leftIdx].elev - map.tiles[rightIdx].elev));
        for (let q = 0; q < w - 1; q += 1) {
          const a = r * w + q;
          const b = a + 1;
          internalDiffs.push(Math.abs(map.tiles[a].elev - map.tiles[b].elev));
        }
      }

      const maxSeam = Math.max(...seamDiffs);
      const maxInternal = Math.max(...internalDiffs);
      assert.ok(
        maxSeam <= maxInternal * 1.5 + 1,
        `Wrap seam delta ${maxSeam} exceeds internal max ${maxInternal}`
      );
    }
  },
  {
    name: 'Surface v3 water/land respects sea level after cleanup',
    run: () => {
      const worldSeed = 177;
      const systemId = 'sys_surface_sea_level';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 3 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const seaLevel = map.seaLevelElev;
      const tolerance = 1;
      for (const tile of map.tiles) {
        if (engine_isWaterBiome(tile.biome)) {
          assert.ok(tile.elev <= seaLevel + tolerance, `Water tile above sea level: ${tile.elev} > ${seaLevel}`);
        } else if (tile.biome !== 'ice') {
          assert.ok(tile.elev >= seaLevel - tolerance, `Land tile below sea level: ${tile.elev} < ${seaLevel}`);
        }
      }
    }
  },
  {
    name: 'Surface v4 ocean tiles belong to the largest water component',
    run: () => {
      const worldSeed = 414;
      const systemId = 'sys_surface_ocean_v4';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 4 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const { w, h, wrapX } = map.descriptor.config;
      const waterMask = new Uint8Array(map.tiles.length);
      let oceanTiles = 0;
      for (let i = 0; i < map.tiles.length; i += 1) {
        if (engine_isWaterBiome(map.tiles[i].biome)) waterMask[i] = 1;
        if (map.tiles[i].biome === 'ocean') oceanTiles += 1;
      }
      const { labels, sizes } = engine_labelComponents(waterMask, w, h, wrapX);
      if (sizes.length === 0 || oceanTiles === 0) return;

      let largestIdx = 0;
      let largestSize = sizes[0] ?? 0;
      for (let i = 1; i < sizes.length; i += 1) {
        if ((sizes[i] ?? 0) > largestSize) {
          largestSize = sizes[i] ?? 0;
          largestIdx = i;
        }
      }

      for (let i = 0; i < map.tiles.length; i += 1) {
        if (map.tiles[i].biome !== 'ocean') continue;
        assert.strictEqual(labels[i], largestIdx, 'Ocean tiles should belong to the largest water component');
      }
    }
  },
  {
    name: 'Surface v4 wrapX seam elevation deltas are within internal range',
    run: () => {
      const worldSeed = 272;
      const systemId = 'sys_surface_seam_v4';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 4 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const { w, h, wrapX } = map.descriptor.config;
      if (!wrapX || w < 2) return;

      const seamDiffs: number[] = [];
      const internalDiffs: number[] = [];
      for (let r = 0; r < h; r += 1) {
        const leftIdx = r * w;
        const rightIdx = r * w + (w - 1);
        seamDiffs.push(Math.abs(map.tiles[leftIdx].elev - map.tiles[rightIdx].elev));
        for (let q = 0; q < w - 1; q += 1) {
          const a = r * w + q;
          const b = a + 1;
          internalDiffs.push(Math.abs(map.tiles[a].elev - map.tiles[b].elev));
        }
      }

      const maxSeam = Math.max(...seamDiffs);
      const maxInternal = Math.max(...internalDiffs);
      assert.ok(
        maxSeam <= maxInternal * 1.5 + 1,
        `Wrap seam delta ${maxSeam} exceeds internal max ${maxInternal}`
      );
    }
  },
  {
    name: 'Surface v4 water/land respects sea level after cleanup',
    run: () => {
      const worldSeed = 178;
      const systemId = 'sys_surface_sea_level_v4';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 4 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const seaLevel = map.seaLevelElev;
      const tolerance = 1;
      for (const tile of map.tiles) {
        if (engine_isWaterBiome(tile.biome)) {
          assert.ok(tile.elev <= seaLevel + tolerance, `Water tile above sea level: ${tile.elev} > ${seaLevel}`);
        } else if (tile.biome !== 'ice') {
          assert.ok(tile.elev >= seaLevel - tolerance, `Land tile below sea level: ${tile.elev} < ${seaLevel}`);
        }
      }
    }
  },
  {
    name: 'Surface v6 ocean tiles belong to the largest water component',
    run: () => {
      const worldSeed = 514;
      const systemId = 'sys_surface_ocean_v6';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 6 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const { w, h, wrapX } = map.descriptor.config;
      const waterMask = new Uint8Array(map.tiles.length);
      let oceanTiles = 0;
      for (let i = 0; i < map.tiles.length; i += 1) {
        if (engine_isWaterBiome(map.tiles[i].biome)) waterMask[i] = 1;
        if (map.tiles[i].biome === 'ocean') oceanTiles += 1;
      }
      const { labels, sizes } = engine_labelComponents(waterMask, w, h, wrapX);
      if (sizes.length === 0 || oceanTiles === 0) return;

      let largestIdx = 0;
      let largestSize = sizes[0] ?? 0;
      for (let i = 1; i < sizes.length; i += 1) {
        if ((sizes[i] ?? 0) > largestSize) {
          largestSize = sizes[i] ?? 0;
          largestIdx = i;
        }
      }

      for (let i = 0; i < map.tiles.length; i += 1) {
        if (map.tiles[i].biome !== 'ocean') continue;
        assert.strictEqual(labels[i], largestIdx, 'Ocean tiles should belong to the largest water component');
      }
    }
  },
  {
    name: 'Surface v6 wrapX seam elevation deltas are within internal range',
    run: () => {
      const worldSeed = 372;
      const systemId = 'sys_surface_seam_v6';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 6 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const { w, h, wrapX } = map.descriptor.config;
      if (!wrapX || w < 2) return;

      const seamDiffs: number[] = [];
      const internalDiffs: number[] = [];
      for (let r = 0; r < h; r += 1) {
        const leftIdx = r * w;
        const rightIdx = r * w + (w - 1);
        seamDiffs.push(Math.abs(map.tiles[leftIdx].elev - map.tiles[rightIdx].elev));
        for (let q = 0; q < w - 1; q += 1) {
          const a = r * w + q;
          const b = a + 1;
          internalDiffs.push(Math.abs(map.tiles[a].elev - map.tiles[b].elev));
        }
      }

      const maxSeam = Math.max(...seamDiffs);
      const maxInternal = Math.max(...internalDiffs);
      assert.ok(
        maxSeam <= maxInternal * 1.5 + 1,
        `Wrap seam delta ${maxSeam} exceeds internal max ${maxInternal}`
      );
    }
  },
  {
    name: 'Surface v6 water fraction remains stable across resolutions',
    run: () => {
      const worldSeed = 618;
      const systemId = 'sys_surface_scale_v6';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const baseDescriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 6 });
      const smallDescriptor = {
        ...baseDescriptor,
        config: { ...baseDescriptor.config, w: 64, h: 32 }
      };
      const largeDescriptor = {
        ...baseDescriptor,
        config: { ...baseDescriptor.config, w: 128, h: 64 }
      };

      const mapSmall = generateSurfaceMap({ systemId, bodyId: body.id, descriptor: smallDescriptor, planetData, ownerFactionId: null });
      const mapLarge = generateSurfaceMap({ systemId, bodyId: body.id, descriptor: largeDescriptor, planetData, ownerFactionId: null });
      const waterSmall = mapSmall.tiles.filter(t => engine_isWaterBiome(t.biome)).length / mapSmall.tiles.length;
      const waterLarge = mapLarge.tiles.filter(t => engine_isWaterBiome(t.biome)).length / mapLarge.tiles.length;
      const delta = Math.abs(waterSmall - waterLarge);
      assert.ok(delta <= 0.1, `Water fraction drift ${delta} exceeds tolerance`);
    }
  },
  {
    name: 'Surface v6 water/land respects sea level after cleanup',
    run: () => {
      const worldSeed = 278;
      const systemId = 'sys_surface_sea_level_v6';
      const { body, planetData } = engine_getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body, generatorVersion: 6 });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const seaLevel = map.seaLevelElev;
      const tolerance = 1;
      for (const tile of map.tiles) {
        if (engine_isWaterBiome(tile.biome)) {
          assert.ok(tile.elev <= seaLevel + tolerance, `Water tile above sea level: ${tile.elev} > ${seaLevel}`);
        } else if (tile.biome !== 'ice') {
          assert.ok(tile.elev >= seaLevel - tolerance, `Land tile below sea level: ${tile.elev} < ${seaLevel}`);
        }
      }
    }
  }
);

tests.push({
  name: 'Geodesic grid is deterministic and has 12 pentagons',
  run: () => {
    const frequency = 6;
    const gridA = buildGeodesicGrid(frequency);
    const gridB = buildGeodesicGrid(frequency);
    assert.strictEqual(gridA.vertices.length, tileCount(frequency));
    assert.deepStrictEqual(gridA.vertices, gridB.vertices);
    assert.deepStrictEqual(gridA.neighbors, gridB.neighbors);

    const neighborCounts = gridA.neighbors.map(n => n.length);
    const pentagons = neighborCounts.filter(count => count === 5).length;
    const hexes = neighborCounts.filter(count => count === 6).length;
    assert.strictEqual(pentagons, 12);
    assert.strictEqual(pentagons + hexes, gridA.vertices.length);
  }
});

// --- planetSurfacePositions.spec.ts ---

const engine_ps_isWater = (biome: string): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';
const engine_ps_isBuildable = (biome: string): boolean => !engine_ps_isWater(biome) && biome !== 'mountain' && biome !== 'ice';

type EngineTilePick = { tileId: number; coord?: { q: number; r: number } };

const engine_ps_toSurfacePos = (bodyId: string, tile: EngineTilePick): SurfacePos => {
  return tile.coord
    ? { bodyId, tileId: tile.tileId, q: tile.coord.q, r: tile.coord.r }
    : { bodyId, tileId: tile.tileId };
};

const engine_ps_createArmy = (params: {
  id: string;
  factionId: string;
  members: number;
  state: ArmyState;
  containerId: string;
  surfacePos?: SurfacePos;
}): Army => {
  const scaledMembers = scaleMembers(params.members);
  return withGroundDefaults({
    id: params.id,
    factionId: params.factionId,
    unitType: 'mechanized_infantry',
    posture: 'normal',
    maxMembers: scaledMembers,
    members: scaledMembers,
    attack: 1,
    defense: 1,
    condition: 1,
    state: params.state,
    containerId: params.containerId,
    ...(params.surfacePos ? { surfacePos: params.surfacePos } : {})
  });
};

const engine_ps_createStateWithOneSurface = (worldSeed: number, systemId: string): { state: GameState; body: PlanetBody } => {
  const astro = generateStellarSystem({ worldSeed, systemId });
  const system = {
    id: systemId,
    name: systemId,
    position: { x: 0, y: 0, z: 0 },
    color: '#ffffff',
    size: 1,
    ownerFactionId: 'blue',
    resourceType: 'none' as const,
    isHomeworld: false,
    astro,
    planets: [] as PlanetBody[]
  };

  system.planets = buildPlanetBodies({ id: system.id, name: system.name, ownerFactionId: system.ownerFactionId }, astro, []);
  const candidatePlanets = system.planets.filter(p => p.isSolid && p.bodyType === 'planet');
  assert.ok(candidatePlanets.length > 0, 'Expected at least one solid planet body');

  let body = candidatePlanets[0];
  let descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });

  for (const candidate of candidatePlanets) {
    const candidateDescriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body: candidate });
    const planetIndex = candidateDescriptor.astroRef.planetIndex;
    const planetData = astro.planets?.[planetIndex];
    if (!planetData) continue;

    const map = generateSurfaceMap({
      systemId,
      bodyId: candidate.id,
      descriptor: candidateDescriptor,
      planetData,
      ownerFactionId: system.ownerFactionId
    });

    const maxLiquidWaterK = candidateDescriptor.config.generatorVersion >= 5 ? ENGINE_BOILING_POINT_K : undefined;
    const hydrologyMode = engine_resolveHydrologyMode(planetData, maxLiquidWaterK);
    const hasWater = hydrologyMode === 'liquid' && map.tiles.some(tile => engine_ps_isWater(tile.biome));
    const hasBuildable = map.tiles.some(tile => engine_ps_isBuildable(tile.biome));
    if (hasWater && hasBuildable) {
      body = candidate;
      descriptor = candidateDescriptor;
      break;
    }
  }

  const singleFaction: FactionState[] = [{ id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }];

  const state: GameState = {
    scenarioId: 'test',
    scenarioTitle: 'Test',
    playerFactionId: 'blue',
    factions: singleFaction,
    seed: worldSeed,
    rngState: worldSeed,
    startYear: 0,
    day: 1,
    systems: [system],
    fleets: [],
    stations: [],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: [],
    selectedFleetId: null,
    winnerFactionId: null,
    planetSurfaceDescriptorsByBodyId: {
      [body.id]: descriptor
    },
    groundBuildings: [],
    objectives: { conditions: [] },
    rules: { fogOfWar: false, aiEnabled: true, useAdvancedCombat: true, totalWar: false, unlimitedFuel: false }
  };

  return { state, body };
};

const engine_ps_findAnyTile = (
  state: GameState,
  bodyId: string,
  predicate: (biome: string) => boolean
): EngineTilePick | null => {
  const map = generateSurfaceMapForState(state, bodyId);
  assert.ok(map, 'Expected surface map');
  for (let i = 0; i < map.tiles.length; i += 1) {
    const t = map.tiles[i];
    if (!predicate(t.biome)) continue;
    const coord = getSurfaceTileCoordFromId(map.descriptor, i);
    return { tileId: i, coord: coord ?? undefined };
  }
  return null;
};

const engine_ps_pickAnyTile = (
  state: GameState,
  bodyId: string,
  predicate: (biome: string) => boolean
): EngineTilePick => {
  const match = engine_ps_findAnyTile(state, bodyId, predicate);
  if (!match) throw new Error('No matching tile found');
  return match;
};

tests.push(
  {
    name: 'save/load preserves valid army.surfacePos and groundBuildings.surfacePos',
    run: () => {
      const { state: base, body } = engine_ps_createStateWithOneSurface(42, 'sys_surface_pos');

      const land = engine_ps_pickAnyTile(base, body.id, b => !engine_ps_isWater(b));
      const buildingSpot = engine_ps_pickAnyTile(base, body.id, b => !engine_ps_isWater(b) && b !== 'mountain' && b !== 'ice');

      const withEntities: GameState = {
        ...base,
        armies: [
          engine_ps_createArmy({
            id: 'army-1',
            factionId: 'blue',
            members: 10000,
            state: ArmyState.DEPLOYED,
            containerId: body.id,
            surfacePos: engine_ps_toSurfacePos(body.id, land)
          })
        ],
        groundBuildings: [
          {
            id: 'bld-1',
            factionId: 'blue',
            type: 'outpost',
            surfacePos: engine_ps_toSurfacePos(body.id, buildingSpot)
          }
        ]
      };

      const roundTrip = deserializeGameState(serializeGameState(withEntities));
      assert.deepStrictEqual(roundTrip.armies[0].surfacePos, withEntities.armies[0].surfacePos);
      assert.deepStrictEqual(roundTrip.groundBuildings?.[0].surfacePos, withEntities.groundBuildings?.[0].surfacePos);
    }
  },
  {
    name: 'BUILD_AT rejects water tiles and rejects already-occupied building tiles',
    run: () => {
      const { state: base, body } = engine_ps_createStateWithOneSurface(7, 'sys_build');
      const land = engine_ps_pickAnyTile(base, body.id, b => !engine_ps_isWater(b) && b !== 'mountain' && b !== 'ice');
      const water = engine_ps_findAnyTile(base, body.id, b => engine_ps_isWater(b));

      if (water) {
        const fail = applyCommand(
          base,
          { type: 'BUILD_AT', factionId: 'blue', buildingType: 'outpost', at: engine_ps_toSurfacePos(body.id, water) },
          new RNG(1)
        );
        assert.ok(!fail.ok, 'Expected BUILD_AT on water to fail');
      }

      const ok1 = applyCommand(
        base,
        { type: 'BUILD_AT', factionId: 'blue', buildingType: 'outpost', at: engine_ps_toSurfacePos(body.id, land) },
        new RNG(2)
      );
      assert.ok(ok1.ok, 'Expected BUILD_AT on land to succeed');
      assert.ok(ok1.state.groundBuildings && ok1.state.groundBuildings.length === 1);

      const ok2 = applyCommand(
        ok1.state,
        { type: 'BUILD_AT', factionId: 'blue', buildingType: 'mine', at: engine_ps_toSurfacePos(body.id, land) },
        new RNG(3)
      );
      assert.ok(!ok2.ok, 'Expected second building on same tile to fail');
    }
  },
  {
    name: 'MOVE_ARMY_ON_SURFACE rejects non-passable tiles and updates position on success',
    run: () => {
      const { state: base, body } = engine_ps_createStateWithOneSurface(11, 'sys_move');
      const landA = engine_ps_pickAnyTile(base, body.id, b => !engine_ps_isWater(b));
      const map = generateSurfaceMapForState(base, body.id)!;
      let landB: EngineTilePick | null = null;
      for (let i = 0; i < map.tiles.length; i += 1) {
        const t = map.tiles[i];
        if (engine_ps_isWater(t.biome)) continue;
        if (i === landA.tileId) continue;
        const coord = getSurfaceTileCoordFromId(map.descriptor, i);
        landB = { tileId: i, coord: coord ?? undefined };
        break;
      }
      if (!landB) landB = landA;
      const water = engine_ps_findAnyTile(base, body.id, b => engine_ps_isWater(b));

      const state: GameState = {
        ...base,
        armies: [
          engine_ps_createArmy({
            id: 'army-1',
            factionId: 'blue',
            members: 10000,
            state: ArmyState.DEPLOYED,
            containerId: body.id,
            surfacePos: engine_ps_toSurfacePos(body.id, landA)
          })
        ]
      };

      if (water) {
        const fail = applyCommand(
          state,
          { type: 'MOVE_ARMY_ON_SURFACE', armyId: 'army-1', to: engine_ps_toSurfacePos(body.id, water) },
          new RNG(5)
        );
        assert.ok(!fail.ok, 'Expected move onto water to fail');
      }

      const ok = applyCommand(
        state,
        { type: 'MOVE_ARMY_ON_SURFACE', armyId: 'army-1', to: engine_ps_toSurfacePos(body.id, landB) },
        new RNG(6)
      );
      assert.ok(ok.ok, 'Expected move onto land to succeed');
      assert.deepStrictEqual(ok.state.armies[0].surfacePos, engine_ps_toSurfacePos(body.id, landB));
    }
  },
  {
    name: 'Invalid positions are deterministically relocalized on load',
    run: () => {
      const { state: base, body } = engine_ps_createStateWithOneSurface(99, 'sys_reloc');
      const save = JSON.parse(
        serializeGameState({
          ...base,
          armies: [
            engine_ps_createArmy({
              id: 'army-1',
              factionId: 'blue',
              members: 10000,
              state: ArmyState.DEPLOYED,
              containerId: body.id,
              surfacePos: { bodyId: body.id, tileId: 999999 }
            })
          ]
        })
      );

      const restoredA = deserializeGameState(JSON.stringify(save));
      const restoredB = deserializeGameState(JSON.stringify(save));
      assert.deepStrictEqual(restoredA.armies[0].surfacePos, restoredB.armies[0].surfacePos, 'Relocation should be deterministic');

      const map = generateSurfaceMapForState(restoredA, body.id)!;
      const pos = restoredA.armies[0].surfacePos!;
      assert.ok(Number.isFinite(pos.tileId), 'Relocated position must include tileId');
      assert.ok(pos.tileId >= 0 && pos.tileId < map.tiles.length);
      const biome = map.tiles[pos.tileId].biome;
      assert.ok(!engine_ps_isWater(biome), `Relocated biome must be passable, got ${biome}`);
    }
  },
  {
    name: 'Movement phase assigns surfacePos to armies auto-deployed during AI invasion',
    run: () => {
      const { state: base, body } = engine_ps_createStateWithOneSurface(1234, 'sys_invade');

      const system = base.systems[0];
      const enemySystem = {
        ...system,
        ownerFactionId: 'red',
        planets: system.planets.map(p => ({ ...p, ownerFactionId: 'red' }))
      };

      const defenderLand = engine_ps_pickAnyTile(base, body.id, b => !engine_ps_isWater(b));
      const defenderArmy = engine_ps_createArmy({
        id: 'army-def',
        factionId: 'red',
        members: 9000,
        state: ArmyState.DEPLOYED,
        containerId: body.id,
        surfacePos: engine_ps_toSurfacePos(body.id, defenderLand)
      });

      const attackerArmyId = 'army-atk';
      const fleetId = 'fleet-inv';

      const attackerArmy = engine_ps_createArmy({
        id: attackerArmyId,
        factionId: 'blue',
        members: 10000,
        state: ArmyState.EMBARKED,
        containerId: fleetId
      });

      const fleet: Fleet = {
        id: fleetId,
        factionId: 'blue',
        ships: [
          {
            id: 'ship-1',
            type: ShipType.TRANSPORTER,
            hp: 100,
            maxHp: 100,
            fuel: 100,
            carriedArmyId: attackerArmyId
          }
        ],
        position: enemySystem.position,
        state: FleetState.MOVING,
        targetSystemId: enemySystem.id,
        targetPosition: enemySystem.position,
        radius: 1,
        stateStartTurn: base.day,
        invasionTargetSystemId: enemySystem.id,
        invasionTargetPlanetId: body.id
      };

      const state: GameState = {
        ...base,
        playerFactionId: 'red',
        systems: [enemySystem],
        fleets: [fleet],
        armies: [defenderArmy, attackerArmy]
      };

      const next = phaseMovement(state, { turn: state.day, rng: new RNG(2) });
      const queued = next.armies.find(a => a.id === attackerArmyId);
      assert.ok(queued, 'Expected attacker army to exist after movement phase');
      assert.strictEqual(queued.state, ArmyState.EMBARKED, 'AI invasion should queue landing orders during movement (deployment happens in phaseGround)');
      assert.strictEqual(queued.containerId, fleetId, 'Embarked army should remain attached to the invading fleet until landing resolves');
      assert.ok(queued.landingOrder, 'Expected AI invasion to schedule a landingOrder');
      assert.strictEqual(queued.landingOrder?.to.bodyId, body.id, 'Expected landingOrder to target the invasion body');

      const map = generateSurfaceMapForState(next, body.id)!;
      const planned = queued.landingOrder!.to;
      const plannedTileId = resolveSurfaceTileId(map.descriptor, planned);
      assert.ok(plannedTileId !== null, 'landingOrder should target a valid tile');
      const plannedBiome = map.tiles[plannedTileId].biome;
      assert.ok(!engine_ps_isWater(plannedBiome), `landingOrder should target passable terrain, got biome '${plannedBiome}'`);

      const afterGround = phaseGround(next, { turn: state.day, rng: new RNG(3) });
      const landed = afterGround.armies.find(a => a.id === attackerArmyId);
      assert.ok(landed, 'Expected attacker army to exist after ground phase');
      assert.strictEqual(landed.state, ArmyState.DEPLOYED, 'Expected landingOrder to be resolved during phaseGround');
      assert.strictEqual(landed.containerId, body.id, 'Expected attacker army to be deployed onto the target body');
      assert.ok(landed.surfacePos, 'Expected deployed army to have a surfacePos');
      const landedTileId = landed.surfacePos ? resolveSurfaceTileId(map.descriptor, landed.surfacePos) : null;
      assert.strictEqual(landedTileId, plannedTileId);
    }
  },
  {
    name: 'Player invasion arrival creates a decision message and defers landing',
    run: () => {
      const { state: base, body } = engine_ps_createStateWithOneSurface(1234, 'sys_invade_player');

      const system = base.systems[0];
      const enemySystem = {
        ...system,
        ownerFactionId: 'red',
        planets: system.planets.map(p => ({ ...p, ownerFactionId: 'red' }))
      };

      const attackerArmyId = 'army-atk-player';
      const fleetId = 'fleet-inv-player';

      const attackerArmy = engine_ps_createArmy({
        id: attackerArmyId,
        factionId: 'blue',
        members: 10000,
        state: ArmyState.EMBARKED,
        containerId: fleetId
      });

      const fleet: Fleet = {
        id: fleetId,
        factionId: 'blue',
        ships: [
          {
            id: 'ship-1',
            type: ShipType.TRANSPORTER,
            hp: 100,
            maxHp: 100,
            fuel: 100,
            carriedArmyId: attackerArmyId
          }
        ],
        position: enemySystem.position,
        state: FleetState.MOVING,
        targetSystemId: enemySystem.id,
        targetPosition: enemySystem.position,
        radius: 1,
        stateStartTurn: base.day,
        invasionTargetSystemId: enemySystem.id,
        invasionTargetPlanetId: body.id
      };

      const state: GameState = {
        ...base,
        systems: [enemySystem],
        fleets: [fleet],
        armies: [attackerArmy]
      };

      const next = phaseMovement(state, { turn: state.day, rng: new RNG(2) });

      const landed = next.armies.find(a => a.id === attackerArmyId);
      assert.ok(landed, 'Expected attacker army to exist after movement phase');
      assert.strictEqual(landed.state, ArmyState.EMBARKED, 'Player invasion should not auto-deploy on arrival');
      assert.strictEqual(landed.containerId, fleetId, 'Embarked army should remain in the invading fleet');

      const decision = next.messages.find(msg => msg.type === 'INVASION_DECISION' && msg.payload?.fleetId === fleetId);
      assert.ok(decision, 'Expected an invasion decision message to be created for the player');
      assert.strictEqual(decision?.payload?.systemId, enemySystem.id);
      assert.strictEqual(decision?.payload?.planetId, body.id);

      const updatedFleet = next.fleets.find(f => f.id === fleetId);
      assert.ok(updatedFleet, 'Expected invasion fleet to exist after movement phase');
      assert.strictEqual(updatedFleet?.invasionTargetSystemId, null, 'Invasion order should be cleared after arrival processing');
      assert.strictEqual(updatedFleet?.invasionTargetPlanetId, null, 'Preferred invasion planet should be cleared after arrival processing');
    }
  },
  {
    name: 'Invasion decision is dismissed when the fleet is removed during battle resolution',
    run: () => {
      const localFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const system: StarSystem = {
        id: 'sys-inv-battle',
        name: 'Sys Inv Battle',
        position: { x: 0, y: 0, z: 0 },
        color: '#ffffff',
        size: 1,
        ownerFactionId: null,
        resourceType: 'none',
        isHomeworld: false,
        planets: []
      };

      const playerFleet: Fleet = {
        id: 'fleet-player',
        factionId: 'blue',
        ships: [],
        position: { x: 0, y: 0, z: 0 },
        state: FleetState.COMBAT,
        targetSystemId: null,
        targetPosition: null,
        radius: 1,
        stateStartTurn: 1
      };

      const enemyFleet: Fleet = {
        id: 'fleet-enemy',
        factionId: 'red',
        ships: [
          {
            id: 'enemy-ship-1',
            type: ShipType.DESTROYER,
            hp: 100,
            maxHp: 100,
            fuel: 100,
            carriedArmyId: null
          }
        ],
        position: { x: 0, y: 0, z: 0 },
        state: FleetState.COMBAT,
        targetSystemId: null,
        targetPosition: null,
        radius: 1,
        stateStartTurn: 1
      };

      const decisionMessage: GameMessage = {
        id: 'msg-invasion',
        day: 1,
        type: 'INVASION_DECISION',
        priority: 2,
        title: 'Invasion in orbit',
        subtitle: 'Decide on landing',
        lines: [],
        payload: {
          fleetId: playerFleet.id,
          systemId: system.id,
          planetId: null
        },
        read: false,
        dismissed: false,
        createdAtTurn: 1
      };

      const battle: Battle = {
        id: 'battle-inv',
        systemId: system.id,
        turnCreated: 1,
        status: 'scheduled',
        involvedFleetIds: [playerFleet.id, enemyFleet.id],
        logs: []
      };

      const state: GameState = {
        scenarioId: 'test',
        playerFactionId: 'blue',
        factions: localFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 1,
        systems: [system],
        fleets: [playerFleet, enemyFleet],
        armies: [],
        lasers: [],
        battles: [battle],
        logs: [],
        messages: [decisionMessage],
        selectedFleetId: null,
        winnerFactionId: null,
        aiStates: {},
        objectives: { conditions: [] },
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: false, totalWar: false, unlimitedFuel: false }
      };

      const next = phaseBattleResolution(state, { turn: 1, rng: new RNG(1) });
      const updated = next.messages.find(msg => msg.id === decisionMessage.id);
      assert.ok(updated, 'Expected invasion decision message to remain in state');
      assert.strictEqual(updated?.dismissed, true, 'Expected invasion decision message to be dismissed');
      assert.strictEqual(updated?.read, true, 'Expected invasion decision message to be marked as read');
    }
  }
);

// --- fogOfWar.spec.ts ---

tests.push(
  {
    name: 'Fog of war: system ownership + borders remain known, fleets obey visibility',
    run: () => {
      const fogFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const baseFogState: GameState = {
        scenarioId: 'fog-of-war',
        playerFactionId: 'blue',
        factions: fogFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [
          {
            id: 'alpha',
            name: 'Alpha',
            position: { x: 0, y: 0, z: 0 },
            color: fogFactions[0].color,
            size: 1,
            ownerFactionId: 'blue',
            resourceType: 'none',
            isHomeworld: false,
            planets: []
          },
          {
            id: 'beta',
            name: 'Beta',
            position: { x: 100, y: 0, z: 0 },
            color: fogFactions[1].color,
            size: 1,
            ownerFactionId: 'red',
            resourceType: 'none',
            isHomeworld: false,
            planets: []
          }
        ],
        fleets: [
          {
            id: 'blue-1',
            factionId: 'blue',
            ships: [],
            position: { x: 0, y: 0, z: 0 },
            state: FleetState.ORBIT,
            targetSystemId: null,
            targetPosition: null,
            radius: 1,
            stateStartTurn: 0
          },
          {
            id: 'red-1',
            factionId: 'red',
            ships: [],
            position: { x: 100, y: 0, z: 0 },
            state: FleetState.ORBIT,
            targetSystemId: null,
            targetPosition: null,
            radius: 1,
            stateStartTurn: 0
          }
        ],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        objectives: { conditions: [] },
        rules: { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: true, unlimitedFuel: false }
      };

      const view = applyFogOfWar(baseFogState, 'blue');
      const beta = view.systems.find(system => system.id === 'beta');
      assert.ok(beta, 'Beta system should exist in the view state');
      assert.strictEqual(beta?.ownerFactionId, 'red', 'Enemy ownership should remain visible even when the system is unobserved');
      assert.strictEqual(beta?.color, fogFactions[1].color, 'Enemy territorial color should remain visible for border rendering');

      const fleetIds = new Set(view.fleets.map(fleet => fleet.id));
      assert.ok(fleetIds.has('blue-1'), 'Player fleets stay visible');
      assert.ok(!fleetIds.has('red-1'), 'Unobserved enemy fleets stay hidden');
    }
  },
  {
    name: 'Fog of war: custom sensor can reveal fleets independently of defaults',
    run: () => {
      const fogFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const baseFogState: GameState = {
        scenarioId: 'fog-of-war',
        playerFactionId: 'blue',
        factions: fogFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [
          {
            id: 'alpha',
            name: 'Alpha',
            position: { x: 0, y: 0, z: 0 },
            color: fogFactions[0].color,
            size: 1,
            ownerFactionId: 'blue',
            resourceType: 'none',
            isHomeworld: false,
            planets: []
          },
          {
            id: 'beta',
            name: 'Beta',
            position: { x: 100, y: 0, z: 0 },
            color: fogFactions[1].color,
            size: 1,
            ownerFactionId: 'red',
            resourceType: 'none',
            isHomeworld: false,
            planets: []
          }
        ],
        fleets: [
          {
            id: 'blue-1',
            factionId: 'blue',
            ships: [],
            position: { x: 0, y: 0, z: 0 },
            state: FleetState.ORBIT,
            targetSystemId: null,
            targetPosition: null,
            radius: 1,
            stateStartTurn: 0
          },
          {
            id: 'red-1',
            factionId: 'red',
            ships: [],
            position: { x: 100, y: 0, z: 0 },
            state: FleetState.ORBIT,
            targetSystemId: null,
            targetPosition: null,
            radius: 1,
            stateStartTurn: 0
          }
        ],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        objectives: { conditions: [] },
        rules: { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: true, unlimitedFuel: false }
      };

      const stealthFleet = {
        ...baseFogState.fleets[1],
        id: 'red-stealth',
        position: { x: 500, y: 0, z: 0 }
      };
      const state: GameState = { ...baseFogState, fleets: [...baseFogState.fleets, stealthFleet] };
      const alwaysOnSensor = {
        id: 'omniscient',
        isVisible: () => true
      };
      const visible = isFleetVisibleToViewer(
        stealthFleet,
        state,
        'blue',
        new Set(state.systems.map(system => system.id)),
        [...defaultFleetSensors, alwaysOnSensor]
      );
      assert.ok(visible, 'Custom sensor should reveal stealth fleet regardless of range');
    }
  },
  {
    name: 'Fog of war: observed systems are cached inside visibility context for efficiency',
    run: () => {
      const fogFactions: FactionState[] = [
        { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
      ];

      const baseFogState: GameState = {
        scenarioId: 'fog-of-war',
        playerFactionId: 'blue',
        factions: fogFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [
          {
            id: 'alpha',
            name: 'Alpha',
            position: { x: 0, y: 0, z: 0 },
            color: fogFactions[0].color,
            size: 1,
            ownerFactionId: 'blue',
            resourceType: 'none',
            isHomeworld: false,
            planets: []
          },
          {
            id: 'beta',
            name: 'Beta',
            position: { x: 100, y: 0, z: 0 },
            color: fogFactions[1].color,
            size: 1,
            ownerFactionId: 'red',
            resourceType: 'none',
            isHomeworld: false,
            planets: []
          }
        ],
        fleets: [
          {
            id: 'blue-1',
            factionId: 'blue',
            ships: [],
            position: { x: 0, y: 0, z: 0 },
            state: FleetState.ORBIT,
            targetSystemId: null,
            targetPosition: null,
            radius: 1,
            stateStartTurn: 0
          },
          {
            id: 'red-1',
            factionId: 'red',
            ships: [],
            position: { x: 100, y: 0, z: 0 },
            state: FleetState.ORBIT,
            targetSystemId: null,
            targetPosition: null,
            radius: 1,
            stateStartTurn: 0
          }
        ],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        objectives: { conditions: [] },
        rules: { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: true, unlimitedFuel: false }
      };

      const observedIds = new Set<string>(['alpha']);
      const visible = isFleetVisibleToViewer(baseFogState.fleets[0], baseFogState, 'blue', observedIds);
      assert.ok(visible, 'Viewer fleet remains visible when observed systems are precomputed');
      assert.ok(observedIds.has('alpha'), 'Precomputed observed IDs are reused unchanged');
    }
  }
);

// --- immutability.spec.ts ---

const engine_withNodeEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env.NODE_ENV;

  if (typeof value === 'undefined') {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }

  try {
    run();
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
};

tests.push(
  {
    name: 'deepFreezeDev freezes objects and blocks mutations in test environment',
    run: () =>
      engine_withNodeEnv('test', () => {
        const state = { nested: { value: 1 }, list: [1, 2, 3] } as const;
        deepFreezeDev(state);
        assert(Object.isFrozen(state), 'root object should be frozen in test env');
        assert(Object.isFrozen(state.nested), 'nested object should be frozen in test env');
        assert(Object.isFrozen(state.list), 'arrays should also be frozen in test env');
        assert.throws(() => {
          (state as any).nested.value = 2;
        }, TypeError);
      })
  },
  {
    name: 'deepFreezeDev is inert outside dev/test environments',
    run: () =>
      engine_withNodeEnv('production', () => {
        const state = { counter: 0, nested: { value: 1 } };
        deepFreezeDev(state);
        assert(!Object.isFrozen(state), 'root object should remain unfrozen in production');
        state.counter += 1;
        state.nested.value = 5;
        assert.strictEqual(state.counter, 1);
        assert.strictEqual(state.nested.value, 5);
      })
  }
);

// --- fuelTransfer.spec.ts ---

tests.push({
  name: 'Tanker fuel is pooled and distributed across multiple targets',
  run: () => {
    const position = { x: 0, y: 0, z: 0 };

    const createShip = (id: string, type: ShipType, fuel: number): ShipEntity => {
      const stats = SHIP_STATS[type];
      return {
        id,
        type,
        hp: stats.maxHp,
        maxHp: stats.maxHp,
        fuel,
        carriedArmyId: null
      };
    };

    const createFleetLocal = (id: string, ships: ShipEntity[]): Fleet => ({
      id,
      factionId: 'blue',
      ships,
      position,
      state: FleetState.ORBIT,
      targetSystemId: null,
      targetPosition: null,
      radius: 1,
      stateStartTurn: 0
    });

    const createStateLocal = (fleets: Fleet[]): GameState => {
      const localFactions: FactionState[] = [{ id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }];
      return {
        scenarioId: 'test',
        playerFactionId: 'blue',
        factions: localFactions,
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 0,
        systems: [],
        fleets,
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        objectives: { conditions: [] },
        rules: { fogOfWar: false, useAdvancedCombat: true, aiEnabled: false, totalWar: false, unlimitedFuel: false }
      };
    };

    const tankerA = createShip('tanker-a', ShipType.TANKER, 1500);
    const tankerB = createShip('tanker-b', ShipType.TANKER, 2000);
    const cruiser = createShip('cruiser-1', ShipType.CRUISER, 2600);
    const destroyer = createShip('destroyer-1', ShipType.DESTROYER, 1700);
    const fighter = createShip('fighter-1', ShipType.FIGHTER, 70);

    const fleet = createFleetLocal('fleet-1', [tankerA, cruiser, destroyer, tankerB, fighter]);
    const state = createStateLocal([fleet]);
    const ctx: TurnContext = { turn: 0, rng: new RNG(1) };

    const result = phaseCleanup(state, ctx);
    const [updatedFleet] = result.fleets;
    const tankerReserve = SHIP_STATS[ShipType.TANKER].fuelCapacity * 0.1;

    const tankerAFuel = updatedFleet.ships.find(ship => ship.id === 'tanker-a')?.fuel;
    const tankerBFuel = updatedFleet.ships.find(ship => ship.id === 'tanker-b')?.fuel;
    const cruiserFuel = updatedFleet.ships.find(ship => ship.id === 'cruiser-1')?.fuel;
    const destroyerFuel = updatedFleet.ships.find(ship => ship.id === 'destroyer-1')?.fuel;
    const fighterFuel = updatedFleet.ships.find(ship => ship.id === 'fighter-1')?.fuel;

    assert.strictEqual(cruiserFuel, 3000, 'Cruiser should be fully refueled');
    assert.strictEqual(destroyerFuel, 2000, 'Destroyer should be fully refueled');
    assert.strictEqual(fighterFuel, 120, 'Fighter should be fully refueled');

    assert.strictEqual(tankerAFuel, 1200, 'First tanker should not dip below its reserve');
    assert.strictEqual(tankerBFuel, 1550, 'Second tanker should supply the remaining demand');
    assert.ok(
      tankerAFuel !== undefined && tankerBFuel !== undefined && tankerAFuel >= tankerReserve && tankerBFuel >= tankerReserve,
      'Tankers must retain their reserve fuel'
    );
  }
});

// --- aiSpatialIndex.spec.ts ---

tests.push(
  {
    name: 'SpatialIndex queryRadius includes only points inside radius',
    run: () => {
      type Point = { id: string; position: { x: number; y: number; z: number } };
      const points: Point[] = [
        { id: 'a', position: { x: 0, y: 0, z: 0 } },
        { id: 'b', position: { x: 10, y: 0, z: 0 } },
        { id: 'c', position: { x: 25, y: 0, z: 0 } }
      ];

      const index = new SpatialIndex(points, 8);
      const nearby = index.queryRadius({ x: 0, y: 0, z: 0 }, 12).map(p => p.id);
      assert.deepStrictEqual(new Set(nearby), new Set(['a', 'b']));
    }
  },
  {
    name: 'SpatialIndex findNearest returns closest point',
    run: () => {
      type Point = { id: string; position: { x: number; y: number; z: number } };
      const points: Point[] = [
        { id: 'a', position: { x: 0, y: 0, z: 0 } },
        { id: 'b', position: { x: 10, y: 0, z: 0 } },
        { id: 'c', position: { x: 25, y: 0, z: 0 } }
      ];
      const index = new SpatialIndex(points, 8);
      const nearest = index.findNearest({ x: 13, y: 0, z: 0 });
      assert.strictEqual(nearest?.item.id, 'b');
    }
  },
  {
    name: 'SpatialIndex findNearest respects predicate filters',
    run: () => {
      type Point = { id: string; position: { x: number; y: number; z: number } };
      const points: Point[] = [
        { id: 'a', position: { x: 0, y: 0, z: 0 } },
        { id: 'b', position: { x: 10, y: 0, z: 0 } },
        { id: 'c', position: { x: 25, y: 0, z: 0 } }
      ];
      const index = new SpatialIndex(points, 8);
      const nearestMatching = index.findNearest({ x: 13, y: 0, z: 0 }, item => item.id === 'c');
      assert.strictEqual(nearestMatching?.item.id, 'c');
    }
  },
  {
    name: 'SpatialIndex behaves on empty index',
    run: () => {
      type Point = { id: string; position: { x: number; y: number; z: number } };
      const emptyIndex = new SpatialIndex<Point>([], 5);
      assert.deepStrictEqual(emptyIndex.queryRadius({ x: 0, y: 0, z: 0 }, 10), []);
      assert.strictEqual(emptyIndex.findNearest({ x: 0, y: 0, z: 0 }), null);
    }
  }
);

// --- serializationRobustness.spec.ts ---

const engine_sr_factions: FactionState[] = [{ id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }];

const engine_sr_createPlanet = (systemId: string): PlanetBody => ({
  id: `planet-${systemId}-1`,
  systemId,
  name: `${systemId} I`,
  bodyType: 'planet',
  class: 'solid',
  ownerFactionId: 'blue',
  size: 1,
  isSolid: true
});

const engine_sr_createSystem = (id: string): StarSystem => ({
  id,
  name: id,
  position: { x: 0, y: 0, z: 0 },
  color: '#ffffff',
  size: 1,
  ownerFactionId: 'blue',
  resourceType: 'none',
  isHomeworld: false,
  planets: [engine_sr_createPlanet(id)]
});

const engine_sr_createFleet = (id: string, system: StarSystem): Fleet => {
  const ship: ShipEntity = {
    id: `${id}-ship`,
    type: ShipType.FRIGATE,
    hp: 50,
    maxHp: 50,
    fuel: 50,
    carriedArmyId: null
  };

  return {
    id,
    factionId: 'blue',
    ships: [ship],
    position: { ...system.position },
    state: FleetState.ORBIT,
    targetSystemId: null,
    targetPosition: null,
    radius: 1,
    stateStartTurn: 0
  };
};

const engine_sr_createBaseState = (): GameState => {
  const system = engine_sr_createSystem('sys-1');
  const fleet = engine_sr_createFleet('fleet-1', system);
  return {
    scenarioId: 'test',
    scenarioTitle: 'Test',
    playerFactionId: 'blue',
    factions: engine_sr_factions,
    seed: 42,
    rngState: 42,
    startYear: 0,
    day: 0,
    systems: [system],
    fleets: [fleet],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: [],
    selectedFleetId: null,
    winnerFactionId: null,
    objectives: { conditions: [] },
    rules: { fogOfWar: false, aiEnabled: true, useAdvancedCombat: true, totalWar: false, unlimitedFuel: false }
  };
};

tests.push(
  {
    name: 'Deserialization rejects future save versions',
    run: () => {
      const base = engine_sr_createBaseState();
      const save = JSON.parse(serializeGameState(base));
      save.version = 999;
      assert.throws(() => deserializeGameState(JSON.stringify(save)), /not supported/);
    }
  },
  {
    name: 'Deserialization drops invalid armies',
    run: () => {
      const base = engine_sr_createBaseState();
      const save = JSON.parse(serializeGameState(base));
      const planetId = base.systems[0].planets[0].id;

      save.state.armies = [
        {
          id: 'army-bad',
          factionId: 'blue',
          unitType: 'mechanized_infantry',
          maxMembers: -5,
          members: 10,
          attack: 1,
          defense: 1,
          condition: 1,
          state: ArmyState.DEPLOYED,
          containerId: planetId
        }
      ];

      const restored = deserializeGameState(JSON.stringify(save));
      assert.strictEqual(restored.armies.length, 0);
    }
  },
  {
    name: 'Deserialization drops invalid battles',
    run: () => {
      const base = engine_sr_createBaseState();
      const save = JSON.parse(serializeGameState(base));
      const systemId = base.systems[0].id;
      const fleetId = base.fleets[0].id;

      save.state.battles = [
        {
          id: 'battle-bad',
          systemId,
          turnCreated: 0,
          status: 'unknown',
          involvedFleetIds: [fleetId],
          logs: []
        }
      ];

      const restored = deserializeGameState(JSON.stringify(save));
      assert.strictEqual(restored.battles.length, 0);
    }
  },
  {
    name: 'Deserialization truncates logs and messages to bounded sizes',
    run: () => {
      const base = engine_sr_createBaseState();
      const save = JSON.parse(serializeGameState(base));

      save.state.logs = Array.from({ length: 6000 }, (_, i) => ({
        id: `log-${i}`,
        day: i,
        text: 'test',
        type: 'info'
      }));

      save.state.messages = Array.from({ length: 1500 }, (_, i) => ({
        id: `message-${i}`,
        day: i,
        type: 'generic',
        priority: 0,
        title: 'Test',
        subtitle: '',
        lines: ['line'],
        payload: {},
        read: false,
        dismissed: false,
        createdAtTurn: i
      }));

      const restored = deserializeGameState(JSON.stringify(save));
      assert.ok(restored.logs.length < 6000);
      assert.ok(restored.messages.length < 1500);
    }
  },
  {
    name: 'Deserialization sanitizes ship hp/fuel/consumables and round-trips cleanly',
    run: () => {
      const base = engine_sr_createBaseState();
      const save = JSON.parse(serializeGameState(base));
      const ship = save.state.fleets[0].ships[0];

      ship.maxHp = 200;
      ship.hp = -10;
      ship.fuel = 1499.99994;
      ship.consumables = { offensiveMissiles: -1, torpedoes: 3.7, interceptors: 'bad' };

      const restored = deserializeGameState(JSON.stringify(save));
      const restoredShip = restored.fleets[0].ships[0];
      assert.ok(restoredShip.consumables);
      const restoredConsumables = restoredShip.consumables!;

      assert.strictEqual(restoredShip.hp, 0);
      assert.strictEqual(restoredShip.maxHp, 200);
      assert.strictEqual(restoredShip.fuel, quantizeFuel(1500));
      assert.strictEqual(restoredConsumables.offensiveMissiles, 4);

      const roundTripped = JSON.parse(serializeGameState(restored));
      const persistedShip = roundTripped.state.fleets[0].ships[0];
      assert.strictEqual(persistedShip.fuel, restoredShip.fuel);
    }
  }
);

// --- groundTerrain.spec.ts ---

tests.push({
  name: 'deriveTerrainType returns Urban for building tiles',
  run: () => {
    const seed = 101;
    const systemId = 'sys-terrain';
    const astro = generateStellarSystem({ worldSeed: seed, systemId });
    const system = {
      id: systemId,
      name: systemId,
      position: { x: 0, y: 0, z: 0 },
      color: '#ffffff',
      size: 1,
      ownerFactionId: 'blue',
      resourceType: 'none' as const,
      isHomeworld: false,
      astro,
      planets: [] as PlanetBody[]
    };
    system.planets = buildPlanetBodies({ id: system.id, name: system.name, ownerFactionId: system.ownerFactionId }, astro, []);
    const body = system.planets.find(p => p.isSolid && p.bodyType === 'planet')!;
    const descriptor = createPlanetSurfaceDescriptor({ gameSeed: seed, systemId, body });

    const localFactions: FactionState[] = [{ id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }];
    const base: GameState = {
      scenarioId: 'test',
      playerFactionId: 'blue',
      factions: localFactions,
      seed,
      rngState: seed,
      startYear: 0,
      day: 1,
      systems: [system],
      fleets: [],
      stations: [],
      armies: [],
      lasers: [],
      battles: [],
      logs: [],
      messages: [],
      selectedFleetId: null,
      winnerFactionId: null,
      planetSurfaceDescriptorsByBodyId: { [body.id]: descriptor },
      groundBuildings: [],
      objectives: { conditions: [] },
      rules: { fogOfWar: false, aiEnabled: false, useAdvancedCombat: true, totalWar: false, unlimitedFuel: false }
    };

    const map = generateSurfaceMapForState(base, body.id)!;
    const idx = map.tiles.findIndex(t => t.biome !== 'ocean');
    assert.ok(idx >= 0);
    const coord = getSurfaceTileCoordFromId(map.descriptor, idx);
    const surfacePos = coord ? { bodyId: body.id, tileId: idx, q: coord.q, r: coord.r } : { bodyId: body.id, tileId: idx };
    const state: GameState = {
      ...base,
      groundBuildings: [{ id: 'b', factionId: 'blue', type: 'outpost', surfacePos }]
    };
    const terrain = deriveTerrainType(state, body.id, idx);
    assert.strictEqual(terrain, 'Urban');
  }
});

// --- groundCombat.spec.ts ---

const groundCombatMap: PlanetSurfaceMap = {
  systemId: 'sys-ground-combat',
  bodyId: 'body-1',
  descriptor: {
    seed: 1,
    config: { w: 3, h: 3, wrapX: false, generatorVersion: 1 },
    astroRef: { planetIndex: 0 }
  },
  seaLevelElev: 0,
  tiles: Array.from({ length: 9 }, () => ({
    elev: 0,
    tempC2: 0,
    moist: 0,
    biome: 'grassland',
    featureBits: 0
  })),
  settlements: []
};

const groundCombatConfig = groundCombatMap.descriptor.config;
if (!('w' in groundCombatConfig)) {
  throw new Error('Expected rect surface config for groundCombatMap');
}
const groundCombatW = groundCombatConfig.w;
const groundCombatTileId = (q: number, r: number): number => axialToIndex({ q, r }, groundCombatW);
const groundCombatPos = (q: number, r: number): SurfacePos => ({
  bodyId: groundCombatMap.bodyId,
  q,
  r,
  tileId: groundCombatTileId(q, r)
});
const normalizeGroundCombatSurfacePos = (pos?: SurfacePos): SurfacePos | undefined => {
  if (!pos) return pos;
  if (pos.tileId !== undefined) return pos;
  if (pos.bodyId !== groundCombatMap.bodyId) return pos;
  if (pos.q === undefined || pos.r === undefined) return pos;
  return { ...pos, tileId: groundCombatTileId(pos.q, pos.r) };
};

const wrapLosMap: PlanetSurfaceMap = {
  systemId: 'sys-los-wrap',
  bodyId: 'body-los-wrap',
  descriptor: {
    seed: 1,
    config: { w: 10, h: 3, wrapX: true, generatorVersion: 1 },
    astroRef: { planetIndex: 0 }
  },
  seaLevelElev: 0,
  tiles: Array.from({ length: 30 }, () => ({
    elev: 0,
    tempC2: 0,
    moist: 0,
    biome: 'grassland',
    featureBits: 0
  })),
  settlements: []
};

const wrapLosConfig = wrapLosMap.descriptor.config;
if (!('w' in wrapLosConfig)) {
  throw new Error('Expected rect surface config for wrapLosMap');
}
const wrapLosW = wrapLosConfig.w;
const wrapLosTileId = (q: number, r: number): number => axialToIndex({ q, r }, wrapLosW);

const groundCombatMkArmy = (overrides: Partial<Army> & Pick<Army, 'id' | 'factionId'>): Army => {
  const base: Army = {
    id: overrides.id,
    factionId: overrides.factionId,
    state: ArmyState.DEPLOYED,
    containerId: groundCombatMap.bodyId,
    surfacePos: groundCombatPos(0, 0),
    unitType: 'mechanized_infantry',
    posture: 'normal',
    maxMembers: scaleMembers(10000),
    members: scaleMembers(10000),
    attack: 1,
    defense: 1,
    condition: 1,
    morale: 1,
    fatigue: 0,
    rangeMin: 1,
    rangeMax: 1,
    projectionRange: 1
  };
  const merged = { ...base, ...overrides };
  const surfacePos = normalizeGroundCombatSurfacePos(merged.surfacePos);
  return withGroundDefaults({ ...merged, ...(surfacePos ? { surfacePos } : {}) });
};

tests.push(
  {
    name: 'LOS wrapX uses the shortest path (seam blocker blocks)',
    run: () => {
      const hasLos = lineOfSight({
        map: wrapLosMap,
        fromTileId: wrapLosTileId(0, 1),
        toTileId: wrapLosTileId(8, 1),
        isBlocked: tileId => tileId === wrapLosTileId(9, 1)
      });
      assert.strictEqual(hasLos, false);
    }
  },
  {
    name: 'LOS wrapX uses the shortest path (long-side blocker does not block)',
    run: () => {
      const hasLos = lineOfSight({
        map: wrapLosMap,
        fromTileId: wrapLosTileId(0, 1),
        toTileId: wrapLosTileId(8, 1),
        isBlocked: tileId => tileId === wrapLosTileId(4, 1)
      });
      assert.strictEqual(hasLos, true);
    }
  },
  {
    name: 'Ground order commands reject non-player armies',
    run: () => {
      const base = engine_sr_createBaseState();
      const bodyId = 'body-ground-orders';
      const enemy = groundCombatMkArmy({
        id: 'enemy-1',
        factionId: 'red',
        containerId: bodyId,
        surfacePos: { bodyId, q: 0, r: 0 }
      });

      const state: GameState = { ...base, armies: [enemy] };

      const move = applyCommand(
        state,
        { type: 'ORDER_GROUND_MOVE', armyId: enemy.id, to: { bodyId, q: 1, r: 0 } },
        new RNG(1)
      );
      assert.strictEqual(move.ok, false);
      assert.strictEqual(move.error, 'Not your army');

      const posture = applyCommand(
        state,
        { type: 'SET_GROUND_POSTURE', armyId: enemy.id, posture: 'normal' },
        new RNG(1)
      );
      assert.strictEqual(posture.ok, false);
      assert.strictEqual(posture.error, 'Not your army');

      const cancel = applyCommand(
        state,
        { type: 'CANCEL_GROUND_ORDER', armyId: enemy.id },
        new RNG(1)
      );
      assert.strictEqual(cancel.ok, false);
      assert.strictEqual(cancel.error, 'Not your army');
    }
  },
  {
    name: 'SET_GROUND_POSTURE writes postureSetTurn (and clears it on normal)',
    run: () => {
      const base = engine_sr_createBaseState();
      const bodyId = 'body-ground-orders';
      const army = groundCombatMkArmy({
        id: 'player-1',
        factionId: 'blue',
        containerId: bodyId,
        surfacePos: { bodyId, q: 0, r: 0 }
      });

      const state: GameState = { ...base, day: 12, armies: [army] };

      const prepared = applyCommand(
        state,
        { type: 'SET_GROUND_POSTURE', armyId: army.id, posture: 'prepared_defense' },
        new RNG(1)
      );
      assert.strictEqual(prepared.ok, true);
      const preparedArmy = prepared.state.armies.find(a => a.id === army.id);
      assert.ok(preparedArmy);
      assert.strictEqual(preparedArmy.posture, 'prepared_defense');
      assert.strictEqual(preparedArmy.postureSetTurn, 12);

      const cleared = applyCommand(
        prepared.state,
        { type: 'SET_GROUND_POSTURE', armyId: army.id, posture: 'normal' },
        new RNG(1)
      );
      assert.strictEqual(cleared.ok, true);
      const clearedArmy = cleared.state.armies.find(a => a.id === army.id);
      assert.ok(clearedArmy);
      assert.strictEqual(clearedArmy.posture, 'normal');
      assert.strictEqual(clearedArmy.postureSetTurn, undefined);
    }
  },
  {
    name: 'CANCEL_GROUND_ORDER clears landingOrder too',
    run: () => {
      const base = engine_sr_createBaseState();
      const bodyId = 'body-ground-orders';
      const army = groundCombatMkArmy({
        id: 'player-landing-1',
        factionId: 'blue',
        state: ArmyState.EMBARKED,
        containerId: 'fleet-1',
        surfacePos: undefined,
        groundOrders: { move: { type: 'move', to: { bodyId, q: 1, r: 0 } } },
        landingOrder: { type: 'land', to: { bodyId, q: 0, r: 0 } }
      });

      const state: GameState = { ...base, armies: [army] };
      const canceled = applyCommand(state, { type: 'CANCEL_GROUND_ORDER', armyId: army.id }, new RNG(1));
      assert.strictEqual(canceled.ok, true);
      const canceledArmy = canceled.state.armies.find(a => a.id === army.id);
      assert.ok(canceledArmy);
      assert.strictEqual(canceledArmy.groundOrders, undefined);
      assert.strictEqual(canceledArmy.landingOrder, undefined);
    }
  },
  {
    name: 'Ground attack orders reject friendly targets',
    run: () => {
      const base = engine_sr_createBaseState();
      const bodyId = 'body-ground-orders';
      const a = groundCombatMkArmy({
        id: 'ally-a',
        factionId: 'blue',
        containerId: bodyId,
        surfacePos: { bodyId, q: 0, r: 0 }
      });
      const b = groundCombatMkArmy({
        id: 'ally-b',
        factionId: 'blue',
        containerId: bodyId,
        surfacePos: { bodyId, q: 1, r: 0 }
      });

      const state: GameState = { ...base, armies: [a, b] };
      const result = applyCommand(state, { type: 'ORDER_GROUND_ATTACK', attackerId: a.id, targetArmyId: b.id }, new RNG(1));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'Cannot attack friendly army.');
    }
  }
);

tests.push(
  {
    name: 'triangular RNG is bounded by epsilon',
    run: () => {
      const eps = 0.08;
      const rng = new RNG(123);
      for (let i = 0; i < 10000; i += 1) {
        const v = rollTriangularCentered(rng, eps);
        assert.ok(v >= 1 - eps && v <= 1 + eps, `Expected ${v} in [${1 - eps}, ${1 + eps}]`);
      }
    }
  },
  {
    name: 'engagement RNG is deterministic per (turn, attackerId, defenderId)',
    run: () => {
      const attacker = groundCombatMkArmy({
        id: 'a',
        factionId: 'blue',
        attack: 1.1,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 0, r: 0 }
      });
      const defender = groundCombatMkArmy({
        id: 'd',
        factionId: 'red',
        defense: 1.1,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 1, r: 0 }
      });

      const a = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });
      const b = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });
      assert.deepStrictEqual(a, b);
    }
  },
  {
    name: 'bombarded tiles apply combat multiplier + condition loss (defender)',
    run: () => {
      const attacker = groundCombatMkArmy({
        id: 'a',
        factionId: 'blue',
        members: 1,
        maxMembers: 1,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 0, r: 0 }
      });
      const defender = groundCombatMkArmy({
        id: 'd',
        factionId: 'red',
        members: 1,
        maxMembers: 1,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 1, r: 0 }
      });

      const normal = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });

      const bombarded = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        bombardedTileIds: new Set([groundCombatTileId(1, 0)]),
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });

      assert.ok(Math.abs(bombarded.defensePower - normal.defensePower * BOMBARD_COMBAT_MULT) < 1e-12);
      assert.strictEqual(bombarded.attackPower, normal.attackPower);
      assert.strictEqual(normal.lossesDef, 0);
      assert.strictEqual(bombarded.lossesDef, 0);
      assert.ok(Math.abs(bombarded.defenderAfter.condition - (normal.defenderAfter.condition - BOMBARD_COMBAT_CONDITION_LOSS)) < 1e-12);
    }
  },
  {
    name: 'bombarded tiles apply combat multiplier + condition loss (attacker)',
    run: () => {
      const attacker = groundCombatMkArmy({
        id: 'a',
        factionId: 'blue',
        members: 1,
        maxMembers: 1,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 0, r: 0 }
      });
      const defender = groundCombatMkArmy({
        id: 'd',
        factionId: 'red',
        members: 1,
        maxMembers: 1,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 1, r: 0 }
      });

      const normal = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });

      const bombarded = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        bombardedTileIds: new Set([groundCombatTileId(0, 0)]),
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });

      assert.ok(Math.abs(bombarded.attackPower - normal.attackPower * BOMBARD_COMBAT_MULT) < 1e-12);
      assert.strictEqual(bombarded.defensePower, normal.defensePower);
      assert.strictEqual(normal.lossesAtkTotal, 0);
      assert.strictEqual(bombarded.lossesAtkTotal, 0);
      assert.ok(
        Math.abs(bombarded.attackersAfter[0].condition - (normal.attackersAfter[0].condition - BOMBARD_COMBAT_CONDITION_LOSS)) < 1e-12
      );
    }
  },
  {
    name: 'prepared defense applies only from next turn',
    run: () => {
      const attacker = groundCombatMkArmy({
        id: 'a',
        factionId: 'blue',
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 0, r: 0 }
      });
      const defenderBase = groundCombatMkArmy({
        id: 'd',
        factionId: 'red',
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 1, r: 0 }
      });

      const normal = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: defenderBase, supplied: true, stackingFactor: 1 }
      });

      const preparedActive = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: { ...defenderBase, posture: 'prepared_defense', postureSetTurn: 6 }, supplied: true, stackingFactor: 1 }
      });

      const preparedThisTurn = resolveEngagement({
        turn: 7,
        map: groundCombatMap,
        buildings: [],
        attackers: [{ army: attacker, supplied: true, stackingFactor: 1 }],
        defender: { army: { ...defenderBase, posture: 'prepared_defense', postureSetTurn: 7 }, supplied: true, stackingFactor: 1 }
      });

      assert.ok(Math.abs(preparedActive.defensePower - normal.defensePower * PREPARED_DEFENSE_MULT) < 1e-12);
      assert.ok(Math.abs(preparedThisTurn.defensePower - normal.defensePower) < 1e-12);
    }
  },
  {
    name: 'routed hysteresis requires rally threshold to recover',
    run: () => {
      const base = groundCombatMkArmy({
        id: 'routed-1',
        factionId: 'blue',
        morale: BREAK_THRESHOLD - 0.01
      });

      assert.strictEqual(deriveRoutedAfterMorale(base, BREAK_THRESHOLD + 0.01), true, 'A unit that broke stays routed above break threshold');
      assert.strictEqual(deriveRoutedAfterMorale(base, RALLY_THRESHOLD + 0.01), false, 'Routed unit rallies only after passing rally threshold');

      const ralliedArmy: Army = { ...base, morale: RALLY_THRESHOLD + 0.01, routed: false };
      assert.strictEqual(
        deriveRoutedAfterMorale(ralliedArmy, RALLY_THRESHOLD - 0.05),
        false,
        'After rallying, morale must fall below break threshold to become routed again'
      );
      assert.strictEqual(
        deriveRoutedAfterMorale(ralliedArmy, BREAK_THRESHOLD - 0.01),
        true,
        'After rallying, falling below break threshold re-triggers routed'
      );
    }
  },
  {
    name: 'non-inversion guard math: if R0 <= 0.8519 then RNG cannot push above 1.0 (epsilon=0.08)',
    run: () => {
      const eps = 0.08;
      const maxRatio = (1 + eps) / (1 - eps);
      const threshold = 1 / maxRatio;
      assert.ok(Math.abs(threshold - 0.8518518518518519) < 1e-12);
      const r0 = threshold;
      const rMax = r0 * maxRatio;
      assert.ok(rMax <= 1.0 + 1e-12, `Expected rMax<=1, got ${rMax}`);
    }
  },
  {
    name: 'Kstatus uses 0.60 for out-of-supply',
    run: () => {
      const breakdown = computeKBreakdown({
        unitType: 'light_infantry',
        terrainType: 'Open',
        status: { outOfSupply: true }
      });
      assert.strictEqual(breakdown.kStatusRaw, 0.6);
      assert.strictEqual(breakdown.kStatusClamped, 0.6);
    }
  },
  {
    name: 'loss distribution sums to total attacker losses',
    run: () => {
      const attackerA = groundCombatMkArmy({
        id: 'a1',
        factionId: 'blue',
        attack: 1.4,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 0, r: 0 }
      });
      const attackerB = groundCombatMkArmy({
        id: 'a2',
        factionId: 'blue',
        attack: 1.0,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 0, r: 1 }
      });
      const defender = groundCombatMkArmy({
        id: 'd1',
        factionId: 'red',
        defense: 1.2,
        surfacePos: { bodyId: groundCombatMap.bodyId, q: 1, r: 0 }
      });

      const preview = previewEngagement({
        map: groundCombatMap,
        buildings: [],
        attackers: [
          { army: attackerA, supplied: true, stackingFactor: 1 },
          { army: attackerB, supplied: true, stackingFactor: 1 }
        ],
        defender: { army: defender, supplied: true, stackingFactor: 1 }
      });

      const distributed = Object.values(preview.lossesByAttackerId).reduce((sum, value) => sum + value, 0);
      assert.strictEqual(distributed, preview.lossesAtkTotal);
    }
  }
);

// --- rng.spec.ts ---

const ENGINE_UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

tests.push(
  {
    name: 'Mulberry32 sequence remains bit-for-bit stable for seed 1',
    run: () => {
      const rng = new RNG(1);
      const outputs = Array.from({ length: RNG_SEED_1_SEQUENCE.length }, () => rng.nextUint32());
      assert.deepStrictEqual(outputs, RNG_SEED_1_SEQUENCE);
    }
  },
  {
    name: 'Gaussian approximation remains stable for seed 1',
    run: () => {
      const rng = new RNG(1);
      const outputs = Array.from({ length: RNG_GAUSSIAN_SEED_1_SEQUENCE.length }, () => rng.gaussian());
      const epsilon = 1e-12;
      outputs.forEach((value, index) => {
        const expected = RNG_GAUSSIAN_SEED_1_SEQUENCE[index];
        assert.ok(Math.abs(value - expected) < epsilon, `Gaussian output at index ${index} diverged: expected ${expected}, got ${value}`);
      });
    }
  },
  {
    name: 'State normalization keeps increments within uint32 range',
    run: () => {
      const rng = new RNG(0xffffffff);
      rng.nextUint32();
      assert.strictEqual(rng.getState(), 0x6d2b79f4);
      rng.nextUint32();
      assert.strictEqual(rng.getState(), 0xda56f3e9);
    }
  },
  {
    name: 'State round-trip preserves zero',
    run: () => {
      const rng = new RNG(123);
      rng.setState(0);
      assert.strictEqual(rng.getState(), 0);
      rng.setState(rng.getState());
      assert.strictEqual(rng.getState(), 0);
    }
  },
  {
    name: 'id() returns RFC4122 UUID v4 with deterministic prefix',
    run: () => {
      const rng = new RNG(1);
      const ids = Array.from({ length: 3 }, () => rng.id('fleet'));
      const expected = [
        'fleet_f3ea87a0-c949-4300-abc4-0687fd2726fb',
        'fleet_2b9de7f7-3066-4647-b001-e39c5c9f82b8',
        'fleet_7007016d-71b7-4cfe-8aa6-8c742e3b217d'
      ];
      assert.deepStrictEqual(ids, expected);
      ids.forEach(id => {
        const [, uuid] = id.split('_');
        assert.ok(ENGINE_UUID_V4_REGEX.test(uuid), `ID ${id} must include a valid UUID v4`);
      });
    }
  },
  {
    name: 'id() does not advance the primary RNG state',
    run: () => {
      const rng = new RNG(42);
      const before = rng.getState();
      rng.id('probe');
      assert.strictEqual(rng.getState(), before);
    }
  },
  {
    name: 'id() remains deterministic for identical seeds',
    run: () => {
      const rngA = new RNG(12345);
      const rngB = new RNG(12345);
      const sequenceA = Array.from({ length: 5 }, () => rngA.id('ship'));
      const sequenceB = Array.from({ length: 5 }, () => rngB.id('ship'));
      assert.deepStrictEqual(sequenceA, sequenceB);
    }
  },
  {
    name: 'id() generates unique UUIDs over a reasonable sequence',
    run: () => {
      const rng = new RNG(99);
      const count = 10_000;
      const seen = new Set<string>();

      for (let i = 0; i < count; i++) {
        const id = rng.id('x');
        const [, uuid] = id.split('_');
        if (seen.has(id)) {
          throw new Error(`Duplicate ID generated at iteration ${i}: ${id}`);
        }
        assert.ok(ENGINE_UUID_V4_REGEX.test(uuid), `Generated ID does not match UUID v4 format: ${id}`);
        seen.add(id);
      }

      assert.strictEqual(seen.size, count);
    }
  },
  {
    name: 'Geodesic grid builds stable vertices and adjacency',
    run: () => {
      const frequency = 4;
      const gridA = buildGeodesicGrid(frequency);
      const gridB = buildGeodesicGrid(frequency);

      assert.strictEqual(gridA.vertices.length, tileCount(frequency));
      assert.strictEqual(gridA.facesByVertex.length, gridA.vertices.length);
      assert.strictEqual(gridA.neighbors.length, gridA.vertices.length);
      assert.strictEqual(gridA.vertices.length, gridB.vertices.length);
      assert.deepStrictEqual(gridA.vertices, gridB.vertices);
      assert.deepStrictEqual(gridA.neighbors, gridB.neighbors);

      const neighborCounts = gridA.neighbors.map(list => list.length);
      const pentCount = neighborCounts.filter(count => count === 5).length;
      const hexCount = neighborCounts.filter(count => count === 6).length;
      assert.strictEqual(pentCount, 12);
      assert.strictEqual(pentCount + hexCount, neighborCounts.length);
    }
  },
  {
    name: 'shortId() returns a stable truncated segment for UUID-based IDs',
    run: () => {
      const id = 'fleet_550e8400-e29b-41d4-a716-446655440000';
      assert.strictEqual(shortId(id), '550E8400');
    }
  }
);

const results: { name: string; success: boolean; error?: Error }[] = [];

for (const test of tests) {
  try {
    test.run();
    results.push({ name: test.name, success: true });
  } catch (error) {
    results.push({ name: test.name, success: false, error: error as Error });
  }
}

const successes = results.filter(result => result.success).length;
const failures = results.length - successes;

results.forEach(result => {
  if (result.success) {
    console.log(`✅ ${result.name}`);
  } else {
    console.error(`❌ ${result.name}`);
    console.error(result.error);
  }
});

if (failures > 0) {
  console.error(`Tests failed: ${failures}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`All tests passed (${successes}/${results.length}).`);
}
