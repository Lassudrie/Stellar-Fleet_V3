
import { GameState } from '../types';
import { RNG } from './rng';
import { deepFreezeDev } from './state/immutability';
import { canonicalizeState } from './state/canonicalize';
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

  // --- CANONICALIZE INPUT STATE ---
  // Ensures consistent iteration order for deterministic RNG consumption
  let nextState = canonicalizeState(state);

  // --- PIPELINE EXECUTION ---
  // Each phase takes (state, ctx) and returns nextState.

  // 1. Resolve battles from previous turn (Scheduled -> Resolved)
  nextState = phaseBattleResolution(nextState, ctx);

  // 2. AI Planning & Execution (Generates commands)
  nextState = phaseAI(nextState, ctx);

  // 3. Movement (Updates positions)
  nextState = phaseMovement(nextState, ctx);

  // 4. Detect New Battles (Locks fleets for next turn)
  nextState = phaseBattleDetection(nextState, ctx);

  // 5. Ground Combat & Conquest
  nextState = phaseGround(nextState, ctx);

  // 6. Check Victory Objectives
  nextState = phaseObjectives(nextState, ctx);

  // 7. Cleanup & Maintenance
  nextState = phaseCleanup(nextState, ctx);

  // 8. Canonicalize output & Time Advance
  nextState = canonicalizeState(nextState);
  
  return {
      ...nextState,
      day: nextState.day + 1
  };
};
