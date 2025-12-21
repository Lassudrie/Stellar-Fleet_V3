import assert from 'node:assert';
import path from 'node:path';
import { resolveGroundConflict } from '../conquest';
import { ARMY_DESTROY_THRESHOLD, sanitizeArmyLinks } from '../army';
import { CAPTURE_RANGE, COLORS, ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER } from '../../data/static';
import { resolveBattle } from '../../services/battle/resolution';
import { SHIP_STATS } from '../../data/static';
import { AI_HOLD_TURNS } from '../ai';
import { applyCommand } from '../commands';
import {
  Army,
  ArmyState,
  Battle,
  FactionState,
  Fleet,
  FleetState,
  GameObjectives,
  GameplayRules,
  GameState,
  LogEntry,
  PlanetBody,
  ShipEntity,
  ShipType,
  StarSystem
} from '../../types';
import { Vec3 } from '../math/vec3';
import { GameEngine } from '../GameEngine';
import { runTurn } from '../runTurn';
import { RNG } from '../rng';
import { phaseBattleResolution } from '../turn/phases/01_battle_resolution';
import { phaseCleanup } from '../turn/phases/07_cleanup';
import { phaseGround } from '../turn/phases/05_ground';
import { phaseBattleDetection } from '../turn/phases/04_battle_detection';
import { phaseOrbitalBombardment } from '../turn/phases/05_orbital_bombardment';
import ts from 'typescript';
import { getTerritoryOwner } from '../territory';
import { resolveBattleOutcome, FactionRegistry } from '../battle/outcome';
import { checkVictoryConditions } from '../objectives';
import { deserializeGameState, serializeGameState } from '../serialization';
import { resolveFleetMovement } from '../../services/movement/movementPhase';
import { isOrbitContested } from '../orbit';
import { generateStellarSystem } from '../../services/world/stellar';

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

