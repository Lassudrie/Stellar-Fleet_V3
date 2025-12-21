import assert from 'node:assert';
import { planAiTurn, createEmptyAIState } from '../ai';
import { RNG } from '../rng';
import {
  Army,
  Battle,
  FactionState,
  Fleet,
  FleetState,
  GameObjectives,
  GameState,
  GameMessage,
  GameplayRules,
  LaserShot,
  LogEntry,
  PlanetBody,
  ShipEntity,
  ShipType,
  StarSystem
} from '../../types';
import { Vec3 } from '../math/vec3';

interface TestCase {
  name: string;
  run: () => void;
}

const baseVec: Vec3 = { x: 0, y: 0, z: 0 };

const createPlanet = (systemId: string): PlanetBody => ({
  id: `${systemId}-planet`,
  systemId,
  name: `${systemId} Prime`,
  bodyType: 'planet',
  class: 'solid',
  ownerFactionId: 'ai',
  size: 1,
  isSolid: true
});

const createSystem = (id: string): StarSystem => ({
  id,
  name: id,
  position: baseVec,
  color: '#ffffff',
  size: 1,
  ownerFactionId: 'ai',
  resourceType: 'none',
  isHomeworld: false,
  planets: [createPlanet(id)]
});

const createFleet = (id: string, position: Vec3): Fleet => ({
  id,
  factionId: 'ai',
  ships: [createShip(`${id}-ship`)],
  position,
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

const createShip = (id: string): ShipEntity => ({
  id,
  type: ShipType.FRIGATE,
  hp: 10,
  maxHp: 10,
  carriedArmyId: null
});

const createGameState = (systemId: string): GameState => {
  const system = createSystem(systemId);
  const factions: FactionState[] = [
    { id: 'ai', name: 'AI', color: '#f00', isPlayable: false, aiProfile: 'balanced' },
    { id: 'player', name: 'Player', color: '#0f0', isPlayable: true }
  ];

  const objectives: GameObjectives = { conditions: [] };
  const rules: GameplayRules = {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: true,
    totalWar: false
  };

  const baseCollections: {
    armies: Army[];
    lasers: LaserShot[];
    battles: Battle[];
    logs: LogEntry[];
    messages: GameMessage[];
  } = {
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: []
  };

  return {
    scenarioId: 'memory-structured-clone',
    playerFactionId: 'player',
    factions,
    seed: 1,
    rngState: 1,
    startYear: 0,
    day: 3,
    systems: [system],
    fleets: [createFleet('fleet-1', system.position)],
    selectedFleetId: null,
    winnerFactionId: null,
    objectives,
    rules,
    ...baseCollections
  };
};

const tests: TestCase[] = [
  {
    name: 'AI memory cloning preserves non-JSON-safe values',
    run: () => {
      const state = createGameState('alpha');
      const existingState = createEmptyAIState();
      const targetSystemId = state.systems[0].id;

      existingState.targetPriorities[targetSystemId] = Number.POSITIVE_INFINITY;
      existingState.sightings['fleet-x'] = {
        fleetId: 'fleet-x',
        factionId: 'player',
        systemId: targetSystemId,
        position: { x: 1, y: 2, z: 3 },
        daySeen: 1,
        estimatedPower: Number.POSITIVE_INFINITY,
        confidence: 1,
        lastUpdateDay: 2
      };

      const commands = planAiTurn(state, 'ai', existingState, new RNG(0));
      const updateStateCmd = commands.find(cmd => cmd.type === 'AI_UPDATE_STATE');

      assert(updateStateCmd && updateStateCmd.type === 'AI_UPDATE_STATE', 'AI_UPDATE_STATE command should be emitted');

      const updatedState = updateStateCmd.newState;

      assert.strictEqual(
        updatedState.targetPriorities[targetSystemId],
        Number.POSITIVE_INFINITY,
        'structuredClone should preserve Infinity in target priorities'
      );

      assert.strictEqual(
        updatedState.sightings['fleet-x'].estimatedPower,
        Number.POSITIVE_INFINITY,
        'sightings should retain non-JSON-safe numeric values'
      );
    }
  }
];

tests.forEach(test => {
  try {
    test.run();
    console.log(`✅ ${test.name}`);
  } catch (error) {
    console.error(`❌ ${test.name}`);
    console.error(error);
    process.exitCode = 1;
  }
});
