/**
 * SCENARIO DEFINITION SCHEMA V1
 * -----------------------------
 * Ce fichier définit le contrat de données strict pour les scénarios de Stellar Fleet.
 * Il est purement "Data-Driven" : aucune logique, aucune dépendance au moteur de rendu (Three.js)
 * ou au moteur de jeu (classes, méthodes).
 *
 * Ce format est conçu pour être sérialisable en JSON.
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

// --- 2. GENERATION (World Gen) ---
export type GalaxyTopology = 'spiral' | 'cluster' | 'ring' | 'scattered';

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
   * Espacement minimal entre deux systèmes stellaires (en années-lumière / unités logiques).
   *
   * Objectif : éviter les chevauchements visuels (systèmes trop proches) pour tous les scénarios.
   *
   * - Par défaut (si undefined) : 5
   * - Pour désactiver : 0
   */
  minimumSystemSpacingLy?: number;
  
  /** 
   * Overrides spécifiques (optionnel).
   * Permet de forcer la présence de systèmes à des coordonnées précises (ex: Système Sol à 0,0,0).
   */
  staticSystems?: Array<{
    id: string;
    name: string;
    position: { x: number; y: number; z: number }; // DTO simple, pas de Vector3
    resourceType: 'gas' | 'none';
  }>;
}

// --- 3. SETUP (Initial State) ---

/** Définition d'une faction jouable ou IA */
export interface FactionDefinition {
  id: string; // ex: "blue", "red", "pirates"
  name: string;
  colorHex: string; // ex: "#3b82f6"
  isPlayable: boolean; // Si true, le joueur peut la sélectionner
  aiProfile?: 'aggressive' | 'defensive' | 'expander'; // Indice pour l'IA
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
  
  /** Composition (Liste d'IDs de types de vaisseaux, ex: ['carrier', 'fighter', 'fighter']) */
  ships: string[]; 
  
  /** Si vrai, cette flotte contient une armée embarquée par défaut sur les transports */
  withArmies?: boolean;
}

export interface ScenarioSetup {
  /** Liste des factions présentes dans ce scénario */
  factions: FactionDefinition[];
  
  /** 
   * Configuration du territoire initial.
   * 'scattered': Chaque faction commence avec 1 système au hasard, loin des autres.
   * 'cluster': Chaque faction commence avec un groupe de systèmes.
   * 'none': Aucun système possédé au départ (Battle Royale).
   */
  startingDistribution: 'scattered' | 'cluster' | 'none';

  /**
   * Allocation cible des systèmes au démarrage (optionnel).
   * Si défini, le world generator tentera d'assigner un nombre de systèmes conforme
   * aux pourcentages, en gardant une territorialité contiguë (croissance depuis le home).
   *
   * Exemple :
   * {
   *   type: 'percentages',
   *   byFactionId: { red: 0.3, blue: 0.3 },
   *   neutralShare: 0.4,
   *   contiguity: 'clustered'
   * }
   */
  territoryAllocation?: {
    type: 'percentages';
    byFactionId: Record<string, number>; // parts (0..1)
    neutralShare?: number; // defaults to remaining share
    contiguity?: 'clustered'; // defaults to 'clustered'
  };
  
  /** Flottes présentes au début du tour 1 */
  initialFleets: FleetDefinition[];
}

// --- 4. OBJECTIVES (Win/Loss Conditions) ---

export type WinConditionType = 
  | 'elimination'       // Détruire tous les ennemis
  | 'domination'        // Contrôler X% des systèmes
  | 'survival'          // Survivre X tours
  | 'king_of_the_hill'; // Contrôler un système spécifique pendant X tours

export interface WinCondition {
  type: WinConditionType;
  /** Paramètre contextuel (ex: pourcentage pour domination, tours pour survival, ID système pour King) */
  value?: number | string;
}

export interface VictoryConditions {
  /** Liste des conditions pour gagner (OR logique : une seule suffit) */
  win: WinCondition[];
  /** Limite de tours (optionnel, 0 = infini) */
  maxTurns?: number;
}

// --- 5. RULES (Gameplay Mutators) ---
export interface GameplayRules {
  fogOfWar: boolean;
  /** Combat V1 (complexe) ou V0 (instantané) */
  useAdvancedCombat: boolean;
  /** L'IA est-elle active ? */
  aiEnabled: boolean;
  /** Si true, pas de diplomatie/échange (guerre totale) */
  totalWar: boolean;
}

// --- ROOT INTERFACE ---
export interface ScenarioDefinitionV1 {
  /** Version du schéma pour future rétrocompatibilité */
  schemaVersion: 1;
  
  /** Identifiant unique du scénario (ex: "tutorial_01") */
  id: string;
  
  meta: ScenarioMeta;
  generation: WorldGenerationConfig;
  setup: ScenarioSetup;
  objectives: VictoryConditions;
  rules: GameplayRules;
}

/**
 * EXEMPLE MINIMAL DE SCENARIO (Pour référence)
 * --------------------------------------------
 * 
 * const duelScenario: ScenarioDefinitionV1 = {
 *   schemaVersion: 1,
 *   id: "skirmish_duel_small",
 *   meta: {
 *     title: "Duel Rapide",
 *     description: "Une petite carte pour un affrontement direct.",
 *     difficulty: 2
 *   },
 *   generation: {
 *     systemCount: 40,
 *     radius: 60,
 *     topology: "cluster"
 *   },
 *   setup: {
 *     factions: [
 *       { id: "blue", name: "UEF", colorHex: "#0000FF", isPlayable: true },
 *       { id: "red", name: "Martians", colorHex: "#FF0000", isPlayable: false, aiProfile: "aggressive" }
 *     ],
 *     startingDistribution: "cluster",
 *     initialFleets: [
 *       { ownerFactionId: "blue", spawnLocation: "home_system", ships: ["carrier", "frigate", "frigate"] },
 *       { ownerFactionId: "red", spawnLocation: "home_system", ships: ["cruiser", "destroyer", "destroyer"] }
 *     ]
 *   },
 *   objectives: {
 *     win: [{ type: "elimination" }]
 *   },
 *   rules: {
 *     fogOfWar: true,
 *     useAdvancedCombat: true,
 *     aiEnabled: true,
 *     totalWar: true
 *   }
 * };
 */
