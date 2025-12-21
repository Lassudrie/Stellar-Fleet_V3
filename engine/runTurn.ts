
import { GameState } from '../types';
import { RNG } from './rng';
import { deepFreezeDev } from './state/immutability';
import { canonicalizeState, isCanonical } from './state/canonicalize';
import { TurnContext } from './turn/types';

// Phases
import { phaseBattleResolution } from './turn/phases/01_battle_resolution';
import { phaseAI } from './turn/phases/02_ai';
import { phaseMovement } from './turn/phases/03_movement';
import { phaseBattleDetection } from './turn/phases/04_battle_detection';
import { phaseOrbitalBombardment } from './turn/phases/05_orbital_bombardment';
import { phaseGround } from './turn/phases/05_ground';
import { phaseObjectives } from './turn/phases/06_objectives';
import { phaseCleanup } from './turn/phases/07_cleanup';

export const runTurn = (state: GameState, rng: RNG): GameState => {
  // Enforce Immutability on Input
  deepFreezeDev(state);

  const turn = state.day + 1;
  const ctx: TurnContext = { rng, turn };
  const shouldMeasure = (import.meta as any).env?.DEV && typeof performance !== 'undefined';
  const timings: Array<{ label: string; ms: number }> = [];
  const measure = <T>(label: string, fn: () => T): T => {
    if (!shouldMeasure) return fn();
    const start = performance.now();
    const result = fn();
    timings.push({ label, ms: performance.now() - start });
    return result;
  };

  // --- CANONICALIZE INPUT STATE ---
  // Ensures consistent iteration order for deterministic RNG consumption
  let nextState = { ...state, day: turn };
  if ((import.meta as any).env?.DEV && !isCanonical(nextState)) {
    console.warn('[RunTurn] Input state not canonical; normalizing for determinism.');
    nextState = canonicalizeState(nextState);
  }

  // --- PIPELINE EXECUTION ---
  // Each phase takes (state, ctx) and returns nextState.

  // 1. AI Planning & Execution (Generates commands)
  nextState = measure('ai', () => phaseAI(nextState, ctx));

  // 2. Movement (Updates positions)
  nextState = measure('movement', () => phaseMovement(nextState, ctx));

  // 3. Detect New Battles (Locks fleets and schedule resolution)
  nextState = measure('battle_detection', () => phaseBattleDetection(nextState, ctx));

  // 4. Resolve all scheduled battles immediately (Scheduled -> Resolved)
  nextState = measure('battle_resolution', () => phaseBattleResolution(nextState, ctx));

  // 5. Orbital Bombardment (auto)
  nextState = measure('orbital_bombardment', () => phaseOrbitalBombardment(nextState, ctx));

  // 6. Ground Combat & Conquest
  nextState = measure('ground', () => phaseGround(nextState, ctx));

  // 7. Check Victory Objectives
  nextState = measure('objectives', () => phaseObjectives(nextState, ctx));

  // SAFETY: Ensure all battles are resolved before cleanup so turnResolved is always set
  const remainingBattles = nextState.battles.filter(b => b.status === 'scheduled');
  if (remainingBattles.length > 0) {
    console.error(`[RunTurn] CRITICAL: Scheduled battles remaining at end of turn ${ctx.turn}: ${remainingBattles.map(b => b.id).join(', ')}. Force-resolving.`);
    nextState = {
      ...nextState,
      battles: nextState.battles.map(b =>
        b.status === 'scheduled'
          ? {
              ...b,
              turnResolved: ctx.turn,
              status: 'resolved' as const,
              winnerFactionId: 'draw' as const,
              logs: [...b.logs, 'Battle force-resolved due to turn processing error.']
            }
          : b
      )
    };
  }

  // 8. Cleanup & Maintenance
  nextState = measure('cleanup', () => phaseCleanup(nextState, ctx));

  // 8. Canonicalize output & Time Advance
  nextState = canonicalizeState(nextState);

  if (shouldMeasure && timings.length > 0) {
    const total = timings.reduce((sum, timing) => sum + timing.ms, 0);
    const details = timings.map(timing => `${timing.label}=${timing.ms.toFixed(2)}`).join(', ');
    console.debug(`[RunTurn] phase timings (ms): ${details} | total=${total.toFixed(2)}`);
  }

  return {
      ...nextState,
      day: turn
  };
};
