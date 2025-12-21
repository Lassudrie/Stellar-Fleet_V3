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
      position: { x: -58.386964, y: -0.961244, z: 50.840518 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_c123ea6b',
      name: 'Pilon',
      position: { x: 32.375326, y: 1.004807, z: -85.084596 },
      ownerFactionId: 'ember',
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_2fe4a05a',
      name: 'Sigma',
      position: { x: 16.129179, y: -1.499435, z: -32.83236 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_7deda26f',
      name: 'Mupi',
      position: { x: -106.491639, y: 1.417315, z: -62.157167 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    },
    {
      id: 'sys_d971faac',
      name: 'Tauka',
      position: { x: 1.644977, y: -0.045517, z: -1.008127 },
      ownerFactionId: 'aurora',
      resourceType: 'gas',
      isHomeworld: false
    },
    {
      id: 'sys_9cc2dfb4',
      name: 'Nulon',
      position: { x: 0.904139, y: 1.972861, z: 143.936438 },
      ownerFactionId: null,
      resourceType: 'none',
      isHomeworld: false
    }
  ],
  homeworlds: {
    ember: 'sys_c6911dda',
    aurora: 'sys_9cfb7439'
  }
};
