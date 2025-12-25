import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Battle,
  BattleAmmunitionBreakdown,
  BattleAmmunitionByFaction,
  FactionId,
  FactionState,
  Fleet,
  FleetState,
  GameObjectives,
  GameState,
  GameplayRules,
  ShipEntity,
  ShipType,
  StarSystem
} from '../src/shared/types';
import { resolveBattle } from '../src/engine/battle/resolution';
import { SHIP_STATS, COLORS } from '../src/content/data/static';
import { Vec3 } from '../src/engine/math/vec3';
import { sorted } from '../src/shared/sorting';
import { computeFleetRadius } from '../src/engine/fleetDerived';

type FleetComposition = Partial<Record<ShipType, number>>;

type FleetSpec =
  | { mode: 'counts'; counts: FleetComposition }
  | { mode: 'budget'; budget: number; weights: Partial<Record<ShipType, number>> };

interface SimulationPreset {
  description: string;
  factionAName?: string;
  factionBName?: string;
  seed?: number;
  turn?: number;
  fleetA: FleetSpec;
  fleetB: FleetSpec;
  runs?: number;
}

interface SimulationInput {
  runs: number;
  seed: number;
  turn: number;
  presetName: string;
  fleetA: FleetSpec;
  fleetB: FleetSpec;
  factionAName: string;
  factionBName: string;
}

interface AmmunitionTotals {
  offensiveMissiles: BattleAmmunitionBreakdown['offensiveMissiles'];
  torpedoes: BattleAmmunitionBreakdown['torpedoes'];
  interceptors: BattleAmmunitionBreakdown['interceptors'];
}

interface AggregatedResults {
  wins: Record<FactionId | 'draw', number>;
  roundsTotal: number;
  shipsLost: Record<FactionId, number>;
  ammunition: Record<FactionId, AmmunitionTotals>;
  missilesIntercepted: number;
  projectilesDestroyedByPd: number;
}

interface SimulationSummary {
  preset: string;
  runs: number;
  seed: number;
  turn: number;
  fleets: {
    blue: {
      composition: FleetComposition;
      cost: number;
    };
    red: {
      composition: FleetComposition;
      cost: number;
    };
  };
  results: {
    winRates: Record<FactionId | 'draw', number>;
    roundsAverage: number;
    shipsLostAverage: Record<FactionId, number>;
    ammunitionPerRun: Record<FactionId, AmmunitionTotals>;
    missilesInterceptedAverage: number;
    projectilesDestroyedByPdAverage: number;
  };
}

interface CliArgs {
  preset?: string;
  runs?: number;
  seed?: number;
  turn?: number;
  fleetA?: string;
  fleetB?: string;
  jsonPath?: string;
  listPresets?: boolean;
  help?: boolean;
}

const SYSTEM_ID = 'sim-system';
const DEFAULT_SEED = 1337;
const DEFAULT_TURN = 0;
const DEFAULT_RUNS = 200;
const DEFAULT_PRESET = 'core';

const SHIP_TYPE_ALIASES: Record<string, ShipType> = {
  carrier: ShipType.CARRIER,
  carriers: ShipType.CARRIER,
  cruiser: ShipType.CRUISER,
  cruisers: ShipType.CRUISER,
  destroyer: ShipType.DESTROYER,
  destroyers: ShipType.DESTROYER,
  frigate: ShipType.FRIGATE,
  frigates: ShipType.FRIGATE,
  fighter: ShipType.FIGHTER,
  fighters: ShipType.FIGHTER,
  bomber: ShipType.BOMBER,
  bombers: ShipType.BOMBER,
  transport: ShipType.TROOP_TRANSPORT,
  transports: ShipType.TROOP_TRANSPORT,
  troop_transport: ShipType.TROOP_TRANSPORT,
  trooptransports: ShipType.TROOP_TRANSPORT,
  tanker: ShipType.TANKER,
  tankers: ShipType.TANKER,
  extractor: ShipType.EXTRACTOR,
  extractors: ShipType.EXTRACTOR
};

