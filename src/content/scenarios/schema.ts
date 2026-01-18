/**
 * SCENARIO DEFINITION SCHEMA V1
 * -----------------------------
 * Contrat de données strict pour les scénarios de Stellar Fleet.
 * Format conçu pour être sérialisable en JSON.
 */

// --- 1. META-DATA ---
export interface ScenarioMeta {
  /** Nom affiché dans le menu */
  title: string;
  /** Description courte ou lore */
  description: string;
  /** Auteur du scénario (pour les mods) */
  author?: string;
  /** Difficulté estimée (1-5) */
  difficulty: number;
  /** Tags pour le filtrage (ex: "Duel", "Huge", "Tutorial") */
  tags?: string[];
}

// --- 1b. VIEW (Presentation Defaults) ---
export type ScenarioViewFocusMode = 'player_homeworld' | 'system_id' | 'first_system';
export type ScenarioViewStartScale = 'galaxy' | 'system' | 'planet';

export interface ScenarioViewFocus {
  mode?: ScenarioViewFocusMode;
  systemId?: string;
  planetId?: string;
}

export interface ScenarioViewCamera {
  startScale?: ScenarioViewStartScale;
  distanceMeters?: number;
  yawRad?: number;
  pitchRad?: number;
}

export interface ScenarioViewConfig {
  focus?: ScenarioViewFocus;
  camera?: ScenarioViewCamera;
}

// --- 2. GENERATION (World Gen) ---
export type GalaxyTopology = 'spiral' | 'cluster' | 'ring' | 'scattered';

export type PlanetBodyType = 'planet' | 'moon';
export type PlanetBodyClass = 'solid' | 'gas_giant' | 'ice_giant';

export interface PlanetBodyDefinition {
  id?: string;
  name?: string;
  bodyType: PlanetBodyType;
  class: PlanetBodyClass;
  size?: number;
  ownerFactionId?: string | null;
}

export interface WorldGenerationConfig {
  /**
   * Si défini, la génération est déterministe.
   * Si null/undefined, le moteur en générera une aléatoire à chaque lancement (mode Sandbox).
   */
  fixedSeed?: number;

  /** Nombre cible de systèmes stellaires */
  systemCount: number;

  /** Rayon de la galaxie (unités logiques) */
  radius: number;

  /** Forme de la galaxie */
  topology: GalaxyTopology;

  /**
   * Espacement minimal entre deux systèmes stellaires (années-lumière / unités logiques).
   *
   * - Par défaut (si undefined) : 5
   * - Pour désactiver : 0
   */
  minimumSystemSpacingLy?: number;

  /**
   * Overrides spécifiques (optionnel).
   * Permet de forcer la présence de systèmes à des coordonnées précises.
   */
  staticSystems?: Array<{
    id: string;
    name: string;
    position: { x: number; y: number; z: number };
    resourceType: 'gas' | 'none';
    planets?: PlanetBodyDefinition[];
  }>;

  /**
   * Version du générateur de surface planétaire à utiliser (v1/v2 legacy, v3 pour wrapX sans couture, océans par composante, cleanup micro-îles).
   * Par défaut : valeur engine (`DEFAULT_PLANET_SURFACE_GENERATOR_VERSION`).
   */
  surfaceGeneratorVersion?: number;

  /**
   * Paramètres de colonisation neutre / maturité de civilisation.
   * - neutralOutpostChance: probabilité (0..1) qu'un corps neutre ait un avant-poste.
   * - neutralOutpostRuinsChance: probabilité (0..1) que cet avant-poste soit en ruines.
   * - developmentBias: biais (-1..1) appliqué au stade de développement des colonies.
   */
  settlements?: {
    neutralOutpostChance?: number;
    neutralOutpostRuinsChance?: number;
    developmentBias?: number;
  };
}

// --- 3. SETUP (Initial State) ---

/** Définition d'une faction jouable ou IA */
export interface FactionDefinition {
  id: string; // ex: "blue", "red", "pirates"
  name: string;
  colorHex: string; // ex: "#3b82f6"
  isPlayable: boolean;
  aiProfile?: 'aggressive' | 'defensive' | 'balanced';
}

/** Composition d'une flotte initiale */
export interface FleetDefinition {
  /** Référence à l'ID de la faction propriétaire */
  ownerFactionId: string;

  /**
   * Où faire apparaitre cette flotte ?
   * - 'home_system': Au système de départ assigné à la faction.
   * - 'random': Un système aléatoire (neutre).
   * - { x, y, z }: Coordonnées précises (Deep Space).
   */
  spawnLocation: 'home_system' | 'random' | { x: number; y: number; z: number };

  /** Liste d'IDs de types de vaisseaux */
  ships: string[];

  /** Si vrai, cette flotte contient une armée embarquée par défaut sur les transports */
  withArmies?: boolean;
}

export interface ScenarioSetup {
  factions: FactionDefinition[];

  /**
   * Configuration du territoire initial.
   * 'scattered' | 'cluster' | 'none'
   */
  startingDistribution: 'scattered' | 'cluster' | 'none';

  /**
   * Allocation cible des systèmes au démarrage (optionnel).
   * Le world generator tentera d'assigner un nombre de systèmes conforme aux pourcentages.
   */
  territoryAllocation?: {
    type: 'percentages';
    byFactionId: Record<string, number>; // parts (0..1)
    neutralShare?: number;
    contiguity?: 'clustered';
  };

  /** Flottes présentes au début de la simulation */
  initialFleets: FleetDefinition[];
}

// --- 4. OBJECTIVES (Win/Loss Conditions) ---

export type WinConditionType = 'elimination' | 'domination' | 'survival' | 'king_of_the_hill';

export interface WinCondition {
  type: WinConditionType;
  value?: number | string;
}

export interface VictoryConditions {
  win: WinCondition[];
  maxTimeMs?: number;
}

// --- 5. RULES (Gameplay Mutators) ---
export interface GameplayRules {
  fogOfWar: boolean;
  useAdvancedCombat: boolean;
  aiEnabled: boolean;
  totalWar: boolean;
  unlimitedFuel: boolean;
}

// --- ROOT INTERFACE ---
export interface ScenarioDefinitionV1 {
  schemaVersion: 1;
  id: string;
  meta: ScenarioMeta;
  generation: WorldGenerationConfig;
  setup: ScenarioSetup;
  objectives: VictoryConditions;
  rules: GameplayRules;
  view?: ScenarioViewConfig;
}

// The runtime scenario object includes the resolved seed.
export type GameScenario = ScenarioDefinitionV1 & { seed: number };
export type ScenarioTemplate = ScenarioDefinitionV1;
