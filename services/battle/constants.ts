
// --- BATTLE CONFIGURATION ---

export const MAX_ROUNDS = 6;

export const ETA_MISSILE = 2;
export const ETA_TORPEDO = 3;

// Base accuracy for kinetic weapons before modification
export const BASE_ACCURACY = 0.6;

// How much FireControlLock increases per round if focusing on positioning
export const LOCK_GAIN_PER_ROUND = 0.35;

// Maximum missiles/torps a single ship can launch per round (Burst limit)
export const MAX_LAUNCH_PER_ROUND = 3;

// Interception
export const INTERCEPTION_BASE_CHANCE = 0.35; // Lowered base chance so more salvos slip through

// PD
export const PD_DAMAGE_PER_POINT = 7; // "HP" damage to incoming missiles per PD point (reduced to allow more hits)
export const MISSILE_HP = 50;  // Scaled up to require ~5 PD strength to kill
export const TORPEDO_HP = 150; // Scaled up to require ~15 PD strength to kill
