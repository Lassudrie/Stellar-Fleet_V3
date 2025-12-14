import { ARMY_EXPERIENCE_CONFIG } from '../../../data/armyExperience';
import type {
  ArmyExperienceConfig,
  ArmyExperienceTierConfig,
  ArmyExperienceTierId,
} from '../../../data/armyExperience';

/**
 * Minimal structural contract for any army-like object.
 *
 * IMPORTANT:
 * - `xp` and `maxStrength` are OPTIONAL on purpose.
 *   This keeps this module compatible with older saves / older type definitions,
 *   and allows incremental rollout.
 */
export interface ArmyExperienceSubject {
  strength: number;
  xp?: number;
  maxStrength?: number;
}

export type ArmyExperienceTierMode = 'effective' | 'cumulative';

export interface ArmyExperienceSummary {
  /** XP stored on the army (not diluted). */
  cumulativeXp: number;

  /** XP actually applied to combat after dilution. */
  effectiveXp: number;

  /** Tier derived from either cumulative or effective XP (see mode). */
  tierId: ArmyExperienceTierId;

  /** Human-readable label for UI/logging (not localized yet). */
  tierLabel: string;

  /** Multipliers and thresholds to apply in combat. */
  groundAttackMultiplier: number;
  groundDefenseMultiplier: number;
  moraleLossReceivedMultiplier: number;
  moraleCollapseThreshold: number;
  bombardmentStrengthLossReceivedMultiplier: number;
  bombardmentMoraleLossReceivedMultiplier: number;

  /** Convenience multiplier for heuristics (AI, tooltips, etc.). */
  experiencePowerMultiplier: number;
}

export interface ComputeBattleXpGainedParams {
  /** How much enemy strength was destroyed during this battle. */
  enemyStrengthLost: number;

  /** Enemy maximum strength at the beginning of the battle. */
  enemyMaxStrength: number;

  /** Whether the subject won the battle. */
  victory: boolean;

  /** Optional config override (modding/scenario variants). */
  config?: ArmyExperienceConfig;
}

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const toFiniteNumberOr = (value: unknown, fallback: number): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const toNonNegativeIntOr = (value: unknown, fallback: number): number => {
  const n = toFiniteNumberOr(value, fallback);
  if (n <= 0) return 0;
  return Math.floor(n);
};

const toPositiveIntOr = (value: unknown, fallback: number): number => {
  const n = toFiniteNumberOr(value, fallback);
  if (n <= 0) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(n));
};

/**
 * Returns cumulative XP from the subject (never negative).
 */
export const getArmyCumulativeXp = (subject: ArmyExperienceSubject): number => {
  return toNonNegativeIntOr(subject?.xp, 0);
};

/**
 * Returns maxStrength for dilution (always >= 1).
 * Falls back to current strength if missing.
 */
export const getArmyMaxStrength = (subject: ArmyExperienceSubject): number => {
  const strength = toPositiveIntOr(subject?.strength, 1);
  const maxStrength = toPositiveIntOr(subject?.maxStrength, strength);
  return Math.max(maxStrength, strength);
};

/**
 * Computes effective XP after dilution.
 *
 * effectiveXP = xp * (currentStrength / maxStrength)
 *
 * Notes:
 * - Ratio is clamped to [0..1] to prevent accidental amplification.
 * - If dilution is disabled in config, effectiveXP === cumulativeXP.
 */
export const getArmyEffectiveXp = (
  subject: ArmyExperienceSubject,
  config: ArmyExperienceConfig = ARMY_EXPERIENCE_CONFIG
): number => {
  const cumulativeXp = getArmyCumulativeXp(subject);
  if (!config?.dilution?.enabled) return cumulativeXp;

  const strength = toFiniteNumberOr(subject?.strength, 0);
  const safeStrength = Math.max(0, strength);
  const maxStrength = getArmyMaxStrength(subject);

  const ratio = maxStrength > 0 ? clamp(safeStrength / maxStrength, 0, 1) : 0;
  const effective = cumulativeXp * ratio;

  // Keep decimals for smoother transitions; consumers can floor if needed.
  return Number.isFinite(effective) ? effective : 0;
};

/**
 * Safely returns the tier config by ID.
 * Falls back to the first tier if missing.
 */
export const getTierConfigById = (
  tierId: ArmyExperienceTierId,
  config: ArmyExperienceConfig = ARMY_EXPERIENCE_CONFIG
): ArmyExperienceTierConfig => {
  const tiers = Array.isArray(config?.tiers) ? config.tiers : [];
  const found = tiers.find(t => t.id === tierId);
  if (found) return found;

  // Defensive fallback to a safe baseline
  return (
    tiers[0] || {
      id: 'novice',
      label: 'Novice',
      minXp: 0,
      groundAttackMultiplier: 1.0,
      groundDefenseMultiplier: 1.0,
      moraleLossReceivedMultiplier: 1.0,
      moraleCollapseThreshold: 20,
      bombardmentStrengthLossReceivedMultiplier: 1.0,
      bombardmentMoraleLossReceivedMultiplier: 1.0,
    }
  );
};

