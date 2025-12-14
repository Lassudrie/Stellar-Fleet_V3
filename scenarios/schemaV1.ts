import { ShipType } from '../types';

/**
 * Ce fichier représente un "contrat" de données minimal pour les scénarios.
 * Les templates de scénarios doivent respecter ces types.
 */

export interface ScenarioDefinitionV1 {
  id: string;
  name: string;
  description: string;
  version: 1;
  initialDay: number;
  rules: GameplayRules;
  factions: ScenarioFaction[];
  systems: ScenarioSystem[];
  fleets: ScenarioFleet[];
  armies?: ScenarioArmy[];
}

export interface ScenarioFaction {
  id: string;
  name: string;
  color: string;
  resources: {
    metal: number;
    crystal: number;
    fuel: number;
  };
  aiControlled: boolean;
}

export interface ScenarioSystem {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  ownerFactionId: string | null;
  population: number;
  maxPopulation: number;
  economy: number;
  defenseLevel: number;
  resources: {
    metal: number;
    crystal: number;
    fuel: number;
  };
}

export interface ScenarioFleet {
  id: string;
  name: string;
  factionId: string;
  position: { x: number; y: number; z: number };
  fuel: number;
  ships: ScenarioShip[];
}

export interface ScenarioShip {
  id: string;
  type: ShipType;
  hp: number;
  carriedArmyId?: string | null;
}

export interface ScenarioArmy {
  id: string;
  factionId: string;
  strength: number;
  state: 'deployed' | 'embarked' | 'in_transit';
  containerId: string;
}

export interface GameplayRules {
  fogOfWar: boolean;
  /** Combat V1 (complexe) ou V0 (instantané) */
  useAdvancedCombat: boolean;
  /** L'IA est-elle active ? */
  aiEnabled: boolean;
  /** Si true, pas de diplomatie/échange (guerre totale) */
  totalWar: boolean;

  /**
   * Combat terrestre (optionnel).
   * - enabled=false ou absent -> modèle legacy.
   * - model permet de sélectionner un solveur déterministe extensible.
   */
  groundCombat?: {
    enabled: boolean;
    model: 'legacy' | 'deterministic_attrition_v1';
    configId?: string;
  };
}
