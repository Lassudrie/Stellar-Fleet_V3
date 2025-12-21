import { GameScenario } from '../../scenarios/types';

export interface WorldSnapshot {
  seed: number;
  topology: GameScenario['generation']['topology'];
  systemCount: number;
  sampleSystems: Array<{
    id: string;
    name: string;
    position: { x: number; y: number; z: number };
    ownerFactionId: string | null;
    resourceType: string;
    isHomeworld: boolean;
  }>;
  homeworlds: Record<string, string>;
}

export const SPIRAL_CONVERGENCE_SEED_4242_SNAPSHOT: WorldSnapshot = {
  seed: 4242,
  topology: 'spiral',
  systemCount: 72,
  sampleSystems: [
    {
      id: 'aurora_gate',
      name: 'Aurora Gate',
      position: { x: -18, y: 6, z: 0 },
      ownerFactionId: null,
      resourceType: 'gas',
      isHomeworld: false
    },
    {
      id: 'ember_core',
      name: 'Ember Core',
      position: { x: 18, y: -6, z: 0 },
      ownerFactionId: null,
      resourceType: 'gas',
      isHomeworld: false
    },
    {
      id: 'sys_ee658ae8',
      name: 'Omina',
      position: { x: -60.923204, y: -0.961244, z: 53.048952 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_c123ea6b',
      name: 'Pilon',
      position: { x: 33.150037, y: 1.004807, z: -87.120589 },
      ownerFactionId: 'aurora',
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_2fe4a05a',
      name: 'Sigma',
      position: { x: 18.493899, y: -1.499435, z: -37.645953 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_7deda26f',
      name: 'Mupi',
      position: { x: -113.379304, y: 1.417315, z: -66.177367 },
      ownerFactionId: 'ember',
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_d971faac',
      name: 'Tauka',
      position: { x: -5.928995, y: -0.045517, z: 3.633596 },
      ownerFactionId: null,
      resourceType: 'gas',
      isHomeworld: false
    },
    {
      id: 'sys_9cc2dfb4',
      name: 'Nulon',
      position: { x: 0.841045, y: 1.972861, z: 133.8921 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    }
  ],
  homeworlds: {
    aurora: 'sys_524218da',
    ember: 'sys_3047d270'
  }
};