/**
 * Determines tier from an XP value using the provided config.
 *
 * Implementation detail:
 * - Selects the highest tier whose minXp <= xp.
 */
export const getTierIdForXp = (
  xp: number,
  config: ArmyExperienceConfig = ARMY_EXPERIENCE_CONFIG
): ArmyExperienceTierId => {
  const safeXp = toFiniteNumberOr(xp, 0);
  const tiers = Array.isArray(config?.tiers) ? config.tiers : [];

  if (tiers.length === 0) return 'novice';

  // Ensure deterministic behavior even if tiers are not sorted.
  const sorted = [...tiers].sort((a, b) => a.minXp - b.minXp);

  let current: ArmyExperienceTierConfig = sorted[0];
  for (const tier of sorted) {
    const minXp = toFiniteNumberOr(tier.minXp, 0);
    if (safeXp >= minXp) current = tier;
  }

  return current.id;
};

/**
 * Returns a complete experience breakdown for the given army-like subject.
 */
export const getArmyExperienceSummary = (
  subject: ArmyExperienceSubject,
  mode: ArmyExperienceTierMode = 'effective',
  config: ArmyExperienceConfig = ARMY_EXPERIENCE_CONFIG
): ArmyExperienceSummary => {
  const cumulativeXp = getArmyCumulativeXp(subject);
  const effectiveXp = getArmyEffectiveXp(subject, config);

  const tierXp = mode === 'cumulative' ? cumulativeXp : effectiveXp;
  const tierId = getTierIdForXp(tierXp, config);
  const tier = getTierConfigById(tierId, config);

  const groundAttackMultiplier = toFiniteNumberOr(tier.groundAttackMultiplier, 1.0);
  const groundDefenseMultiplier = toFiniteNumberOr(tier.groundDefenseMultiplier, 1.0);

  const moraleLossReceivedMultiplier = toFiniteNumberOr(tier.moraleLossReceivedMultiplier, 1.0);
  const moraleCollapseThreshold = toFiniteNumberOr(tier.moraleCollapseThreshold, 20);

  const bombardmentStrengthLossReceivedMultiplier = toFiniteNumberOr(
    tier.bombardmentStrengthLossReceivedMultiplier,
    1.0
  );
  const bombardmentMoraleLossReceivedMultiplier = toFiniteNumberOr(
    tier.bombardmentMoraleLossReceivedMultiplier,
    1.0
  );

  // Heuristic: average of attack/defense multipliers (future-proof if they diverge).
  const experiencePowerMultiplier = (groundAttackMultiplier + groundDefenseMultiplier) / 2;

  return {
    cumulativeXp,
    effectiveXp,
    tierId,
    tierLabel: typeof tier.label === 'string' && tier.label.length > 0 ? tier.label : tierId,
    groundAttackMultiplier,
    groundDefenseMultiplier,
    moraleLossReceivedMultiplier,
    moraleCollapseThreshold,
    bombardmentStrengthLossReceivedMultiplier,
    bombardmentMoraleLossReceivedMultiplier,
    experiencePowerMultiplier,
  };
};

/**
 * XP gained by a single battle.
 *
 * Formula (spec):
 * xpGained = baseXP + (enemyStrengthLost / enemyMaxStrength) * scalingXP
 * if victory: xpGained *= victoryMultiplier
 * xpGained = min(xpGained, battleCap)
 */
export const computeBattleXpGained = (params: ComputeBattleXpGainedParams): number => {
  const config = params.config || ARMY_EXPERIENCE_CONFIG;

  const baseXP = toFiniteNumberOr(config?.xpGain?.baseXP, 0);
  const scalingXP = toFiniteNumberOr(config?.xpGain?.scalingXP, 0);
  const victoryMultiplier = toFiniteNumberOr(config?.xpGain?.victoryMultiplier, 1);
  const battleCap = toFiniteNumberOr(config?.xpGain?.battleCap, Infinity);

  const enemyStrengthLost = Math.max(0, toFiniteNumberOr(params.enemyStrengthLost, 0));
  const enemyMaxStrength = Math.max(1, toFiniteNumberOr(params.enemyMaxStrength, 1));

  const intensityRatio = clamp(enemyStrengthLost / enemyMaxStrength, 0, 1);

  let gained = baseXP + intensityRatio * scalingXP;
  if (params.victory) {
    gained *= victoryMultiplier;
  }

  gained = Math.min(gained, battleCap);

  // Use integer XP for clean thresholds and deterministic saves.
  const gainedInt = Math.max(0, Math.floor(gained));
  return Number.isFinite(gainedInt) ? gainedInt : 0;
};
