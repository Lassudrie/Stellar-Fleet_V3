import { FactionId, LogEntry, GameState } from '../../../types';
import type { EngagementState } from '../../../engagementRewards.types';

export type {
  RewardHorizon,
  RewardFamily,
  RewardAxis,
  EraId,
  EngagementStats,
  EngagementMomentUnlock,
  ObjectiveKind,
  EngagementObjectiveState,
  EngagementState,
} from '../../../engagementRewards.types';

export interface TurnMetrics {
  playerFactionId: FactionId;

  // Expand / Control
  systemsOwnedPrev: number;
  systemsOwnedNext: number;
  deltaSystemsOwned: number;

  gasSystemsOwnedPrev: number;
  gasSystemsOwnedNext: number;
  deltaGasSystemsOwned: number;

  // Exterminate
  battlesResolvedThisTurn: number;
  battlesWonThisTurn: number;
  battlesLostThisTurn: number;

  // Convenience
  systemsConqueredThisTurn: number;
}

export interface EngagementAfterTurnContext {
  /**
   * Immutable snapshots of the simulation state before/after the turn.
   * Plugins MUST treat them as read-only.
   *
   * NOTE: These objects are large, but plugins are expected to do light
   * deterministic computations (counts, deltas, filtering).
   */
  prev: GameState;
  next: GameState;

  playerFactionId: FactionId;
  metrics: TurnMetrics;

  /**
   * Current engagement state (already sanitized).
   * Plugins should return a new object if they modify it.
   */
  engagement: EngagementState;

  /**
   * Create a new log entry that is guaranteed to have:
   * - a unique id for the turn
   * - correct day
   * - no simulation RNG usage
   */
  makeLog: (text: string, type?: LogEntry['type']) => LogEntry;
}

export interface EngagementAfterTurnResult {
  engagement: EngagementState;
  logs?: LogEntry[];
}

export interface EngagementPlugin {
  id: string;
  afterTurn: (ctx: EngagementAfterTurnContext) => EngagementAfterTurnResult;
}
