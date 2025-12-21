import assert from 'node:assert';
import { detectNewBattles } from '../../services/battle/detection';
import { CAPTURE_RANGE, CAPTURE_RANGE_SQ, ORBIT_PROXIMITY_RANGE_SQ } from '../../data/static';
import { isOrbitContested } from '../orbit';
import {
  Army,
  Battle,
  FactionState,
  Fleet,
  FleetState,
  GameMessage,
  GameObjectives,
  GameState,
  GameplayRules,
  LaserShot,
  LogEntry,
  ShipEntity,
  ShipType,
  StarSystem
} from '../../types';
import { RNG } from '../rng';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
  { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
];

const rules: GameplayRules = {
  fogOfWar: false,
  useAdvancedCombat: true,
  aiEnabled: false,
  totalWar: false
};

const objectives: GameObjectives = { conditions: [] };

const createShip = (id: string): ShipEntity => ({
  id,
  type: ShipType.FRIGATE,
  hp: 100,
  maxHp: 100,
  carriedArmyId: null
});

const createFleet = (id: string, factionId: string, position: { x: number; y: number; z: number }): Fleet => ({
  id,
  factionId,
  ships: [createShip(`${id}-ship`)],
  position,
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

const createSystem = (id: string): StarSystem => ({
  id,
  name: id,
  position: { x: 0, y: 0, z: 0 },
  color: '#ffffff',
  size: 1,
  ownerFactionId: null,
  resourceType: 'none',
  isHomeworld: false,
  planets: []
});

const createState = (fleets: Fleet[], battles: Battle[] = []): GameState => ({
  scenarioId: 'test',
  playerFactionId: 'blue',
  factions,
  seed: 1,
  rngState: 1,
  startYear: 0,
  day: 0,
  systems: [createSystem('alpha')],
  fleets,
  armies: [] as Army[],
  lasers: [] as LaserShot[],
  battles,
  logs: [] as LogEntry[],
  messages: [] as GameMessage[],
  selectedFleetId: null,
  winnerFactionId: null,
  aiStates: {},
  objectives,
  rules
});

const tests: TestCase[] = [
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
      const fleets = [
        createFleet('fleet-blue', 'blue', { x: inRange, y: 0, z: 0 }),
        createFleet('fleet-red', 'red', { x: -inRange, y: 0, z: 0 })
      ];
      const state = createState(fleets);
      const rng = new RNG(123);

      const orbitContested = isOrbitContested(state.systems[0], state.fleets);
      const battles = detectNewBattles(state, rng, 0);

      assert.strictEqual(orbitContested, true, 'Orbit should be contested when fleets are inside capture range');
      assert.strictEqual(battles.length, 1, 'Battle should be scheduled when multiple factions contest a system');
    }
  },
  {
    name: 'Fleets outside capture range neither contest nor trigger battles',
    run: () => {
      const outOfRange = CAPTURE_RANGE + 0.01;
      const fleets = [
        createFleet('fleet-blue', 'blue', { x: outOfRange, y: 0, z: 0 }),
        createFleet('fleet-red', 'red', { x: -outOfRange, y: 0, z: 0 })
      ];
      const state = createState(fleets);
      const rng = new RNG(321);

      const orbitContested = isOrbitContested(state.systems[0], state.fleets);
      const battles = detectNewBattles(state, rng, 0);

      assert.strictEqual(orbitContested, false, 'Orbit should not be contested just outside capture range');
      assert.strictEqual(battles.length, 0, 'No battle should be scheduled when fleets are out of range');
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