const PRESETS: Record<string, SimulationPreset> = {
  core: {
    description: 'Escarmouche mixte de base : croiseurs, destroyers, chasseurs et quelques bombardiers.',
    fleetA: {
      mode: 'counts',
      counts: {
        [ShipType.CRUISER]: 2,
        [ShipType.DESTROYER]: 3,
        [ShipType.FIGHTER]: 4,
        [ShipType.BOMBER]: 2
      }
    },
    fleetB: {
      mode: 'counts',
      counts: {
        [ShipType.CRUISER]: 2,
        [ShipType.DESTROYER]: 2,
        [ShipType.FRIGATE]: 3,
        [ShipType.FIGHTER]: 4,
        [ShipType.BOMBER]: 1
      }
    }
  },
  bomber_spam: {
    description: 'A oppose une saturation de bombardiers à une flotte mixte orientée défense.',
    fleetA: {
      mode: 'budget',
      budget: 520,
      weights: {
        [ShipType.BOMBER]: 3,
        [ShipType.FIGHTER]: 1,
        [ShipType.CRUISER]: 1
      }
    },
    fleetB: {
      mode: 'budget',
      budget: 520,
      weights: {
        [ShipType.CRUISER]: 2,
        [ShipType.DESTROYER]: 2,
        [ShipType.FRIGATE]: 2,
        [ShipType.FIGHTER]: 1
      }
    }
  },
  invasion_transports: {
    description: 'Flotte d’invasion avec transports face à une escadre d’interdiction.',
    fleetA: {
      mode: 'counts',
      counts: {
        [ShipType.CRUISER]: 2,
        [ShipType.DESTROYER]: 2,
        [ShipType.FIGHTER]: 2,
        [ShipType.TROOP_TRANSPORT]: 2
      }
    },
    fleetB: {
      mode: 'counts',
      counts: {
        [ShipType.CRUISER]: 2,
        [ShipType.DESTROYER]: 3,
        [ShipType.FRIGATE]: 2,
        [ShipType.FIGHTER]: 3
      }
    }
  }
};

const normalizeKey = (value: string): string => value.trim().toLowerCase().replace(/[\s-]/g, '_');

const parseShipType = (value: string): ShipType => {
  const normalized = normalizeKey(value);
  const resolved = SHIP_TYPE_ALIASES[normalized];
  if (!resolved) {
    const valid = sorted(Object.keys(SHIP_TYPE_ALIASES)).join(', ');
    throw new Error(`Unknown ship type "${value}". Valid options: ${valid}`);
  }
  return resolved;
};

const parseCounts = (value: string): FleetComposition => {
  const counts: FleetComposition = {};
  if (!value.trim()) return counts;

  const entries = value.split(',');
  for (const entry of entries) {
    const [rawType, rawCount] = entry.split('=');
    if (!rawType) continue;

    const type = parseShipType(rawType);
    const count = rawCount ? Number(rawCount) : 1;
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`Invalid count "${rawCount}" for type "${rawType}".`);
    }
    counts[type] = (counts[type] ?? 0) + Math.floor(count);
  }

  return counts;
};

