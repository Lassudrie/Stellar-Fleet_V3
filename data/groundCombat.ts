/**
 * Ground Combat configuration is intentionally data-driven.
 * Add new configs (IDs) here to support future balance passes, scenarios, or variants.
 */
export type GroundCombatConfigId = string;

/**
 * Ground combat models are stringly-typed by design.
 * - Keep this union in sync with `types.ts` (GameplayRules.groundCombat.model).
 */
export type GroundCombatModelId = 'legacy' | 'deterministic_attrition_v1';

export interface GroundCombatExperienceConfig {
  /** Flat XP gained for participating in a ground battle. */
  baseXP: number;
  /** Scaling added by % enemy max strength removed. */
  scalingFactor: number;
  /** Winner XP multiplier. */
  victoryMultiplier: number;

  /** XP required per level step (level = floor(xp/xpPerLevel)+1). */
  xpPerLevel: number;
  /** Hard cap for level. */
  maxLevel: number;

  /** Per-level bonus applied to attack/defense (effective). */
  attackBonusPerLevel: number;
  defenseBonusPerLevel: number;

  /**
   * Per-level reduction applied to morale loss (multiplier decreases).
   * Example: 0.02 => level 6 => 10% less morale loss.
   */
  moraleLossResistancePerLevel: number;
  /** Minimum morale-loss multiplier (cannot reduce beyond this). */
  moraleLossMultiplierMin: number;
}

export interface GroundCombatBombardmentConfig {
  enabled: boolean;

  /** clamp [strengthLossMin..strengthLossMax] */
  strengthLossMin: number;
  strengthLossMax: number;

  /** clamp [moraleLossMin..moraleLossMax] */
  moraleLossMin: number;
  moraleLossMax: number;

  /** Linear scaling from computed bombardmentScore. */
  strengthLossPerBombardScore: number;
  moraleLossPerBombardScore: number;
}

export interface GroundCombatConfig {
  /** Identifiant data-driven (ex: 'default', 'hard', 'scenario_x'). */
  id: GroundCombatConfigId;

  /** For tooling / forward compatibility. */
  model: GroundCombatModelId;

  /** Soldiers per 1.0 "strength point" in ground combat maths. */
  strengthUnit: number;

  /** Hard cap to avoid infinite battles. */
  maxRounds: number;

  /**
   * Attrition factor applied to attacker damage (guaranteed losses).
   * Must be >= 0.3 (enforced by solver).
   */
  attritionFactor: number;

  /** Efficiency clamp min (morale/100). Spec baseline: 0.25. */
  efficiencyMin: number;

  /** Morale collapse threshold (rout). Recommended 15-20. */
  moraleCollapseThreshold: number;

  /** Base morale loss per round (always applied). */
  moraleLossBase: number;

  /** Proportional morale loss scaling (damage/maxStrength)*moraleLossPerDamageFraction. */
  moraleLossPerDamageFraction: number;

  /** Minimum morale after victory (partial restore). */
  moraleRestoreMinOnVictory: number;

  /** Damage floor to guarantee progress (in "strength points"). */
  minDamagePerRoundPoints: number;

  bombardment: GroundCombatBombardmentConfig;
  experience: GroundCombatExperienceConfig;
}

export const DEFAULT_GROUND_COMBAT_CONFIG: GroundCombatConfig = {
  id: 'default',
  model: 'deterministic_attrition_v1',

  strengthUnit: 1000,
  maxRounds: 50,

  attritionFactor: 0.35,
  efficiencyMin: 0.25,

  moraleCollapseThreshold: 18,
  moraleLossBase: 3,
  moraleLossPerDamageFraction: 50,

  moraleRestoreMinOnVictory: 35,
  minDamagePerRoundPoints: 0.01,

  bombardment: {
    enabled: true,
    strengthLossMin: 0.05,
    strengthLossMax: 0.30,
    moraleLossMin: 10,
    moraleLossMax: 40,
    strengthLossPerBombardScore: 0.015,
    moraleLossPerBombardScore: 3,
  },

  experience: {
    baseXP: 7,
    scalingFactor: 30,
    victoryMultiplier: 1.4,

    xpPerLevel: 100,
    maxLevel: 20,

    attackBonusPerLevel: 0.03,
    defenseBonusPerLevel: 0.03,

    moraleLossResistancePerLevel: 0.02,
    moraleLossMultiplierMin: 0.6,
  },
};

export const GROUND_COMBAT_CONFIGS: Record<string, GroundCombatConfig> = {
  default: DEFAULT_GROUND_COMBAT_CONFIG,
};

export const getGroundCombatConfig = (configId?: string | null): GroundCombatConfig => {
  const id = (configId || 'default').trim();
  const cfg = GROUND_COMBAT_CONFIGS[id];
  return cfg || DEFAULT_GROUND_COMBAT_CONFIG;
};
