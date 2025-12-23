import assert from 'node:assert';
import { phaseCleanup } from '../turn/phases/07_cleanup';
import { RNG } from '../rng';
import { SHIP_STATS } from '../../content/data/static';
import {
  FactionState,
  Fleet,
  FleetState,
  GameObjectives,
  GameState,
  GameplayRules,
  ShipEntity,
  ShipType
} from '../../shared/types';
import { TurnContext } from '../turn/types';

interface TestCase {
  name: string;
  run: () => void;
}

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

const createFleet = (id: string, ships: ShipEntity[]): Fleet => ({
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

const createState = (fleets: Fleet[]): GameState => {
  const factions: FactionState[] = [{ id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }];
  const rules: GameplayRules = {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: false,
    unlimitedFuel: false
  };
  const objectives: GameObjectives = { conditions: [] };

  return {
    scenarioId: 'test',
    playerFactionId: 'blue',
    factions,
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
    objectives,
    rules
  };
};

const tests: TestCase[] = [
  {
    name: 'Tanker fuel is pooled and distributed across multiple targets',
    run: () => {
      const tankerA = createShip('tanker-a', ShipType.TANKER, 1500);
      const tankerB = createShip('tanker-b', ShipType.TANKER, 2000);
      const cruiser = createShip('cruiser-1', ShipType.CRUISER, 2600); // Missing 400
      const destroyer = createShip('destroyer-1', ShipType.DESTROYER, 1700); // Missing 300
      const fighter = createShip('fighter-1', ShipType.FIGHTER, 70); // Missing 50

      const fleet = createFleet('fleet-1', [tankerA, cruiser, destroyer, tankerB, fighter]);
      const state = createState([fleet]);
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
