import { ShipType, sorted } from '../shared/shared';

// ============================================================
// Scenario schema + runtime helpers (was: content/scenarios/*)
// ============================================================

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

  /** Flottes présentes au début du tour 1 */
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
  maxTurns?: number;
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
}

// The runtime scenario object includes the resolved seed.
export type GameScenario = ScenarioDefinitionV1 & { seed: number };
export type ScenarioTemplate = ScenarioDefinitionV1;

// ============================================================
// Templates (was: content/scenarios/templates/*.ts)
// ============================================================

const conquestSandbox: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: 'conquest_sandbox',
  meta: {
    title: 'Conquest Sandbox',
    description: 'An open-ended sandbox scenario with a Ring topology and a central Galactic Core.',
    difficulty: 2,
    tags: ['Sandbox', 'Ring']
  },
  generation: {
    systemCount: 80,
    radius: 120,
    topology: 'ring',
    staticSystems: [
      {
        id: 'galactic_core',
        name: 'Galactic Core',
        position: { x: 0, y: 0, z: 0 },
        resourceType: 'gas'
      }
    ]
  },
  setup: {
    factions: [
      { id: 'blue', name: 'United Earth Fleet', colorHex: '#3b82f6', isPlayable: true },
      { id: 'red', name: 'Martian Syndicate', colorHex: '#ef4444', isPlayable: false, aiProfile: 'aggressive' }
    ],
    startingDistribution: 'cluster',
    initialFleets: [
      {
        ownerFactionId: 'blue',
        spawnLocation: 'home_system',
        ships: [
          'carrier',
          'cruiser',
          'cruiser',
          'destroyer',
          'destroyer',
          'frigate',
          'frigate',
          'extractor',
          'fighter',
          'fighter',
          'fighter'
        ],
        withArmies: false
      },
      {
        ownerFactionId: 'blue',
        spawnLocation: 'home_system',
        ships: ['transporter', 'transporter', 'transporter', 'transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      },
      {
        ownerFactionId: 'red',
        spawnLocation: 'home_system',
        ships: [
          'carrier',
          'cruiser',
          'cruiser',
          'destroyer',
          'destroyer',
          'frigate',
          'frigate',
          'extractor',
          'bomber',
          'bomber',
          'fighter'
        ],
        withArmies: false
      },
      {
        ownerFactionId: 'red',
        spawnLocation: 'home_system',
        ships: ['transporter', 'transporter', 'transporter', 'transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      }
    ]
  },
  objectives: {
    win: [{ type: 'elimination' }]
  },
  rules: {
    fogOfWar: true,
    useAdvancedCombat: true,
    aiEnabled: true,
    totalWar: true,
    unlimitedFuel: false
  }
};

const spiralConvergence: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: 'spiral_convergence',
  meta: {
    title: 'Spiral Convergence',
    description:
      'Rival coalitions converge along a tightening spiral arm, racing to seize the core while defending their expanding frontier.',
    difficulty: 3,
    tags: ['Spiral', 'Conquest']
  },
  generation: {
    systemCount: 72,
    radius: 140,
    topology: 'spiral',
    minimumSystemSpacingLy: 6,
    staticSystems: [
      {
        id: 'aurora_gate',
        name: 'Aurora Gate',
        position: { x: -18, y: 6, z: 0 },
        resourceType: 'gas'
      },
      {
        id: 'ember_core',
        name: 'Ember Core',
        position: { x: 18, y: -6, z: 0 },
        resourceType: 'gas'
      }
    ]
  },
  setup: {
    factions: [
      { id: 'aurora', name: 'Aurora Coalition', colorHex: '#38bdf8', isPlayable: true },
      { id: 'ember', name: 'Ember Dominion', colorHex: '#f97316', isPlayable: false, aiProfile: 'balanced' }
    ],
    startingDistribution: 'cluster',
    territoryAllocation: {
      type: 'percentages',
      byFactionId: { aurora: 0.12, ember: 0.12 },
      neutralShare: 0.76,
      contiguity: 'clustered'
    },
    initialFleets: [
      {
        ownerFactionId: 'aurora',
        spawnLocation: 'home_system',
        ships: [
          'carrier',
          'cruiser',
          'cruiser',
          'destroyer',
          'destroyer',
          'frigate',
          'tanker',
          'extractor',
          'bomber',
          'fighter',
          'fighter'
        ],
        withArmies: false
      },
      {
        ownerFactionId: 'aurora',
        spawnLocation: 'home_system',
        ships: ['transporter', 'transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      },
      {
        ownerFactionId: 'aurora',
        spawnLocation: 'random',
        ships: ['cruiser', 'destroyer', 'frigate', 'fighter', 'fighter'],
        withArmies: false
      },
      {
        ownerFactionId: 'aurora',
        spawnLocation: 'random',
        ships: ['transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      },
      {
        ownerFactionId: 'ember',
        spawnLocation: 'home_system',
        ships: [
          'carrier',
          'cruiser',
          'cruiser',
          'destroyer',
          'destroyer',
          'frigate',
          'tanker',
          'extractor',
          'bomber',
          'fighter',
          'fighter'
        ],
        withArmies: false
      },
      {
        ownerFactionId: 'ember',
        spawnLocation: 'home_system',
        ships: ['transporter', 'transporter', 'transporter', 'destroyer', 'frigate'],
        withArmies: true
      }
    ]
  },
  objectives: {
    win: [{ type: 'domination', value: 0.6 }],
    maxTurns: 200
  },
  rules: {
    fogOfWar: true,
    useAdvancedCombat: true,
    aiEnabled: true,
    totalWar: true,
    unlimitedFuel: false
  }
};

// ============================================================
// Registry + builder (was: content/scenarios/registry.ts + index.ts)
// ============================================================

const templatesToLoad: Array<{ data: ScenarioTemplate; name: string }> = [
  { data: conquestSandbox, name: 'conquest_sandbox.ts' },
  { data: spiralConvergence, name: 'spiral_convergence.ts' }
];

/**
 * Validates a raw JSON object against the ScenarioTemplate V1 schema.
 * Performs structural checks and basic referential integrity checks.
 */
function validateScenarioV1(data: unknown, fileName: string): ScenarioTemplate | null {
  try {
    if (typeof data !== 'object' || data === null) throw new Error('Not a JSON object');
    const s = data as any;

    // 1. Root fields
    if (s.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion: ${s.schemaVersion}`);
    if (typeof s.id !== 'string' || !s.id) throw new Error("Missing or invalid 'id'");

    // 2. Meta
    if (!s.meta || typeof s.meta !== 'object') throw new Error("Missing 'meta'");
    if (typeof s.meta.title !== 'string') throw new Error("Missing 'meta.title'");
    if (typeof s.meta.description !== 'string') throw new Error("Missing 'meta.description'");

    // 3. Generation
    if (!s.generation || typeof s.generation !== 'object') throw new Error("Missing 'generation'");
    if (typeof s.generation.systemCount !== 'number') throw new Error("Missing 'generation.systemCount'");
    if (typeof s.generation.radius !== 'number') throw new Error("Missing 'generation.radius'");
    if (typeof s.generation.topology !== 'string') throw new Error("Missing 'generation.topology'");

    // 3b. Optional Generation Constraints
    if (s.generation.minimumSystemSpacingLy !== undefined && s.generation.minimumSystemSpacingLy !== null) {
      if (typeof s.generation.minimumSystemSpacingLy !== 'number' || !Number.isFinite(s.generation.minimumSystemSpacingLy)) {
        throw new Error("Invalid 'generation.minimumSystemSpacingLy' (expected a finite number)");
      }
      if (s.generation.minimumSystemSpacingLy < 0) {
        throw new Error("Invalid 'generation.minimumSystemSpacingLy' (must be >= 0; use 0 to disable)");
      }
    }

    // 4. Setup
    if (!s.setup || typeof s.setup !== 'object') throw new Error("Missing 'setup'");
    if (!Array.isArray(s.setup.factions) || s.setup.factions.length === 0) throw new Error("Missing or empty 'setup.factions'");
    if (!Array.isArray(s.setup.initialFleets)) throw new Error("Missing 'setup.initialFleets'");

    // 5. Rules & Objectives
    if (!s.rules || typeof s.rules !== 'object') throw new Error("Missing 'rules'");
    if (!s.objectives || !Array.isArray(s.objectives.win)) throw new Error("Missing 'objectives.win'");

    // 6. Referential Integrity (Faction IDs)
    const factionIds = new Set<string>();
    for (const f of s.setup.factions) {
      if (typeof f.id !== 'string') throw new Error('Invalid faction ID');
      factionIds.add(f.id);
    }

    // 6b. Optional Territory Allocation Validation
    if (s.setup.territoryAllocation !== undefined && s.setup.territoryAllocation !== null) {
      const ta = s.setup.territoryAllocation as any;
      if (ta.type !== 'percentages') throw new Error('Unsupported setup.territoryAllocation.type');
      if (!ta.byFactionId || typeof ta.byFactionId !== 'object') throw new Error('Missing setup.territoryAllocation.byFactionId');

      let sum = 0;
      for (const [fid, share] of Object.entries(ta.byFactionId)) {
        if (!factionIds.has(fid)) throw new Error(`territoryAllocation references unknown factionId: '${fid}'`);
        if (typeof share !== 'number' || !isFinite(share) || share < 0 || share > 1) {
          throw new Error(`Invalid territoryAllocation share for '${fid}'`);
        }
        sum += share;
      }

      if (ta.neutralShare !== undefined && ta.neutralShare !== null) {
        if (typeof ta.neutralShare !== 'number' || !isFinite(ta.neutralShare) || ta.neutralShare < 0 || ta.neutralShare > 1) {
          throw new Error('Invalid territoryAllocation.neutralShare');
        }
        sum += ta.neutralShare;
      }

      // Allow small floating errors
      if (sum > 1.00001) throw new Error(`territoryAllocation shares sum to > 1.0 (${sum})`);
    }

    const knownShipTypes = new Set<string>(Object.values(ShipType));
    for (const fleet of s.setup.initialFleets) {
      if (!factionIds.has(fleet.ownerFactionId)) {
        throw new Error(`Fleet definition references unknown faction ID: '${fleet.ownerFactionId}'`);
      }
      if (!Array.isArray(fleet.ships) || fleet.ships.length === 0) {
        throw new Error(`Fleet definition for '${fleet.ownerFactionId}' has no ships`);
      }
      if (fleet.ships.some((t: any) => typeof t !== 'string' || t.trim() === '')) {
        throw new Error('Fleet definition contains invalid ship type strings');
      }

      fleet.ships.forEach((t: string) => {
        if (!knownShipTypes.has(t)) {
          console.warn(
            `[ScenarioRegistry] Fleet '${fleet.ownerFactionId}' declares unknown ship type '${t}'. ` +
              'It will be replaced with a fallback during world generation.'
          );
        }
      });
    }

    return s as ScenarioTemplate;
  } catch (e) {
    console.warn(`[ScenarioRegistry] Failed to load scenario '${fileName}': ${(e as Error).message}`);
    return null;
  }
}

const loadedScenarios: ScenarioTemplate[] = [];
let failedCount = 0;

for (const { data, name } of templatesToLoad) {
  const validated = validateScenarioV1(data, name);
  if (validated) {
    loadedScenarios.push(validated);
  } else {
    failedCount++;
  }
}

if (failedCount > 0) {
  console.error(`[ScenarioRegistry] ${failedCount} scenario(s) failed to load. Check warnings above for details.`);
}

const SCENARIO_REGISTRY = sorted(loadedScenarios, (a, b) => {
  const diff = (a.meta.difficulty || 0) - (b.meta.difficulty || 0);
  if (diff !== 0) return diff;
  return a.meta.title.localeCompare(b.meta.title);
});

export interface ScenarioBuildOptions {
  rules?: Partial<ScenarioTemplate['rules']>;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = SCENARIO_REGISTRY;

export const buildScenario = (templateId: string, seed: number, options?: ScenarioBuildOptions): GameScenario => {
  const template = SCENARIO_TEMPLATES.find(t => t.id === templateId) || SCENARIO_TEMPLATES[0];

  if (!template) {
    throw new Error('No scenarios available in registry.');
  }

  const finalSeed =
    template.generation.fixedSeed !== undefined && template.generation.fixedSeed !== null ? template.generation.fixedSeed : seed;

  return {
    ...template,
    rules: {
      ...template.rules,
      ...(options?.rules ?? {})
    },
    seed: finalSeed
  };
};

