/**
 * Compatibility shim for legacy imports.
 *
 * Canonical API: engine/systems/battle/detection.ts
 *
 * This avoids maintaining two identical copies of battle detection logic and prevents
 * "fixing the wrong file" (engine/battle/...) with no runtime effect.
 */
export { detectNewBattles, pruneBattles } from '../systems/battle/detection';
