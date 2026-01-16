import { ScenarioTemplate } from '../schema';

// Scenario data is intentionally isolated in this file.
// No runtime logic, no registry wiring.

export const referenceOrbitLab: ScenarioTemplate = {
  schemaVersion: 1,
  id: 'reference_orbit_lab',
  meta: {
    title: 'Reference Orbit Lab',
    description: 'A deterministic reference system for validating star/planet/moon mappings and orbit rendering.',
    difficulty: 1,
    tags: ['Reference', 'Deterministic', 'Viewer']
  },
  generation: {
    fixedSeed: 1337,
    systemCount: 6,
    radius: 45,
    topology: 'cluster',
    settlements: {
      neutralOutpostChance: 0,
      neutralOutpostRuinsChance: 0,
      developmentBias: 0
    }
  },
  setup: {
    factions: [
      { id: 'vanguard', name: 'Vanguard Assembly', colorHex: '#22d3ee', isPlayable: true },
      { id: 'corsairs', name: 'Corsair Syndicate', colorHex: '#f43f5e', isPlayable: false, aiProfile: 'balanced' }
    ],
    startingDistribution: 'cluster',
    initialFleets: [
      {
        ownerFactionId: 'vanguard',
        spawnLocation: 'home_system',
        ships: ['frigate', 'frigate', 'extractor'],
        withArmies: false
      }
    ]
  },
  objectives: {
    win: [{ type: 'survival', value: 20 }]
  },
  view: {
    focus: { mode: 'player_homeworld' },
    camera: { startScale: 'system' }
  },
  rules: {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: false,
    unlimitedFuel: true
  }
};
