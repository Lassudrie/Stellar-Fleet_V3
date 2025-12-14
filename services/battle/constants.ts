
// --- BATTLE CONFIGURATION ---

export const MAX_ROUNDS = 4;

export const ETA_MISSILE = 2;
export const ETA_TORPEDO = 3;

// Base accuracy for kinetic weapons before modification
export const BASE_ACCURACY = 0.6;

// How much FireControlLock increases per round if focusing on positioning
export const LOCK_GAIN_PER_ROUND = 0.25;

// Maximum missiles/torps a single ship can launch per round (Burst limit)
export const MAX_LAUNCH_PER_ROUND = 2;

// Interception
export const INTERCEPTION_BASE_CHANCE = 0.5; // Base chance for an interceptor missile to kill an incoming missile

// PD
export const PD_DAMAGE_PER_POINT = 10; // "HP" damage to incoming missiles per PD point
export const MISSILE_HP = 50;  // Scaled up to require ~5 PD strength to kill
export const TORPEDO_HP = 150; // Scaled up to require ~15 PD strength to kill
