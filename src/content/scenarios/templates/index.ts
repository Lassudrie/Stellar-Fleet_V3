import { ScenarioTemplate } from '../schema';
import { conquestSandbox } from './conquest_sandbox';
import { homeworldFrontier } from './homeworld_frontier';
import { spiralConvergence } from './spiral_convergence';

export const templatesToLoad: Array<{ data: ScenarioTemplate; name: string }> = [
  { data: conquestSandbox, name: 'conquest_sandbox.ts' },
  { data: homeworldFrontier, name: 'homeworld_frontier.ts' },
  { data: spiralConvergence, name: 'spiral_convergence.ts' }
];
