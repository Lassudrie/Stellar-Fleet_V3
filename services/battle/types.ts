
import { FactionId, ShipType } from '../../types';

export type WeaponType = 'kinetic' | 'missile' | 'torpedo';

export interface Projectile {
  id: string;
  type: 'missile' | 'torpedo';
  sourceId: string;
  sourceFaction: FactionId;
  targetId: string;
  eta: number; // Rounds until impact
  damage: number;
  hp: number; // Durability against PD
}

export interface BattleShipState {
  shipId: string;
  fleetId: string;
  faction: FactionId;
  type: ShipType;
  currentHp: number;
  maxHp: number;
  
  // Consumables
  missilesLeft: number;
  torpedoesLeft: number;
  
  // Tactical State (Reset or updated each round)
  fireControlLock: number; // 0.0 to 1.0 (Target Lock)
  maneuverBudget: number; // Used for evasion calculation
  targetId: string | null;
  
  // Stats Cache
  evasion: number;
  pdStrength: number;
}
