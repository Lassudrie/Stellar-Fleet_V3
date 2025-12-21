import assert from 'node:assert';
import { planAiTurn } from '../ai';
import { RNG } from '../rng';
import { AIState, FactionState, GameObjectives, GameState, GameplayRules, StarSystem } from '../../types';

interface TestCase {
  name: string;
  run: () => void;
}

const baseRules: GameplayRules = {
  fogOfWar: false,
  useAdvancedCombat: true,
  aiEnabled: true,
  totalWar: false
};

const baseObjectives: GameObjectives = {
  conditions: []
};

const createSystem = (id: string, ownerFactionId: string): StarSystem => ({
  id,
  name: id,
  position: { x: 0, y: 0, z: 0 },
  color: '#cccccc',
  size: 1,
  ownerFactionId,
  resourceType: 'none',
  isHomeworld: true,
  planets: [
    {
      id: `${id}-1`,
      systemId: id,
      name: `${id} I`,
      bodyType: 'planet',
      class: 'solid',
      ownerFactionId,
      size: 1,
      isSolid: true
    }
  ]
});

const tests: TestCase[] = [
  {
    name: 'AI state cloning preserves non-JSON serializable values',
    run: () => {
      const aiFaction: FactionState = { id: 'ai', name: 'AI', color: '#00ffcc', isPlayable: false, aiProfile: 'balanced' };
      const playerFaction: FactionState = { id: 'player', name: 'Player', color: '#ffffff', isPlayable: true };

      const system = createSystem('ai-home', aiFaction.id);

      const existingState: AIState = {
        sightings: {
          scout: {
            fleetId: 'scout',
            factionId: playerFaction.id,
            systemId: null,
            position: { x: 5, y: 0, z: 0 },
            daySeen: 0,
            estimatedPower: 10,
            confidence: 0.5
          }
        },
        targetPriorities: { [system.id]: Number.POSITIVE_INFINITY },
        systemLastSeen: {},
        lastOwnerBySystemId: {},
        holdUntilTurnBySystemId: { [system.id]: 10 }
      };

      const gameState: GameState = {
        scenarioId: 'ai-clone',
        playerFactionId: playerFaction.id,
        factions: [playerFaction, aiFaction],
        seed: 1,
        rngState: 1,
        startYear: 0,
        day: 1,
        systems: [system],
        fleets: [],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        messages: [],
        selectedFleetId: null,
        winnerFactionId: null,
        objectives: baseObjectives,
        rules: baseRules
      };

      const commands = planAiTurn(gameState, aiFaction.id, existingState, new RNG(1));
      const updateStateCommand = commands.find(cmd => cmd.type === 'AI_UPDATE_STATE');

      assert.ok(updateStateCommand, 'AI update command should be issued');

      const { newState } = updateStateCommand as Extract<
        (typeof commands)[number],
        { type: 'AI_UPDATE_STATE' }
      >;

      assert.strictEqual(
        newState.targetPriorities[system.id],
        Number.POSITIVE_INFINITY,
        'Target priorities should retain infinite weights after cloning'
      );
      assert.deepStrictEqual(
        existingState.targetPriorities[system.id],
        Number.POSITIVE_INFINITY,
        'Existing AI state should remain unchanged'
      );
      assert.ok(
        newState.sightings.scout,
        'Sightings should persist through cloning'
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
