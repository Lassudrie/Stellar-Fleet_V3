
import { GameState } from '../types';
import { RNG } from './rng';
import { deepFreezeDev } from './state/immutability';
import { TurnContext } from './turn/types';

// Phases
import { phaseBattleResolution } from './turn/phases/01_battle_resolution';
import { phaseAI } from './turn/phases/02_ai';
import { phaseMovement } from './turn/phases/03_movement';
import { phaseBattleDetection } from './turn/phases/04_battle_detection';
import { phaseGround } from './turn/phases/05_ground';
import { phaseObjectives } from './turn/phases/06_objectives';
import { phaseCleanup } from './turn/phases/07_cleanup';

export const runTurn = (state: GameState, rng: RNG): GameState => {
  // Enforce Immutability on Input
  deepFreezeDev(state);

  const ctx: TurnContext = { rng };

  // --- PIPELINE EXECUTION ---
  // Each phase takes (state, ctx) and returns nextState.
  
  let nextState = state;

  // 1. Resolve battles from previous turn (Scheduled -> Resolved)
  // Note: For turn-based games, battles are typically resolved at the start 
  // of the next turn. However, for MVP we also resolve immediately after detection.
  nextState = phaseBattleResolution(nextState, ctx);

  // 2. AI Planning & Execution (Generates commands)
  nextState = phaseAI(nextState, ctx);

  // 3. Movement (Updates positions)
  nextState = phaseMovement(nextState, ctx);

  // 4. Detect New Battles (Locks fleets for next turn)
  nextState = phaseBattleDetection(nextState, ctx);

  // 4b. MVP: Resolve newly detected battles in the SAME turn
  // This ensures battles detected after movement are resolved immediately
  // rather than waiting until the next turn.
  nextState = phaseBattleResolution(nextState, ctx);

  // 5. Ground Combat & Conquest
  nextState = phaseGround(nextState, ctx);

  // 6. Check Victory Objectives
  nextState = phaseObjectives(nextState, ctx);

  // 7. Cleanup & Maintenance
  nextState = phaseCleanup(nextState, ctx);

  // 8. Time Advance & RNG State Preservation
  // Save RNG state for deterministic replay/save functionality
  return {
      ...nextState,
      day: nextState.day + 1,
      rngState: rng.getState()
  };
};