const createFleet = (id: string, factionId: string, position: Vec3, ships: ShipEntity[]): Fleet => ({
  id,
  factionId,
  ships,
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
  strength: number,
  state: ArmyState,
  containerId: string
): Army => ({
  id,
  factionId,
  strength,
  maxStrength: strength,
  morale: 1,
  state,
  containerId
});

const createBaseState = (overrides: Partial<GameState>): GameState => {
  const defaultRules: GameplayRules = {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: false
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
        seed: 42
      });

      const { updatedBattle } = resolveBattle(battle, state, 0);

      assert.strictEqual(updatedBattle.winnerFactionId, 'alpha', 'Winner should match computed surviving faction id');
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
      const transport: ShipEntity = {
        id: 'blue-transport-runturn',
        type: ShipType.TROOP_TRANSPORT,
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
      );

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
      const translate = (key: string, params?: Record<string, string>) => {
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
      const translate = (key: string) => (key === 'battle.draw' ? 'DRAW' : 'RESULT UNKNOWN');

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

      assert.ok(updatedA && updatedA.strength < redArmyA.strength, 'Bombardment should reduce strength on planet 1');
      assert.ok(updatedB && updatedB.strength < redArmyB.strength, 'Bombardment should reduce strength on planet 2');
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

      assert.strictEqual(updated?.strength, redArmy.strength, 'Contested orbit should prevent bombardment losses');
      assert.strictEqual(updated?.morale, redArmy.morale, 'Contested orbit should prevent morale loss');
    }
  },
  {
    name: 'Troop transports alone cannot trigger orbital bombardment',
    run: () => {
      const system = createSystem('sys-bombard-transport', null);
      const transportFleet = createFleet('fleet-transport-only', 'blue', { ...baseVec }, [
        { id: 'blue-transport', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: null }
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

      assert.strictEqual(updated?.strength, redArmy.strength, 'Transport-only fleets should not bombard');
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

      const minStrength = ARMY_DESTROY_THRESHOLD(10000) + ORBITAL_BOMBARDMENT_MIN_STRENGTH_BUFFER;
      const redArmy: Army = {
        id: 'army-red-floor',
        factionId: 'red',
        strength: minStrength,
        maxStrength: 10000,
        morale: 1,
        state: ArmyState.DEPLOYED,
        containerId: system.planets[0].id
      };

      const state = createBaseState({
        systems: [system],
        fleets: [blueFleet],
        armies: [redArmy]
      });
      const ctx = { turn: state.day + 1, rng: new RNG(19) };

      const nextState = phaseOrbitalBombardment(state, ctx);
      const updated = nextState.armies.find(army => army.id === redArmy.id);

      assert.ok(
        updated && updated.strength >= minStrength,
        'Bombardment should not drop strength below the destruction threshold buffer'
      );
    }
  },
  {
    name: '10k vs 10k armies survive initial clash under new threshold',
    run: () => {
      const system = createSystem('sys-2', 'blue');
      const blueArmy = createArmy('army-blue-10k', 'blue', 10000, ArmyState.DEPLOYED, system.planets[0].id);
      const redArmy = createArmy('army-red-10k', 'red', 10000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);
      assert.ok(result, 'Ground conflict should resolve');
      assert.strictEqual(result?.winnerFactionId, 'draw', 'Balanced forces should stalemate');
      assert.deepStrictEqual(result?.armiesDestroyed, [], 'Threshold should prevent immediate destruction');

      const blueUpdate = result?.armyUpdates.find(update => update.armyId === blueArmy.id);
      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(blueUpdate && blueUpdate.strength > 2000, 'Blue army should survive above destruction threshold');
      assert.ok(redUpdate && redUpdate.strength > 2000, 'Red army should survive above destruction threshold');
    }
  },
  {
    name: 'Damaged attackers are still removed when defenders already own the system',
    run: () => {
      const system = createSystem('sys-5', 'blue');
      const blueArmy = createArmy('army-blue-hold', 'blue', 12000, ArmyState.DEPLOYED, system.planets[0].id);
      const redArmy: Army = {
        id: 'army-red-broken',
        factionId: 'red',
        strength: 1500,
        maxStrength: 20000,
        morale: 0.5,
        state: ArmyState.DEPLOYED,
        containerId: system.planets[0].id
      };

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system.planets[0], system, state);
      assert.ok(result, 'Ground conflict should be reported even without conquest');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Defenders should be considered the winners');
      assert.ok(result?.armiesDestroyed.includes(redArmy.id), 'Damaged attackers should be destroyed');

      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(redUpdate, 'Red army should receive an update before removal');
      assert.ok(redUpdate!.strength < redArmy.strength, 'Red army should lose strength from the fight');
    }
  },
  {
    name: 'LOAD_ARMY respecte le ciblage du vaisseau imposé',
    run: () => {
      const system = createSystem('sys-load-targeted', null);
      const allowedTransport: ShipEntity = {
        id: 'blue-transport-allowed',
        type: ShipType.TROOP_TRANSPORT,
        hp: 50,
        maxHp: 50,
        carriedArmyId: null
      };
      const blockedTransport: ShipEntity = {
        id: 'blue-transport-blocked',
        type: ShipType.TROOP_TRANSPORT,
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
      );

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
      const transport: ShipEntity = {
        id: 'blue-transport-move-load',
        type: ShipType.TROOP_TRANSPORT,
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

      const result = resolveFleetMovement(movingFleet, [system], [groundArmy], 3, rng, [movingFleet]);

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
      const transport: ShipEntity = {
        id: 'blue-transport',
        type: ShipType.TROOP_TRANSPORT,
        hp: 50,
        maxHp: 50,
        carriedArmyId: 'army-blue-unload'
      };

      const blueArmy = createArmy(transport.carriedArmyId!, 'blue', 8000, ArmyState.EMBARKED, 'fleet-blue');
      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [transport]);

      const state = createBaseState({ systems: [system], fleets: [blueFleet], armies: [blueArmy] });
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
      );

      const unloadedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.ok(unloadedArmy, 'Army should still exist after unloading');
      assert.strictEqual(unloadedArmy?.state, ArmyState.DEPLOYED, 'Army must be deployed on the surface');
      assert.strictEqual(unloadedArmy?.containerId, system.planets[0].id, 'Army container should move to the planet');
      assert.strictEqual(unloadedArmy?.strength, blueArmy.strength, 'No risk should apply in a clear orbit');

      const combatLogs = updated.logs.filter(log => log.type === 'combat');
      assert.strictEqual(combatLogs.length, 0, 'No combat logs should be generated when orbit is clear');
    }
  },
  {
    name: 'Contested orbit applies deterministic risk to unloading armies',
    run: () => {
      const system = createSystem('sys-unload-risk', null);
      const transport: ShipEntity = {
        id: 'blue-risk-transport',
        type: ShipType.TROOP_TRANSPORT,
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

      const state = createBaseState({ systems: [system], fleets: [blueFleet, redFleet], armies: [blueArmy] });
      const rng = new RNG(7); // Deterministic roll below threshold to trigger losses

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
      );

      const unloadedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.ok(unloadedArmy, 'Army should persist after contested unload');
      assert.strictEqual(unloadedArmy?.state, ArmyState.DEPLOYED, 'Army must still disembark');
      assert.strictEqual(unloadedArmy?.containerId, system.planets[0].id, 'Army container should move to the planet');
      assert.ok(
        (unloadedArmy?.strength ?? 0) < blueArmy.strength,
        'Contested unload should apply deterministic strength loss'
      );

      const combatLog = updated.logs.find(log => log.type === 'combat');
      assert.ok(combatLog, 'Risk resolution should produce a combat log');
      assert.ok(
        combatLog?.text.includes('took fire'),
        'Combat log should record the contested drop losses'
      );
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
      const transport: ShipEntity = {
        id: 'transfer-ship',
        type: ShipType.TROOP_TRANSPORT,
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
      );

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
      );

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
      );

      const invasionFleet = movedWithTurn.fleets.find(f => f.id === fleet.id);
      assert.strictEqual(
        invasionFleet?.stateStartTurn,
        customTurn,
        'Movement commands should respect an explicit turn override'
      );
    }
  },
  {
    name: 'Invasion movement deploys embarked armies and logs the landing on arrival',
    run: () => {
      const system: StarSystem = { ...createSystem('sys-invasion', 'red'), position: { x: 0, y: 0, z: 0 } };

      const transport: ShipEntity = {
        id: 'transport-invasion',
        type: ShipType.TROOP_TRANSPORT,
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

      const initialStep = resolveFleetMovement(movingFleet, [system], [army], 0, rng, [movingFleet]);
      const fleetsAfterFirstStep = [initialStep.nextFleet];
      const armiesAfterFirstStep = [army];

      const arrivalStep = resolveFleetMovement(
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
      assert.strictEqual(landedArmy?.state, ArmyState.DEPLOYED, 'Army should be deployed upon invasion arrival');
      assert.strictEqual(
        landedArmy?.containerId,
        system.planets[0].id,
        'Deployed army must be placed on the invaded planet after landing'
      );

      const invasionLog = arrivalStep.logs.find(log => log.type === 'combat' && log.text.includes('INVASION STARTED'));
      assert.ok(invasionLog, 'Arrival should generate an invasion log entry');
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
      const redArmy: Army = {
        id: 'army-red-loop',
        factionId: 'red',
        strength: 0,
        maxStrength: 20000,
        morale: 0.8,
        state: ArmyState.DEPLOYED,
        containerId: system.planets[0].id
      };

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
            return update ? { ...army, strength: update.strength, morale: update.morale } : army;
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
        { id: 'blue-transport', type: ShipType.TROOP_TRANSPORT, hp: 1, maxHp: 2000, carriedArmyId: blueArmy.id }
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
        { id: 'blue-transport-loss', type: ShipType.TROOP_TRANSPORT, hp: 1, maxHp: 2000, carriedArmyId: embarkedArmy.id }
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
        { id: 'blue-clean-transport', type: ShipType.TROOP_TRANSPORT, hp: 1, maxHp: 2000, carriedArmyId: embarkedArmy.id }
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
        updatedBattle.survivorShipIds,
        [blueFleet.ships[0].id],
        'Survivor metrics should list ships that remain operational after attrition'
      );
      assert.strictEqual(updatedBattle.shipsLost?.blue, 0, 'No additional blue losses should be counted when attrition is non-lethal');
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

      const { updatedBattle } = resolveBattle(battle, state, 5);

      assert.strictEqual(updatedBattle.winnerFactionId, 'blue', 'Heavier fleet should secure victory');
      assert.ok(updatedBattle.ammunitionByFaction, 'Ammunition summary should be recorded on the battle result');

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
    }
  },
  {
    name: 'Phase ground conquest uses faction color and AI hold updates for any winner',
    run: () => {
      const system = createSystem('sys-green-capture', 'red');
      const greenArmy = createArmy('army-green', 'green', 8000, ArmyState.DEPLOYED, system.planets[0].id);

      const state = createBaseState({ systems: [system], armies: [greenArmy], aiStates: {} });
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
    name: 'Conquest exports remain referenced outside their module',
    run: () => {
      const projectRoot = path.resolve(new URL('../..', import.meta.url).pathname);
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

      const conquestPath = path.join(projectRoot, 'engine', 'conquest.ts');
      const conquestSource = program!.getSourceFile(conquestPath);
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
        { id: 'transport-clean', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: 'missing-army' }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [] });

      const { state: sanitized, logs } = sanitizeArmyLinks(state);
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
        { id: 'ship-a', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: army.id },
        { id: 'ship-b', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: army.id }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [army] });

      const { state: sanitized, logs } = sanitizeArmyLinks(state);
      const [shipA, shipB] = sanitized.fleets[0].ships;

      assert.strictEqual(shipA.carriedArmyId, army.id, 'Canonical carrier should retain the army');
      assert.strictEqual(shipB.carriedArmyId, null, 'Secondary carrier should be unlinked');
      assert.ok(logs.some(entry => entry.includes('canonical carrier is ship-a')), 'Cleanup log should cite canonical carrier');
      assert.strictEqual(sanitized.armies.length, 1, 'Army should survive cleanup with a single carrier');
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

      assert.deepStrictEqual(result, {
        ok: false,
        error: 'Fleet is in combat and cannot receive commands.'
      });
    }
  }
];

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
