import { ORBIT_PROXIMITY_RANGE_SQ } from '../../../data/static';
import { GameState } from '../../../types';
import { isOrbitContested } from '../../orbit';
import { TurnContext } from '../types';
import { distSq } from '../../math/vec3';
import { resolveOrbitalBombardment } from '../../orbitalBombardment';

const hasUncontestedOrbitalDominance = (state: GameState): boolean =>
  state.systems.some(system => {
    if (isOrbitContested(system, state)) return false;

    const fleetsInOrbit = state.fleets.filter(
      fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ
    );

    if (fleetsInOrbit.length === 0) return false;

    const factionIds = new Set(fleetsInOrbit.map(fleet => fleet.factionId));
    return factionIds.size === 1;
  });

export const phaseOrbitalBombardment = (state: GameState, ctx: TurnContext): GameState => {
  if (!hasUncontestedOrbitalDominance(state)) return state;

  const result = resolveOrbitalBombardment(state);
  if (result.updates.size === 0 && result.logs.length === 0) return state;

  const nextArmies = state.armies.map(army => {
    const update = result.updates.get(army.id);
    if (!update) return army;
    return { ...army, strength: update.strength, morale: update.morale };
  });

  const nextLogs = [...state.logs];
  result.logs.forEach(text => {
    nextLogs.push({
      id: ctx.rng.id('log'),
      day: ctx.turn,
      text,
      type: 'combat'
    });
  });

  return {
    ...state,
    armies: nextArmies,
    logs: nextLogs
  };
};
