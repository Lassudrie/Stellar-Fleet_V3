
import { BALANCE_PROFILE_V11 } from './balance';

// --- BATTLE CONFIGURATION ---

export const BALANCE_PROFILE = BALANCE_PROFILE_V11;

export const MAX_ROUNDS = BALANCE_PROFILE.pacing.maxRounds;

export const ETA_MISSILE = BALANCE_PROFILE.pacing.etaMissile;
export const ETA_TORPEDO = BALANCE_PROFILE.pacing.etaTorpedo;

// Base accuracy for kinetic weapons before modification
export const BASE_ACCURACY = BALANCE_PROFILE.pacing.baseAccuracy;

// How much FireControlLock increases per round if focusing on positioning
export const LOCK_GAIN_PER_ROUND = BALANCE_PROFILE.pacing.lockGainPerRound;

// Maximum missiles/torps a single ship can launch per round (Burst limit)
export const MAX_LAUNCH_PER_ROUND = BALANCE_PROFILE.pacing.maxLaunchPerRound;

// Targeting
export const TARGET_FRICTION_KEEP_CHANCE = BALANCE_PROFILE.targeting.frictionKeepChance;
export const TARGET_CAPITAL_FOCUS_BOMBER_CHANCE = BALANCE_PROFILE.targeting.capitalFocusBomberChance;
export const TARGET_TRANSPORT_FOCUS_BASE = BALANCE_PROFILE.targeting.transportFocus.base;
export const TARGET_TRANSPORT_FOCUS_PER_ROUND = BALANCE_PROFILE.targeting.transportFocus.perRound;
export const TARGET_TRANSPORT_FOCUS_MAX = BALANCE_PROFILE.targeting.transportFocus.max;

// Interception
export const INTERCEPTION_BASE_CHANCE = BALANCE_PROFILE.interception.baseChance; // Lowered base chance so more salvos slip through

// PD
export const PD_DAMAGE_PER_POINT = BALANCE_PROFILE.defense.pdDamagePerPoint; // "HP" damage to incoming missiles per PD point (reduced to allow more hits)
export const MISSILE_HP = BALANCE_PROFILE.defense.missileHp;  // Scaled up to require ~5 PD strength to kill
export const TORPEDO_HP = BALANCE_PROFILE.defense.torpedoHp; // Scaled up to require ~15 PD strength to kill