const parseWeights = (value: string): Partial<Record<ShipType, number>> => {
  const weights: Partial<Record<ShipType, number>> = {};
  if (!value.trim()) return weights;

  const entries = value.split(',');
  for (const entry of entries) {
    const [rawType, rawWeight] = entry.split('=');
    if (!rawType) continue;

    const type = parseShipType(rawType);
    const weight = rawWeight ? Number(rawWeight) : 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Invalid weight "${rawWeight}" for type "${rawType}".`);
    }
    weights[type] = (weights[type] ?? 0) + weight;
  }

  return weights;
};

const parseFleetSpecString = (input: string): FleetSpec => {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith('budget:')) {
    const [, budgetPart, weightsPart] = trimmed.split(':', 3);
    const budget = Number(budgetPart);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(`Invalid budget "${budgetPart}".`);
    }
    const weights = parseWeights(weightsPart ?? '');
    if (Object.keys(weights).length === 0) {
      throw new Error('At least one weight is required for budget specs.');
    }
    return { mode: 'budget', budget, weights };
  }

  const countsPart = trimmed.toLowerCase().startsWith('counts:') ? trimmed.slice(7) : trimmed;
  const counts = parseCounts(countsPart);
  if (Object.keys(counts).length === 0) {
    throw new Error('At least one ship count must be provided.');
  }
  return { mode: 'counts', counts };
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--preset':
        args.preset = argv[++i];
        break;
      case '--runs':
        args.runs = Number(argv[++i]);
        break;
      case '--seed':
        args.seed = Number(argv[++i]);
        break;
      case '--turn':
        args.turn = Number(argv[++i]);
        break;
      case '--fleetA':
        args.fleetA = argv[++i];
        break;
      case '--fleetB':
        args.fleetB = argv[++i];
        break;
      case '--json':
        args.jsonPath = argv[++i];
        break;
      case '--list-presets':
        args.listPresets = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          console.warn(`Option inconnue ignorée : ${arg}`);
        }
    }
  }

  return args;
};

const formatCounts = (counts: FleetComposition): string => {
  const entries = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0);
  if (entries.length === 0) return 'aucun vaisseau';

  return sorted(entries, ([typeA], [typeB]) => typeA.localeCompare(typeB))
    .map(([type, count]) => `${type} x${count}`)
    .join(', ');
};

const ensureAmmunitionTotals = (input?: BattleAmmunitionBreakdown): AmmunitionTotals => {
  const fallbackTally = { initial: 0, remaining: 0, used: 0 };
  const base: BattleAmmunitionBreakdown = input ?? {
    offensiveMissiles: { ...fallbackTally },
    torpedoes: { ...fallbackTally },
    interceptors: { ...fallbackTally }
  };

  return {
    offensiveMissiles: { ...fallbackTally, ...base.offensiveMissiles },
    torpedoes: { ...fallbackTally, ...base.torpedoes },
    interceptors: { ...fallbackTally, ...base.interceptors }
  };
};

const mergeAmmunition = (target: AmmunitionTotals, source: AmmunitionTotals): void => {
  (['offensiveMissiles', 'torpedoes', 'interceptors'] as const).forEach(key => {
    target[key].initial += source[key].initial;
    target[key].remaining += source[key].remaining;
    target[key].used += source[key].used;
  });
};

const cloneVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

const createSystem = (id: string, position: Vec3): StarSystem => ({
  id,
  name: id,
  position: cloneVec(position),
  color: COLORS.star,
  size: 1,
  ownerFactionId: null,
  resourceType: 'none',
  isHomeworld: false,
  planets: []
});

const createShip = (type: ShipType, index: number, prefix: string): ShipEntity => {
  const stats = SHIP_STATS[type];
  const maxHp = stats?.maxHp ?? 100;
  return {
    id: `${prefix}-${type}-${index}`,
    type,
    hp: maxHp,
    maxHp,
    fuel: stats?.fuelCapacity ?? 0,
    carriedArmyId: null,
    offensiveMissilesLeft: stats?.offensiveMissileStock ?? 0,
    torpedoesLeft: stats?.torpedoStock ?? 0,
    interceptorsLeft: stats?.interceptorStock ?? 0,
    consumables: {
      offensiveMissiles: stats?.offensiveMissileStock ?? 0,
      torpedoes: stats?.torpedoStock ?? 0,
      interceptors: stats?.interceptorStock ?? 0
    }
  };
};

const buildCountsFromBudget = (budget: number, weights: Partial<Record<ShipType, number>>): FleetComposition => {
  const entries = Object.entries(weights)
    .filter(([, weight]) => typeof weight === 'number' && weight > 0)
    .map(([type, weight]) => {
      const typed = type as ShipType;
      const stats = SHIP_STATS[typed];
      const cost = stats?.cost ?? 0;
      if (cost <= 0) {
        throw new Error(`Missing or zero cost for ship type "${typed}" in SHIP_STATS.`);
      }
      return { type: typed, weight: weight as number, cost };
    });

  if (entries.length === 0) {
    throw new Error('Budget specs require at least one positive weight entry.');
  }

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    throw new Error('Total weight must be positive.');
  }

  const counts: FleetComposition = {};
  const cheapest = entries.reduce((best, entry) => (entry.cost < best.cost ? entry : best), entries[0]);

  for (const entry of entries) {
    const share = entry.weight / totalWeight;
    const shareBudget = budget * share;
    const tentative = Math.floor(shareBudget / entry.cost);
    if (tentative > 0) {
      counts[entry.type] = tentative;
    }
  }

  let spent = Object.entries(counts).reduce(
    (sum, [type, count]) => sum + (count ?? 0) * (SHIP_STATS[type as ShipType]?.cost ?? 0),
    0
  );

  if (spent === 0 && cheapest.cost <= budget) {
    counts[cheapest.type] = 1;
    spent = cheapest.cost;
  }

  let remaining = budget - spent;
  while (remaining >= cheapest.cost) {
    const affordable = sorted(
      entries.filter(entry => entry.cost <= remaining),
      (a, b) => {
        const ratioA = a.weight / a.cost;
        const ratioB = b.weight / b.cost;
        return ratioB !== ratioA ? ratioB - ratioA : a.type.localeCompare(b.type);
      }
    );

    if (affordable.length === 0) break;
    const selected = affordable[0];
    counts[selected.type] = (counts[selected.type] ?? 0) + 1;
    remaining -= selected.cost;
  }

  return counts;
};

const resolveFleetSpec = (spec: FleetSpec): FleetComposition => {
  if (spec.mode === 'counts') {
    return spec.counts;
  }
  return buildCountsFromBudget(spec.budget, spec.weights);
};

const calculateFleetCost = (composition: FleetComposition): number => {
  return Object.entries(composition).reduce((sum, [type, count]) => {
    const stats = SHIP_STATS[type as ShipType];
    return sum + (count ?? 0) * (stats?.cost ?? 0);
  }, 0);
};

const createFleet = (
  id: string,
  factionId: string,
  position: Vec3,
  systemId: string,
  composition: FleetComposition,
  turn: number
): Fleet => {
  const ships: ShipEntity[] = [];
  Object.entries(composition).forEach(([type, count]) => {
    const typed = type as ShipType;
    const max = Math.max(0, count ?? 0);
    for (let i = 0; i < max; i++) {
      ships.push(createShip(typed, i + 1, id));
    }
  });

  return {
    id,
    factionId,
    ships,
    position: cloneVec(position),
    state: FleetState.ORBIT,
    targetSystemId: systemId,
    targetPosition: cloneVec(position),
    radius: computeFleetRadius(ships.length),
    stateStartTurn: turn
  };
};

const createBaseState = (
  system: StarSystem,
  fleetA: Fleet,
  fleetB: Fleet,
  seed: number,
  turn: number,
  factionAName: string,
  factionBName: string
): GameState => {
  const rules: GameplayRules = {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: true,
    unlimitedFuel: false
  };

  const objectives: GameObjectives = {
    conditions: []
  };

  const factions: FactionState[] = [
    { id: fleetA.factionId, name: factionAName, color: COLORS.blue, isPlayable: false },
    { id: fleetB.factionId, name: factionBName, color: COLORS.red, isPlayable: false }
  ];

  return {
    scenarioId: 'battle-sim',
    playerFactionId: fleetA.factionId,
    factions,
    seed,
    rngState: seed,
    startYear: 0,
    day: turn,
    systems: [system],
    fleets: [fleetA, fleetB],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: [],
    selectedFleetId: null,
    winnerFactionId: null,
    objectives,
    rules
  };
};

const runSingleBattle = (
  iteration: number,
  params: SimulationInput,
  compositions: { blue: FleetComposition; red: FleetComposition }
) => {
  const systemPosition: Vec3 = { x: 0, y: 0, z: 0 };
  const system = createSystem(SYSTEM_ID, systemPosition);
  const fleetA = createFleet('fleet-blue', 'blue', systemPosition, SYSTEM_ID, compositions.blue, params.turn);
  const fleetB = createFleet('fleet-red', 'red', systemPosition, SYSTEM_ID, compositions.red, params.turn);

  const state = createBaseState(
    system,
    fleetA,
    fleetB,
    params.seed,
    params.turn,
    params.factionAName,
    params.factionBName
  );

  const battle: Battle = {
    id: `sim-${params.presetName}-${iteration}`,
    systemId: SYSTEM_ID,
    turnCreated: params.turn,
    status: 'scheduled',
    involvedFleetIds: [fleetA.id, fleetB.id],
    logs: []
  };

  return resolveBattle(battle, state, params.turn).updatedBattle;
};

const aggregateResults = (
  params: SimulationInput,
  compositions: { blue: FleetComposition; red: FleetComposition }
): SimulationSummary => {
  const totals: AggregatedResults = {
    wins: { blue: 0, red: 0, draw: 0 },
    roundsTotal: 0,
    shipsLost: { blue: 0, red: 0 },
    ammunition: {
      blue: ensureAmmunitionTotals(),
      red: ensureAmmunitionTotals()
    },
    missilesIntercepted: 0,
    projectilesDestroyedByPd: 0
  };

  for (let i = 0; i < params.runs; i++) {
    const updatedBattle = runSingleBattle(i, params, compositions);
    const winner = updatedBattle.winnerFactionId ?? 'draw';
    totals.wins[winner] = (totals.wins[winner] ?? 0) + 1;

    totals.roundsTotal += updatedBattle.roundsPlayed ?? 0;
    totals.missilesIntercepted += updatedBattle.missilesIntercepted ?? 0;
    totals.projectilesDestroyedByPd += updatedBattle.projectilesDestroyedByPd ?? 0;

    const shipLosses = updatedBattle.shipsLost ?? {};
    totals.shipsLost.blue += shipLosses.blue ?? 0;
    totals.shipsLost.red += shipLosses.red ?? 0;

    const ammunitionByFaction: BattleAmmunitionByFaction = updatedBattle.ammunitionByFaction ?? {};
    (['blue', 'red'] as const).forEach(faction => {
      const breakdown = ensureAmmunitionTotals(ammunitionByFaction[faction]);
      mergeAmmunition(totals.ammunition[faction], breakdown);
    });
  }

  const roundsAverage = totals.roundsTotal / params.runs;
  const shipsLostAverage: Record<FactionId, number> = {
    blue: totals.shipsLost.blue / params.runs,
    red: totals.shipsLost.red / params.runs
  };

  const ammunitionPerRun: Record<FactionId, AmmunitionTotals> = {
    blue: ensureAmmunitionTotals(),
    red: ensureAmmunitionTotals()
  };

  (['blue', 'red'] as const).forEach(faction => {
    mergeAmmunition(ammunitionPerRun[faction], {
      offensiveMissiles: {
        initial: totals.ammunition[faction].offensiveMissiles.initial / params.runs,
        remaining: totals.ammunition[faction].offensiveMissiles.remaining / params.runs,
        used: totals.ammunition[faction].offensiveMissiles.used / params.runs
      },
      torpedoes: {
        initial: totals.ammunition[faction].torpedoes.initial / params.runs,
        remaining: totals.ammunition[faction].torpedoes.remaining / params.runs,
        used: totals.ammunition[faction].torpedoes.used / params.runs
      },
      interceptors: {
        initial: totals.ammunition[faction].interceptors.initial / params.runs,
        remaining: totals.ammunition[faction].interceptors.remaining / params.runs,
        used: totals.ammunition[faction].interceptors.used / params.runs
      }
    });
  });

  const winRates: Record<FactionId | 'draw', number> = {
    blue: (totals.wins.blue / params.runs) * 100,
    red: (totals.wins.red / params.runs) * 100,
    draw: (totals.wins.draw / params.runs) * 100
  };

  return {
    preset: params.presetName,
    runs: params.runs,
    seed: params.seed,
    turn: params.turn,
    fleets: {
      blue: {
        composition: compositions.blue,
        cost: calculateFleetCost(compositions.blue)
      },
      red: {
        composition: compositions.red,
        cost: calculateFleetCost(compositions.red)
      }
    },
    results: {
      winRates,
      roundsAverage,
      shipsLostAverage,
      ammunitionPerRun,
      missilesInterceptedAverage: totals.missilesIntercepted / params.runs,
      projectilesDestroyedByPdAverage: totals.projectilesDestroyedByPd / params.runs
    }
  };
};

const printPresetList = (): void => {
  console.log('Présélections disponibles :');
  sorted(Object.entries(PRESETS), ([a], [b]) => a.localeCompare(b)).forEach(([name, preset]) => {
    console.log(`  - ${name}: ${preset.description}`);
  });
};

const printSummary = (summary: SimulationSummary): void => {
  console.log('=== BattleSim - Résumé ===');
  console.log(`Preset        : ${summary.preset}`);
  console.log(`Itérations    : ${summary.runs}`);
  console.log(`Seed / Tour   : ${summary.seed} / ${summary.turn}`);
  console.log('');
  console.log(`Blue (${summary.fleets.blue.cost} crédits) : ${formatCounts(summary.fleets.blue.composition)}`);
  console.log(`Red  (${summary.fleets.red.cost} crédits) : ${formatCounts(summary.fleets.red.composition)}`);
  console.log('');
  console.log('Taux de victoire :');
  console.log(`  Blue : ${summary.results.winRates.blue.toFixed(2)}%`);
  console.log(`  Red  : ${summary.results.winRates.red.toFixed(2)}%`);
  console.log(`  Nuls : ${summary.results.winRates.draw.toFixed(2)}%`);
  console.log('');
  console.log(`Rounds moyens : ${summary.results.roundsAverage.toFixed(2)}`);
  console.log(
    `Pertes moyennes : Blue ${summary.results.shipsLostAverage.blue.toFixed(2)} | Red ${summary.results.shipsLostAverage.red.toFixed(2)}`
  );
  console.log(
    `Interceptions (moy.) : Soft=${summary.results.missilesInterceptedAverage.toFixed(
      2
    )} | PD=${summary.results.projectilesDestroyedByPdAverage.toFixed(2)}`
  );
  console.log('');
  console.log('Munitions moyennes / run :');
  (['blue', 'red'] as const).forEach(faction => {
    const ammo = summary.results.ammunitionPerRun[faction];
    console.log(`  ${faction.toUpperCase()}:`);
    console.log(
      `    Missiles : used ${ammo.offensiveMissiles.used.toFixed(2)} / initial ${ammo.offensiveMissiles.initial.toFixed(2)}`
    );
    console.log(
      `    Torpilles: used ${ammo.torpedoes.used.toFixed(2)} / initial ${ammo.torpedoes.initial.toFixed(2)}`
    );
    console.log(
      `    Intercep.: used ${ammo.interceptors.used.toFixed(2)} / initial ${ammo.interceptors.initial.toFixed(2)}`
    );
  });
};

const writeJsonReport = async (summary: SimulationSummary, filePath: string): Promise<void> => {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const payload = JSON.stringify(summary, null, 2);
  await fs.writeFile(resolvedPath, payload, 'utf8');
  console.log(`\nRapport JSON enregistré dans ${resolvedPath}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm run battle:sim -- [options]');
    console.log('Options :');
    console.log('  --preset <nom>        Sélectionne un preset (core, bomber_spam, invasion_transports)');
    console.log('  --runs <N>            Nombre d’itérations (200 à 2000 recommandé)');
    console.log('  --seed <number>       Seed globale du GameState (par défaut 1337)');
    console.log('  --turn <number>       Tour utilisé pour la résolution (par défaut 0)');
    console.log('  --fleetA <spec>       Composition custom pour Blue');
    console.log('  --fleetB <spec>       Composition custom pour Red');
    console.log('  --json <path>         Exporte le résumé au format JSON');
    console.log('  --list-presets        Liste les presets disponibles');
    console.log('  --help                Affiche cette aide');
    console.log('');
    console.log('Formats de composition :');
    console.log('  counts:cruiser=2,destroyer=3 (par défaut, le prefix counts: est optionnel)');
    console.log('  budget:500:cruiser=1,destroyer=2 (budget + poids)');
    return;
  }

  if (args.listPresets) {
    printPresetList();
    return;
  }

  const preset = (args.preset && PRESETS[args.preset]) ? PRESETS[args.preset] : PRESETS[DEFAULT_PRESET];
  const presetName = args.preset && PRESETS[args.preset] ? args.preset : DEFAULT_PRESET;

  const runs = Number.isFinite(args.runs) ? Number(args.runs) : preset.runs ?? DEFAULT_RUNS;
  const seed = Number.isFinite(args.seed) ? Number(args.seed) : preset.seed ?? DEFAULT_SEED;
  const turn = Number.isFinite(args.turn) ? Number(args.turn) : preset.turn ?? DEFAULT_TURN;

  const fleetSpecA = args.fleetA ? parseFleetSpecString(args.fleetA) : preset.fleetA;
  const fleetSpecB = args.fleetB ? parseFleetSpecString(args.fleetB) : preset.fleetB;

  const compositions = {
    blue: resolveFleetSpec(fleetSpecA),
    red: resolveFleetSpec(fleetSpecB)
  };

  const params: SimulationInput = {
    runs,
    seed,
    turn,
    presetName,
    fleetA: fleetSpecA,
    fleetB: fleetSpecB,
    factionAName: preset.factionAName ?? 'Blue',
    factionBName: preset.factionBName ?? 'Red'
  };

  const summary = aggregateResults(params, compositions);
  printSummary(summary);

  if (args.jsonPath) {
    await writeJsonReport(summary, args.jsonPath);
  }
};

main().catch(error => {
  console.error('Erreur dans le simulateur :', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
