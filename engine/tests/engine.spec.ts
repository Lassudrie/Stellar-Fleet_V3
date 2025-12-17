import assert from 'node:assert';
import { resolveGroundConflict } from '../conquest';
import { sanitizeArmyLinks } from '../army';
import { CAPTURE_RANGE, COLORS } from '../../data/static';
import {
  Army,
  ArmyState,
  Battle,
  FactionState,
  Fleet,
  FleetState,
  GameState,
  LogEntry,
  ShipEntity,
  ShipType,
  StarSystem
} from '../../types';
import { Vec3 } from '../math/vec3';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: COLORS.blue, isPlayable: true },
  { id: 'red', name: 'Red', color: COLORS.red, isPlayable: true }
];

const baseVec: Vec3 = { x: 0, y: 0, z: 0 };

const createSystem = (id: string, ownerFactionId: string | null): StarSystem => ({
  id,
  name: id,
  position: baseVec,
  color: ownerFactionId === 'blue' ? COLORS.blue : ownerFactionId === 'red' ? COLORS.red : COLORS.star,
  size: 1,
  ownerFactionId,
  resourceType: 'none',
  isHomeworld: false
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

const createBaseState = (overrides: Partial<GameState>): GameState => ({
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
  selectedFleetId: null,
  winnerFactionId: null,
  ...overrides
});

const tests: TestCase[] = [
  {
    name: 'Unopposed conquest is blocked by contested orbit',
    run: () => {
      const system = createSystem('sys-1', 'red');

      const blueArmy = createArmy('army-blue', 'blue', 12000, ArmyState.DEPLOYED, system.id);
      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [
        { id: 'blue-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);
      const redFleet = createFleet('fleet-red', 'red', { x: CAPTURE_RANGE - 1, y: 0, z: 0 }, [
        { id: 'red-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const state = createBaseState({ systems: [system], armies: [blueArmy], fleets: [blueFleet, redFleet] });

      const result = resolveGroundConflict(system, state);
      assert.ok(result, 'Ground conflict should resolve');
      assert.strictEqual(result?.winnerFactionId, 'blue');
      assert.strictEqual(result?.conquestOccurred, false, 'Conquest must be blocked by contested orbit');
      assert.deepStrictEqual(result?.armiesDestroyed, [], 'Unopposed assault should not destroy armies');
    }
  },
  {
    name: '10k vs 10k armies survive initial clash under new threshold',
    run: () => {
      const system = createSystem('sys-2', 'blue');
      const blueArmy = createArmy('army-blue-10k', 'blue', 10000, ArmyState.DEPLOYED, system.id);
      const redArmy = createArmy('army-red-10k', 'red', 10000, ArmyState.DEPLOYED, system.id);

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system, state);
      assert.ok(result, 'Ground conflict should resolve');
      assert.strictEqual(result?.winnerFactionId, 'draw', 'Balanced forces should stalemate');
      assert.strictEqual(result?.conquestOccurred, false, 'Stalemate cannot trigger conquest');
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
      const blueArmy = createArmy('army-blue-hold', 'blue', 12000, ArmyState.DEPLOYED, system.id);
      const redArmy: Army = {
        id: 'army-red-broken',
        factionId: 'red',
        strength: 1500,
        maxStrength: 20000,
        morale: 0.5,
        state: ArmyState.DEPLOYED,
        containerId: system.id
      };

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system, state);
      assert.ok(result, 'Ground conflict should be reported even without conquest');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Defenders should be considered the winners');
      assert.ok(result?.armiesDestroyed.includes(redArmy.id), 'Damaged attackers should be destroyed');

      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(redUpdate, 'Red army should receive an update before removal');
      assert.ok(redUpdate!.strength < redArmy.strength, 'Red army should lose strength from the fight');
    }
  },
  {
    name: 'Exhausted invaders are cleared so the ground battle does not loop',
    run: () => {
      const system = createSystem('sys-loop-1', 'blue');
      const blueArmy = createArmy('army-blue-loop', 'blue', 18000, ArmyState.DEPLOYED, system.id);
      const redArmy: Army = {
        id: 'army-red-loop',
        factionId: 'red',
        strength: 0,
        maxStrength: 20000,
        morale: 0.8,
        state: ArmyState.DEPLOYED,
        containerId: system.id
      };

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const firstResult = resolveGroundConflict(system, state);
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

      const followUp = resolveGroundConflict(system, updatedState);
      assert.strictEqual(followUp, null, 'Once the attacker is destroyed, the ground battle should not loop');
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
