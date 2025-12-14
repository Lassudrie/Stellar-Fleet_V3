
import { GameScenario } from './types';
import { SYSTEM_COUNT, GALAXY_RADIUS } from '../data/static';

/**
 * Creates a standard skirmish scenario typically used by "New Game".
 * Uses the legacy static constants as defaults.
 */
export const createDefaultScenario = (seed: number = Date.now()): GameScenario => {
  return {
    schemaVersion: 1,
    id: 'standard_skirmish',
    seed: seed,
    meta: {
      title: 'Standard Skirmish',
      description: 'A standard random galaxy generation with balanced resources.',
      difficulty: 2
    },
    generation: {
      systemCount: SYSTEM_COUNT,
      radius: GALAXY_RADIUS,
      topology: 'spiral'
    },
    setup: {
      factions: [
        { id: 'blue', name: 'United Earth Fleet', colorHex: '#3b82f6', isPlayable: true },
        { id: 'red', name: 'Martian Syndicate', colorHex: '#ef4444', isPlayable: false, aiProfile: 'aggressive' }
      ],
      startingDistribution: 'scattered',
      initialFleets: [
        {
          ownerFactionId: 'blue',
          spawnLocation: 'home_system',
          ships: ['carrier', 'cruiser', 'destroyer', 'frigate', 'frigate'],
          withArmies: true
        },
        {
          ownerFactionId: 'red',
          spawnLocation: 'home_system',
          ships: ['carrier', 'cruiser', 'destroyer', 'frigate', 'frigate'],
          withArmies: true
        }
      ]
    },
    objectives: {
      win: [{ type: 'elimination' }]
    },
    rules: {
      fogOfWar: true,
      aiEnabled: true,
      useAdvancedCombat: true,
      totalWar: true
    }
  };
};
