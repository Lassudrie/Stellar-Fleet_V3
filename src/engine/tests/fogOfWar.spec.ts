import assert from 'node:assert';
import { applyFogOfWar, defaultFleetSensors, isFleetVisibleToViewer } from '../fogOfWar';
import { FleetState, FactionState, GameState } from '../../shared/types';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true },
  { id: 'red', name: 'Red', color: '#ef4444', isPlayable: true }
];

const baseState: GameState = {
  scenarioId: 'fog-of-war',
  playerFactionId: 'blue',
  factions,
  seed: 1,
  rngState: 1,
  startYear: 0,
  day: 0,
  systems: [
    {
      id: 'alpha',
      name: 'Alpha',
      position: { x: 0, y: 0, z: 0 },
      color: factions[0].color,
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
      color: factions[1].color,
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

const tests: TestCase[] = [
  {
    name: 'System ownership and borders remain known under fog of war',
    run: () => {
      const view = applyFogOfWar(baseState, 'blue');

      const beta = view.systems.find(system => system.id === 'beta');
      assert.ok(beta, 'Beta system should exist in the view state');
      assert.strictEqual(
        beta?.ownerFactionId,
        'red',
        'Enemy ownership should remain visible even when the system is unobserved'
      );
      assert.strictEqual(
        beta?.color,
        factions[1].color,
        'Enemy territorial color should remain visible for border rendering'
      );

      const fleetIds = new Set(view.fleets.map(fleet => fleet.id));
      assert.ok(fleetIds.has('blue-1'), 'Player fleets stay visible');
      assert.ok(!fleetIds.has('red-1'), 'Unobserved enemy fleets stay hidden');
    }
  },
  {
    name: 'Custom sensor can reveal fleets independently of defaults',
    run: () => {
      const stealthFleet = {
        ...baseState.fleets[1],
        id: 'red-stealth',
        position: { x: 500, y: 0, z: 0 }
      };

      const state: GameState = { ...baseState, fleets: [...baseState.fleets, stealthFleet] };

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
    name: 'Observed systems are cached inside visibility context for efficiency',
    run: () => {
      const observedIds = new Set<string>(['alpha']);
      const state: GameState = { ...baseState };

      const visible = isFleetVisibleToViewer(
        baseState.fleets[0],
        state,
        'blue',
        observedIds
      );

      assert.ok(visible, 'Viewer fleet remains visible when observed systems are precomputed');
      assert.ok(observedIds.has('alpha'), 'Precomputed observed IDs are reused unchanged');
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
