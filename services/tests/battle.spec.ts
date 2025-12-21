import assert from 'node:assert';
import { CAPTURE_RANGE } from '../../data/static';
import { RNG } from '../../engine/rng';
import { detectNewBattles, pruneBattles } from '../battle/detection';
import { selectTarget } from '../battle/targeting';
import {
  BATTLE_ENGAGEMENT_RANGE,
  BATTLE_ENGAGEMENT_RANGE_SQ,
  BATTLE_HISTORY_TURNS,
  TARGET_REACQUIRE_THRESHOLD,
  TARGET_STICKINESS,
  DEFAULT_MANEUVER_BUDGET,
  SURVIVOR_ATTRITION_RATIO,
  SURVIVOR_MIN_POST_BATTLE_DAMAGE,
  attritionDamageFor
} from '../battle/constants';
import { BattleShipState } from '../battle/types';
import {
  Battle,
  FactionState,
  Fleet,
  FleetState,
  GameState,
  ShipType,
  StarSystem
} from '../../types';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
  { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true },
  { id: 'green', name: 'Green', color: '#22c55e', isPlayable: true }
];

const rules = { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: true };

const createSystem = (id: string): StarSystem => ({
  id,
  name: id,
  position: { x: 0, y: 0, z: 0 },
  color: factions[0].color,
  size: 1,
  ownerFactionId: null,
  resourceType: 'none',
  isHomeworld: false,
  planets: []
});

const createFleet = (id: string, factionId: string, position: { x: number; y: number; z: number }): Fleet => ({
  id,
  factionId,
  ships: [{ id: `${id}-ship`, type: ShipType.FRIGATE, hp: 50, maxHp: 50, carriedArmyId: null }],
  position,
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

const createBaseState = (overrides: Partial<GameState> = {}): GameState => ({
  scenarioId: 'battle-constants',
  playerFactionId: factions[0].id,
  factions,
  seed: 7,
  rngState: 7,
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
  objectives: { conditions: [] },
  rules,
  ...overrides
});

const tests: TestCase[] = [
  {
    name: 'Shared engagement constants mirror engine capture rules',
    run: () => {
      assert.strictEqual(BATTLE_ENGAGEMENT_RANGE, CAPTURE_RANGE, 'Capture and battle ranges must stay aligned');
      assert.strictEqual(
        BATTLE_ENGAGEMENT_RANGE_SQ,
        CAPTURE_RANGE * CAPTURE_RANGE,
        'Squared capture range should be derived once'
      );
      assert.strictEqual(
        TARGET_REACQUIRE_THRESHOLD,
        1 - TARGET_STICKINESS,
        'Target stickiness ratios must remain coherent'
      );
    }
  },
  {
    name: 'Detection uses shared engagement envelope',
    run: () => {
      const system = createSystem('alpha');
      const closeOffset = BATTLE_ENGAGEMENT_RANGE - 0.1;
      const farOffset = BATTLE_ENGAGEMENT_RANGE + 0.25;

      const blueFleet = createFleet('fleet-blue', 'blue', { x: closeOffset, y: 0, z: 0 });
      const redFleet = createFleet('fleet-red', 'red', { x: -closeOffset, y: 0, z: 0 });
      const greenFleet = createFleet('fleet-green', 'green', { x: farOffset, y: 0, z: 0 });

      const state = createBaseState({ systems: [system], fleets: [blueFleet, redFleet, greenFleet] });
      const rng = new RNG(state.seed);

      const battles = detectNewBattles(state, rng, state.day);

      assert.strictEqual(battles.length, 1, 'Exactly one contested system should be scheduled');
      assert.deepStrictEqual(
        battles[0].involvedFleetIds,
        ['fleet-blue', 'fleet-red'],
        'Only fleets inside the engagement envelope should fight'
      );
    }
  },
  {
    name: 'Pruning uses the shared battle history window',
    run: () => {
      const currentTurn = 20;
      const baseline: Battle = {
        id: 'battle-recent',
        systemId: 'alpha',
        turnCreated: currentTurn - BATTLE_HISTORY_TURNS,
        turnResolved: currentTurn - BATTLE_HISTORY_TURNS,
        status: 'resolved',
        involvedFleetIds: [],
        logs: []
      };
      const stale: Battle = {
        ...baseline,
        id: 'battle-stale',
        turnCreated: currentTurn - BATTLE_HISTORY_TURNS - 2,
        turnResolved: currentTurn - BATTLE_HISTORY_TURNS - 1
      };

      const kept = pruneBattles([baseline, stale], currentTurn);

      assert.strictEqual(kept.length, 1, 'Only recent history should be kept');
      assert.strictEqual(kept[0].id, baseline.id, 'The shared pruning window should drive retention');
    }
  },
  {
    name: 'Target stickiness respects the shared ratio',
    run: () => {
      const attacker: BattleShipState = {
        shipId: 'attacker',
        fleetId: 'fleet-blue',
        faction: 'blue',
        type: ShipType.FRIGATE,
        currentHp: 100,
        maxHp: 100,
        offensiveMissilesLeft: 0,
        torpedoesLeft: 0,
        interceptorsLeft: 0,
        fireControlLock: 0,
        maneuverBudget: DEFAULT_MANEUVER_BUDGET,
        targetId: 'enemy-1',
        evasion: 0,
        pdStrength: 0,
        damage: 0,
        missileDamage: 0,
        torpedoDamage: 0,
        killHistory: []
      };

      const preferred: BattleShipState = {
        shipId: 'enemy-1',
        fleetId: 'fleet-red',
        faction: 'red',
        type: ShipType.FRIGATE,
        currentHp: 80,
        maxHp: 80,
        offensiveMissilesLeft: 0,
        torpedoesLeft: 0,
        interceptorsLeft: 0,
        fireControlLock: 0,
        maneuverBudget: DEFAULT_MANEUVER_BUDGET,
        targetId: null,
        evasion: 0,
        pdStrength: 0,
        damage: 0,
        missileDamage: 0,
        torpedoDamage: 0,
        killHistory: []
      };

      const alternate: BattleShipState = { ...preferred, shipId: 'enemy-2' };

      const keepCurrent = selectTarget(attacker, [preferred, alternate], TARGET_REACQUIRE_THRESHOLD + 0.1);
      assert.strictEqual(keepCurrent, attacker.targetId, 'High stickiness rolls should keep the current target');

      const retargeted = selectTarget(attacker, [alternate, preferred], TARGET_REACQUIRE_THRESHOLD - 0.01);
      assert.strictEqual(
        retargeted,
        alternate.shipId,
        'Low stickiness rolls should allow reacquiring a new target in order'
      );
    }
  },
  {
    name: 'Attrition helper enforces ratio and minimum damage',
    run: () => {
      const heavyHullDamage = attritionDamageFor(320);
      const lightHullDamage = attritionDamageFor(50);

      assert.strictEqual(
        heavyHullDamage,
        Math.max(Math.floor(320 * SURVIVOR_ATTRITION_RATIO), SURVIVOR_MIN_POST_BATTLE_DAMAGE),
        'Attrition should follow the shared ratio for durable ships'
      );
      assert.strictEqual(
        lightHullDamage,
        SURVIVOR_MIN_POST_BATTLE_DAMAGE,
        'Attrition should never dip under the shared minimum damage'
      );
    }
  }
];

const results = tests.map(test => {
  try {
    test.run();
    return { name: test.name, success: true as const };
  } catch (error) {
    return { name: test.name, success: false as const, error };
  }
});

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
