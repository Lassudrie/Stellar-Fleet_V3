import { ScenarioTemplate } from '../schema';
import { conquestSandbox } from './conquest_sandbox';
import { homeworldFrontier } from './homeworld_frontier';
import { referenceOrbitLab } from './reference_orbit_lab';
import { referenceOrbitBinarySystem, referenceOrbitNoMoons, referenceOrbitWithMoons } from './reference_orbit_seeds';
import { spiralConvergence } from './spiral_convergence';

export const templatesToLoad: Array<{ data: ScenarioTemplate; name: string }> = [
  { data: conquestSandbox, name: 'conquest_sandbox.ts' },
  { data: homeworldFrontier, name: 'homeworld_frontier.ts' },
  { data: referenceOrbitLab, name: 'reference_orbit_lab.ts' },
  { data: referenceOrbitNoMoons, name: 'reference_orbit_seeds.ts#no_moons' },
  { data: referenceOrbitWithMoons, name: 'reference_orbit_seeds.ts#with_moons' },
  { data: referenceOrbitBinarySystem, name: 'reference_orbit_seeds.ts#binary' },
  { data: spiralConvergence, name: 'spiral_convergence.ts' }
];
