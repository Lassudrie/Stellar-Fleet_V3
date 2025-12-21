
import { CAPTURE_RANGE } from '../../data/static';

// --- BATTLE CONFIGURATION ---

export const BATTLE_ENGAGEMENT_RANGE = CAPTURE_RANGE;
export const BATTLE_ENGAGEMENT_RANGE_SQ = BATTLE_ENGAGEMENT_RANGE * BATTLE_ENGAGEMENT_RANGE;

export const MAX_ROUNDS = 6;

export const ETA_MISSILE = 2;
export const ETA_TORPEDO = 3;

// Base accuracy for kinetic weapons before modification
export const BASE_ACCURACY = 0.6;

// How much FireControlLock increases per round if focusing on positioning
export const LOCK_GAIN_PER_ROUND = 0.35;

// Probability to keep focusing on an existing target when it is still valid
export const TARGET_STICKINESS = 0.8;
export const TARGET_REACQUIRE_THRESHOLD = 1 - TARGET_STICKINESS;

export const DEFAULT_MANEUVER_BUDGET = 0.5;

// Maximum missiles/torps a single ship can launch per round (Burst limit)
export const MAX_LAUNCH_PER_ROUND = 3;

// Interception
export const INTERCEPTION_BASE_CHANCE = 0.35; // Lowered base chance so more salvos slip through

// PD
export const PD_DAMAGE_PER_POINT = 7; // "HP" damage to incoming missiles per PD point (reduced to allow more hits)
export const MISSILE_HP = 50;  // Scaled up to require ~5 PD strength to kill
export const TORPEDO_HP = 150; // Scaled up to require ~15 PD strength to kill

// Survivors always suffer attrition before returning to duty
export const SURVIVOR_ATTRITION_RATIO = 0.1;
export const SURVIVOR_MIN_POST_BATTLE_DAMAGE = 15;
export const attritionDamageFor = (maxHp: number) =>
  Math.max(Math.floor(maxHp * SURVIVOR_ATTRITION_RATIO), SURVIVOR_MIN_POST_BATTLE_DAMAGE);

// Battle timeline management
export const BATTLE_HISTORY_TURNS = 5;
