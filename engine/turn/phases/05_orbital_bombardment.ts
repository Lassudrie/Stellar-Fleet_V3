import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { resolveOrbitalBombardment } from '../../orbitalBombardment';

export const phaseOrbitalBombardment = (state: GameState, ctx: TurnContext): GameState => {
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
