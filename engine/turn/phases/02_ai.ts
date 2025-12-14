import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { planAiTurn } from '../../ai';
import { applyCommand } from '../../commands';

export const phaseAI = (state: GameState, ctx: TurnContext): GameState => {
  if (!state.rules.aiEnabled) return state;

  // Pick the first non-playable faction (deterministic) as the AI controller.
  const aiFactionId = state.factions
    .filter(f => !f.isPlayable)
    .map(f => f.id)
    .filter(id => id !== state.playerFactionId)
    .sort((a, b) => a.localeCompare(b))[0];

  if (!aiFactionId) return state;

  const commands = planAiTurn(state, aiFactionId, state.aiState, ctx.rng);

  let nextState = state;
  for (const cmd of commands) {
    nextState = applyCommand(nextState, cmd, ctx.rng);
  }

  return nextState;
};
