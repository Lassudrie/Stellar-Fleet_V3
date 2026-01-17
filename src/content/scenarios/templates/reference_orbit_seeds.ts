import { ScenarioTemplate } from '../schema';

export const referenceOrbitNoMoons: ScenarioTemplate = {
  schemaVersion: 1,
  id: 'reference_orbit_no_moons',
  meta: {
    title: 'Reference Orbit — No Moons',
    description: 'Golden seed intended to produce a system without moons for orbit validation.',
    difficulty: 1,
    tags: ['Reference', 'Deterministic', 'Viewer']
  },
  generation: {
    fixedSeed: 2101,
    systemCount: 5,
    radius: 42,
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

export const referenceOrbitWithMoons: ScenarioTemplate = {
  schemaVersion: 1,
  id: 'reference_orbit_with_moons',
  meta: {
    title: 'Reference Orbit — Moons',
    description: 'Golden seed intended to produce multiple moons for orbit validation.',
    difficulty: 1,
    tags: ['Reference', 'Deterministic', 'Viewer']
  },
  generation: {
    fixedSeed: 2845,
    systemCount: 6,
    radius: 46,
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

export const referenceOrbitBinarySystem: ScenarioTemplate = {
  schemaVersion: 1,
  id: 'reference_orbit_binary',
  meta: {
    title: 'Reference Orbit — Binary Stars',
    description: 'Golden seed intended to produce a binary system for lighting and barycenter validation.',
    difficulty: 1,
    tags: ['Reference', 'Deterministic', 'Viewer']
  },
  generation: {
    fixedSeed: 3927,
    systemCount: 6,
    radius: 48,
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
