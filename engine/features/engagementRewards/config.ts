import { EraId } from './types';

/**
 * Engagement Rewards is implemented as an OPTIONAL, SAFE feature.
 *
 * - Default is enabled for new games.
 * - Can be disabled per-save by setting `state.engagement.enabled = false`.
 * - Future: wire to UI toggle / Scenario rules without changing the engine hook.
 */
export const ENGAGEMENT_DEFAULT_ENABLED = true;

/**
 * Era thresholds are expressed as inclusive start day for each era.
 * - EARLY: day 1 .. (MID.start-1)
 * - MID:   day MID.start .. (LATE.start-1)
 * - LATE:  day LATE.start .. ∞
 */
export const ERA_THRESHOLDS: Readonly<Record<EraId, { startDay: number }>> = Object.freeze({
  EARLY: { startDay: 1 },
  MID: { startDay: 16 },
  LATE: { startDay: 41 },
});

/**
 * Default number of objectives offered per era.
 * (Only used by the objectives plugin; defined here to keep it data-driven.)
 */
export const OBJECTIVES_PER_ERA: Readonly<Record<EraId, number>> = Object.freeze({
  EARLY: 3,
  MID: 3,
  LATE: 3,
});

export const REWARD_PREFIX = '[REWARD]';
export const SITREP_PREFIX = '[SITREP]';
export const MOMENT_PREFIX = '[MOMENT]';
export const OBJECTIVES_PREFIX = '[OBJECTIVES]';
