// Engagement Rewards - persisted meta-progression state.
//
// IMPORTANT: This file is intentionally independent from `types.ts` to avoid
// circular type dependencies. Use primitive string identifiers where needed.

export type RewardHorizon = 'IMMEDIATE' | 'SHORT' | 'MID' | 'LONG';
export type RewardFamily = 'POWER' | 'OPTIONS' | 'INFORMATION' | 'CONTROL' | 'IDENTITY' | 'STORY';
export type RewardAxis = 'EXPLORE' | 'EXPAND' | 'EXPLOIT' | 'EXTERMINATE';

export type EraId = 'EARLY' | 'MID' | 'LATE';

export type ObjectiveKind =
  | 'CAPTURE_SYSTEMS'
  | 'WIN_BATTLES'
  | 'CONTROL_GAS_SYSTEMS'
  | 'START_INVASIONS';

export interface EngagementStats {
  battlesWon: number;
  battlesLost: number;
  systemsConquered: number;
}

export interface EngagementMomentUnlock {
  id: string;
  unlockedOnDay: number;
  prestigeAwarded: number;
}

export interface EngagementObjectiveState {
  id: string;
  era: EraId;

  title: string;
  description: string;

  axis: RewardAxis;
  family: RewardFamily;
  horizon: RewardHorizon;

  kind: ObjectiveKind;
  target: number;
  progress: number;
  completed: boolean;

  prestigeReward: number;
  completedOnDay?: number;
}

export interface EngagementState {
  /**
   * Master toggle for the whole feature. When false:
   * - no engagement rewards are applied
   * - no new engagement logs are written
   * - state is still persisted
   */
  enabled: boolean;

  /** Meta score used for “Moments”, “Objectives”, pacing, etc. */
  prestige: number;

  /** Current era label (purely engagement-layer; does NOT drive simulation). */
  era: EraId;

  /** Unlocked story beats / achievements. */
  moments: Record<string, EngagementMomentUnlock>;

  /** Active, optional objectives for the current era. */
  objectives: EngagementObjectiveState[];

  /** Simple cumulative counters for deterministic triggers. */
  stats: EngagementStats;
}
