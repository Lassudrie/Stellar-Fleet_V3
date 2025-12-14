/**
 * Army Experience (XP) — Data-driven configuration
 * -----------------------------------------------
 *
 * This file is intentionally standalone:
 * - No dependency on engine code.
 * - Safe to import from UI, engine, or scenario tooling.
 *
 * Design goals (Option 1 compatible):
 * - Veteran is reachable; Elite is rare.
 * - Effects are impactful but bounded.
 * - XP gain depends on combat intensity (enemy strength lost), not only victory.
 */

export type ArmyExperienceTierId = 'novice' | 'veteran' | 'elite';

export interface ArmyExperienceTierConfig {
  /** Stable ID used in saves/logs/UI. */
  id: ArmyExperienceTierId;

  /** Display label (can be localized later). */
  label: string;

  /** Minimum effective XP required to enter this tier (inclusive). */
  minXp: number;

  /**
   * Multiplicative combat modifiers.
   * Examples:
   * - +10% means multiplier 1.10
   * - -15% received means multiplier 0.85
   */
  groundAttackMultiplier: number;
  groundDefenseMultiplier: number;

  /** Morale loss received multiplier (lower is better). */
  moraleLossReceivedMultiplier: number;

  /** Morale collapse threshold (lower means breaks later). */
  moraleCollapseThreshold: number;

  /** Orbital bombardment received multipliers (lower is better). */
  bombardmentStrengthLossReceivedMultiplier: number;
  bombardmentMoraleLossReceivedMultiplier: number;
}

export interface ArmyExperienceXpGainConfig {
  /** Flat base XP granted per battle. */
  baseXP: number;

  /** Scales with enemy strength lost ratio. */
  scalingXP: number;

  /** Victory multiplier applied after base+scaling. */
  victoryMultiplier: number;

  /** Hard cap per battle to prevent farming. */
  battleCap: number;
}

export interface ArmyExperienceDilutionConfig {
  /** If true, applied XP is diluted by currentStrength / maxStrength. */
  enabled: boolean;
}

export interface ArmyExperienceConfig {
  /** Tier definitions sorted by ascending minXp. */
  tiers: ArmyExperienceTierConfig[];

  /** XP gain formula parameters. */
  xpGain: ArmyExperienceXpGainConfig;

  /** Experience dilution parameters. */
  dilution: ArmyExperienceDilutionConfig;
}

/**
 * Default configuration matching the design specification.
 */
export const ARMY_EXPERIENCE_CONFIG: ArmyExperienceConfig = {
  tiers: [
    {
      id: 'novice',
      label: 'Novice',
      minXp: 0,
      groundAttackMultiplier: 1.0,
      groundDefenseMultiplier: 1.0,
      moraleLossReceivedMultiplier: 1.0,
      moraleCollapseThreshold: 20,
      bombardmentStrengthLossReceivedMultiplier: 1.0,
      bombardmentMoraleLossReceivedMultiplier: 1.0,
    },
    {
      id: 'veteran',
      label: 'Vétéran',
      minXp: 100,
      groundAttackMultiplier: 1.1,
      groundDefenseMultiplier: 1.1,
      moraleLossReceivedMultiplier: 0.85,
      moraleCollapseThreshold: 15,
      bombardmentStrengthLossReceivedMultiplier: 0.85,
      bombardmentMoraleLossReceivedMultiplier: 0.85,
    },
    {
      id: 'elite',
      label: 'Élite',
      minXp: 300,
      groundAttackMultiplier: 1.2,
      groundDefenseMultiplier: 1.2,
      moraleLossReceivedMultiplier: 0.7,
      moraleCollapseThreshold: 10,
      bombardmentStrengthLossReceivedMultiplier: 0.7,
      bombardmentMoraleLossReceivedMultiplier: 0.7,
    },
  ],
  xpGain: {
    baseXP: 5,
    scalingXP: 40,
    victoryMultiplier: 1.4,
    battleCap: 60,
  },
  dilution: {
    enabled: true,
  },
};
