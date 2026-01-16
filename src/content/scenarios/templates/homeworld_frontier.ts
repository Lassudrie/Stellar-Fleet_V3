import { ScenarioTemplate } from '../schema';

// Scenario data is intentionally isolated in this file.
// No runtime logic, no registry wiring.

export const homeworldFrontier: ScenarioTemplate = {
  schemaVersion: 1,
  id: 'homeworld_frontier',
  meta: {
    title: 'Homeworld Frontier',
    description: 'A compact frontier map that starts you close to your homeworld for immediate 3D immersion.',
    difficulty: 1,
    tags: ['Homeworld', 'Close-up']
  },
  generation: {
    systemCount: 36,
    radius: 90,
    topology: 'cluster',
    settlements: {
      neutralOutpostChance: 0.05,
      neutralOutpostRuinsChance: 0.5,
      developmentBias: 0.1
    }
  },
  setup: {
    factions: [
      { id: 'vanguard', name: 'Vanguard Assembly', colorHex: '#22d3ee', isPlayable: true },
      { id: 'corsairs', name: 'Corsair Syndicate', colorHex: '#f43f5e', isPlayable: false, aiProfile: 'aggressive' }
    ],
    startingDistribution: 'cluster',
    initialFleets: [
      {
        ownerFactionId: 'vanguard',
        spawnLocation: 'home_system',
        ships: ['cruiser', 'destroyer', 'frigate', 'frigate', 'extractor', 'fighter', 'fighter'],
        withArmies: false
      },
      {
        ownerFactionId: 'vanguard',
        spawnLocation: 'home_system',
        ships: ['transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      },
      {
        ownerFactionId: 'corsairs',
        spawnLocation: 'home_system',
        ships: ['cruiser', 'destroyer', 'destroyer', 'frigate', 'extractor', 'bomber', 'fighter'],
        withArmies: false
      },
      {
        ownerFactionId: 'corsairs',
        spawnLocation: 'home_system',
        ships: ['transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      }
    ]
  },
  objectives: {
    win: [{ type: 'elimination' }]
  },
  view: {
    focus: { mode: 'player_homeworld' },
    camera: { startScale: 'planet' }
  },
  rules: {
    fogOfWar: true,
    useAdvancedCombat: true,
    aiEnabled: true,
    totalWar: true,
    unlimitedFuel: false
  }
};
