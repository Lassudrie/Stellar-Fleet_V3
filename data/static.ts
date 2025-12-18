
import { ShipType, ShipStats } from '../types';

export const GALAXY_RADIUS = 100;
export const SYSTEM_COUNT = 100;

// Feature Flags
export const ENABLE_V1_COMBAT = true;

// Speed = Units per Day. 
export const BASE_FLEET_SPEED = 25; 
export const COMBAT_RANGE = 8;
export const SENSOR_RANGE = 15;
export const CAPTURE_RANGE = 5; 

// New: Territorial Control Radius (Matches Visuals)
export const TERRITORY_RADIUS = 28;

// Visual Constants
export const ORBIT_RADIUS = 3;
export const ORBIT_SPEED = 0.25;

export const ORBIT_PROXIMITY_RANGE_SQ = (ORBIT_RADIUS * 3) ** 2;

// --- V1 SHIP BALANCING ---
export const SHIP_STATS: Record<ShipType, ShipStats> = {
  [ShipType.CARRIER]: {
    maxHp: 2500,
    damage: 20, // Low kinetic
    speed: 0.8,
    cost: 100,
    pdStrength: 30,
    evasion: 0.05,
    maneuverability: 0.1,
    offensiveMissileStock: 0,
    missileDamage: 0,
    torpedoStock: 0,
    torpedoDamage: 0,
    interceptorStock: 0,
    role: 'capital'
  },
  [ShipType.CRUISER]: {
    maxHp: 1200,
    damage: 80, // Good kinetic
    speed: 0.9,
    cost: 60,
    pdStrength: 15,
    evasion: 0.15,
    maneuverability: 0.3,
    offensiveMissileStock: 12,
    missileDamage: 30,
    torpedoStock: 4,
    torpedoDamage: 150,
    interceptorStock: 12,
    role: 'capital'
  },
  [ShipType.DESTROYER]: {
    maxHp: 600,
    damage: 40,
    speed: 1.0,
    cost: 40,
    pdStrength: 40, // PD Specialist
    evasion: 0.25,
    maneuverability: 0.5,
    offensiveMissileStock: 8,
    missileDamage: 25,
    torpedoStock: 0,
    torpedoDamage: 0,
    interceptorStock: 8,
    role: 'screen'
  },
  [ShipType.FRIGATE]: {
    maxHp: 300,
    damage: 20,
    speed: 1.2,
    cost: 20,
    pdStrength: 5,
    evasion: 0.50, // Hard to hit
    maneuverability: 0.7,
    offensiveMissileStock: 4,
    missileDamage: 20,
    torpedoStock: 2,
    torpedoDamage: 100,
    interceptorStock: 4,
    role: 'screen'
  },
  [ShipType.FIGHTER]: {
    maxHp: 50,
    damage: 10,
    speed: 1.5,
    cost: 5,
    pdStrength: 0,
    evasion: 0.80,
    maneuverability: 0.9,
    offensiveMissileStock: 2,
    missileDamage: 15,
    torpedoStock: 0,
    torpedoDamage: 0,
    interceptorStock: 2,
    role: 'striker'
  },
  [ShipType.BOMBER]: {
    maxHp: 80,
    damage: 5,
    speed: 1.1,
    cost: 10,
    pdStrength: 0,
    evasion: 0.60,
    maneuverability: 0.6,
    offensiveMissileStock: 0,
    missileDamage: 0,
    torpedoStock: 4, // Torpedo specialist
    torpedoDamage: 120,
    interceptorStock: 0,
    role: 'striker'
  },
  [ShipType.TROOP_TRANSPORT]: {
    maxHp: 2000, // Very durable (Capital class hull)
    damage: 0,   // No offensive weaponry
    speed: 0.8,  // Slow
    cost: 80,
    pdStrength: 10, // Minimal self-defense CIWS
    evasion: 0.05,  // Heavy / Low maneuverability
    maneuverability: 0.1,
    offensiveMissileStock: 0,
    missileDamage: 0,
    torpedoStock: 0,
    torpedoDamage: 0,
    interceptorStock: 0,
    role: 'transport'
  },
};

export const COLORS = {
  blue: '#3b82f6',
  red: '#ef4444',
  blueHighlight: '#60a5fa',
  redHighlight: '#f87171',
  star: '#ffffff',
  orbit: '#ffffff',
};