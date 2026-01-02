import { CAPTURE_RANGE_SQ, SHIP_STATS } from '../content/data/static';
import { devWarn } from '../shared/shared';
import { sorted } from '../shared/shared';
import {
  type Battle,
  type BattleAmmunitionBreakdown,
  type BattleAmmunitionByFaction,
  type BattleAmmunitionTally,
  type BattleShipSnapshot,
  type FactionId,
  type ShipConsumables,
  type ShipEntity,
  type ShipKillRecord,
  type GameState,
  type Fleet
} from '../shared/shared';
import { FleetState, ShipType } from '../shared/shared';
import { shortId } from '../shared/shared';
import { distSq } from './math/vec3';
import { RNG } from './rng';
import { withUpdatedFleetDerived } from './fleetDerived';

// ---------------------------------------
// Balance profile (was: battle/balance.ts)
// ---------------------------------------

interface TargetingTuning {
  frictionKeepChance: number;
  capitalFocusBomberChance: number;
  transportFocus: {
    base: number;
    perRound: number;
    max: number;
  };
}

interface PacingTuning {
  maxRounds: number;
  etaMissile: number;
  etaTorpedo: number;
  baseAccuracy: number;
  lockGainPerRound: number;
  maxLaunchPerRound: number;
}

interface InterceptionTuning {
  baseChance: number;
}

interface DefenseTuning {
  pdDamagePerPoint: number;
  missileHp: number;
  torpedoHp: number;
}

interface BalanceConfig {
  profile: 'Balance v1.1';
  targeting: TargetingTuning;
  pacing: PacingTuning;
  interception: InterceptionTuning;
  defense: DefenseTuning;
}

export const BALANCE_PROFILE_V11: BalanceConfig = {
  profile: 'Balance v1.1',
  targeting: {
    // 80% chance de conserver la cible si elle reste valide
    frictionKeepChance: 0.6,
    // Faible focus bomber pour les capitals (anti-spam strike craft)
    capitalFocusBomberChance: 0.25,
    // Faible focus transport, croissant avec le round pour éviter les cibles invisibles
    transportFocus: {
      base: 0.05,
      perRound: 0.02,
      max: 0.12
    }
  },
  pacing: {
    // Allonger pour casser les draws persistants
    maxRounds: 10,
    etaMissile: 2,
    etaTorpedo: 3,
    // Hausse marquée pour rendre les tirs cinétiques décisifs
    baseAccuracy: 0.85,
    lockGainPerRound: 0.35,
    maxLaunchPerRound: 3
  },
  interception: {
    // Chance de base d’interception (après la tentative)
    baseChance: 0.15
  },
  defense: {
    // Dégâts PD infligés aux projectiles entrants par point de pdStrength
    // Légère réduction pour rendre les salves plus punitives
    pdDamagePerPoint: 6,
    // Durabilité des missiles et torpilles (inchangée)
    missileHp: 50,
    torpedoHp: 150
  }
};

// -----------------------------------------
// Battle constants (was: battle/constants.ts)
// -----------------------------------------

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
export const INTERCEPTION_BASE_CHANCE = BALANCE_PROFILE.interception.baseChance;

// PD
export const PD_DAMAGE_PER_POINT = BALANCE_PROFILE.defense.pdDamagePerPoint;
export const MISSILE_HP = BALANCE_PROFILE.defense.missileHp;
export const TORPEDO_HP = BALANCE_PROFILE.defense.torpedoHp;

// -------------------------------------
// Battle types (was: battle/types.ts)
// -------------------------------------

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
  offensiveMissilesLeft: number;
  torpedoesLeft: number;
  interceptorsLeft: number;

  // Tactical State (Reset or updated each round)
  fireControlLock: number; // 0.0 to 1.0 (Target Lock)
  maneuverBudget: number; // Used for evasion calculation
  targetId: string | null;

  // Stats Cache
  evasion: number;
  pdStrength: number;
  damage: number;
  missileDamage: number;
  torpedoDamage: number;

  killHistory: ShipKillRecord[];
}

// ------------------------------------------
// Targeting (was: battle/targeting.ts)
// ------------------------------------------

// Priority Tables (Lower index = Higher priority)
const PRIORITIES: Record<ShipType, ShipType[]> = {
  [ShipType.CARRIER]: [
    ShipType.CARRIER,
    ShipType.CRUISER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.CRUISER]: [
    ShipType.CARRIER,
    ShipType.CRUISER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.DESTROYER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.FRIGATE]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.FIGHTER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.BOMBER]: [
    ShipType.CARRIER,
    ShipType.CRUISER,
    ShipType.DESTROYER,
    ShipType.FRIGATE,
    ShipType.SUPPORT,
    ShipType.BUILDER,
    ShipType.TRANSPORTER
  ],
  [ShipType.TRANSPORTER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.BUILDER
  ],
  [ShipType.BUILDER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.TRANSPORTER
  ],
  [ShipType.SUPPORT]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.TRANSPORTER,
    ShipType.BUILDER
  ],
  [ShipType.TANKER]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.BUILDER
  ],
  [ShipType.EXTRACTOR]: [
    ShipType.BOMBER,
    ShipType.FIGHTER,
    ShipType.FRIGATE,
    ShipType.DESTROYER,
    ShipType.CRUISER,
    ShipType.SUPPORT,
    ShipType.BUILDER
  ]
};

export function selectTarget(
  attacker: BattleShipState,
  enemies: BattleShipState[],
  rand: () => number,
  options?: {
    enemiesByType?: Map<ShipType, BattleShipState[]>;
    shipLookup?: Map<string, BattleShipState>;
    round?: number;
  }
): string | null {
  if (enemies.length === 0) return null;

  const { enemiesByType, shipLookup, round = 1 } = options ?? {};

  // 1. Friction: Keep current target if valid and random check passes
  if (attacker.targetId) {
    const current = shipLookup?.get(attacker.targetId) ?? enemies.find(e => e.shipId === attacker.targetId);
    if (current && current.currentHp > 0 && current.faction !== attacker.faction) {
      // Keep target if valid based on configured friction
      if (rand() < TARGET_FRICTION_KEEP_CHANCE) return attacker.targetId;
    }
  }

  const getCandidatesForType = (type: ShipType) => {
    const prefiltered = enemiesByType?.get(type);
    if (prefiltered) return prefiltered;

    return enemies.filter(e => e.type === type && e.currentHp > 0);
  };

  // 2. Focus logic (probabilistic)
  const transportFocusChance = Math.min(
    TARGET_TRANSPORT_FOCUS_MAX,
    TARGET_TRANSPORT_FOCUS_BASE + TARGET_TRANSPORT_FOCUS_PER_ROUND * (round - 1)
  );

  const transports = getCandidatesForType(ShipType.TRANSPORTER);
  if (transports.length > 0 && rand() < transportFocusChance) {
    const idx = Math.floor(rand() * transports.length) % transports.length;
    return transports[idx].shipId;
  }

  const bombers = getCandidatesForType(ShipType.BOMBER);
  if (
    bombers.length > 0 &&
    (attacker.type === ShipType.CARRIER || attacker.type === ShipType.CRUISER) &&
    rand() < TARGET_CAPITAL_FOCUS_BOMBER_CHANCE
  ) {
    const idx = Math.floor(rand() * bombers.length) % bombers.length;
    return bombers[idx].shipId;
  }

  // 3. Priority Selection
  const priorityList = PRIORITIES[attacker.type] || [];

  // Try to find targets by priority class
  for (const type of priorityList) {
    const candidates = getCandidatesForType(type);
    if (candidates.length > 0) {
      // Pick random within class
      const idx = Math.floor(rand() * candidates.length) % candidates.length;
      return candidates[idx].shipId;
    }
  }

  // 4. Fallback: Any living enemy
  const validEnemies = enemiesByType ? Array.from(enemiesByType.values()).flatMap(list => list) : enemies.filter(e => e.currentHp > 0);

  if (validEnemies.length > 0) {
    const idx = Math.floor(rand() * validEnemies.length) % validEnemies.length;
    return validEnemies[idx].shipId;
  }

  return null;
}

// ------------------------------------------
// Detection (was: battle/detection.ts)
// ------------------------------------------

/**
 * Scans the galaxy for contested systems.
 * Rule: A battle starts if at least two DIFFERENT factions have fleets within range.
 */
export function detectNewBattles(state: GameState, rng: RNG, turn: number): Battle[] {
  const newBattles: Battle[] = [];

  const activeBattleSystemIds = new Set(state.battles.filter(b => b.status !== 'resolved').map(b => b.systemId));

  const activeSystems = state.systems.filter(system => !activeBattleSystemIds.has(system.id));
  const activeSystemsById = new Map(activeSystems.map(system => [system.id, system]));

  const engageableFleets = state.fleets.filter(fleet => {
    if (fleet.state === FleetState.COMBAT) return false;
    if (fleet.ships.length === 0) return false;
    return true;
  });
  const engageableFleetsById = new Map(engageableFleets.map(fleet => [fleet.id, fleet]));

  const fleetAssignments = new Map<string, string>();

  engageableFleets.forEach(fleet => {
    let nearestSystemId: string | null = null;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;

    activeSystems.forEach(system => {
      const distanceSq = distSq(fleet.position, system.position);
      if (distanceSq > CAPTURE_RANGE_SQ) return;
      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearestSystemId = system.id;
      }
    });

    if (nearestSystemId) {
      fleetAssignments.set(fleet.id, nearestSystemId);
    }
  });

  const systemAssignments = new Map<string, string[]>();

  fleetAssignments.forEach((systemId, fleetId) => {
    const fleets = systemAssignments.get(systemId) ?? [];
    fleets.push(fleetId);
    systemAssignments.set(systemId, fleets);
  });

  systemAssignments.forEach((fleetIds, systemId) => {
    const system = activeSystemsById.get(systemId);
    if (!system) return;

    const fleetsInSystem = fleetIds
      .map(fleetId => engageableFleetsById.get(fleetId))
      .filter((fleet): fleet is NonNullable<typeof fleet> => Boolean(fleet))
      .filter(fleet => fleet.state !== FleetState.COMBAT && fleet.ships.length > 0);

    const presentFactionIds = new Set<string>();
    fleetsInSystem.forEach(fleet => presentFactionIds.add(fleet.factionId));

    if (presentFactionIds.size > 1) {
      const battleId = rng.id('battle');
      const involvedFleetIds = sorted([...fleetIds]);

      const battle: Battle = {
        id: battleId,
        systemId: system.id,
        turnCreated: turn,
        status: 'scheduled',
        involvedFleetIds,
        logs: [`Battle detected at ${system.name}. Factions involved: ${Array.from(presentFactionIds).join(', ')}.`]
      };

      newBattles.push(battle);
    }
  });

  return newBattles;
}

export function pruneBattles(battles: Battle[], currentTurn: number): Battle[] {
  const KEEP_HISTORY = 5;
  return battles.filter(b => {
    if (b.status !== 'resolved') return true;
    const resolutionTurn = b.turnResolved ?? b.turnCreated ?? currentTurn;
    return resolutionTurn >= currentTurn - KEEP_HISTORY;
  });
}

// ------------------------------------------
// Outcome (was: battle/outcome.ts)
// ------------------------------------------

export type FactionRegistry = Record<string, { name: string; color: string }>;

export interface BattleOutcome {
  label: string;
  color: string;
  winnerName: string | null;
  status: 'victory' | 'defeat' | 'draw' | 'unknown';
}

export type TranslateFn = (key: string, params?: Record<string, string | number | undefined>) => string;

function fallbackFactionMeta(factionId: string | undefined, registry: FactionRegistry) {
  if (!factionId) {
    return { name: 'UNKNOWN', color: '#94a3b8' };
  }

  return registry[factionId] || { name: factionId.toUpperCase(), color: '#94a3b8' };
}

export function resolveBattleOutcome(
  battle: Battle,
  playerFactionId: FactionId,
  registry: FactionRegistry,
  translate: TranslateFn
): BattleOutcome {
  if (!battle.winnerFactionId) {
    return { label: translate('battle.unknown'), color: '#cbd5e1', winnerName: null, status: 'unknown' };
  }

  if (battle.winnerFactionId === 'draw') {
    return { label: translate('battle.draw'), color: '#94a3b8', winnerName: null, status: 'draw' };
  }

  const winnerMeta = fallbackFactionMeta(battle.winnerFactionId, registry);
  const isPlayerVictory = battle.winnerFactionId === playerFactionId;

  return {
    label: translate('battle.victory', { winner: winnerMeta.name }),
    color: winnerMeta.color,
    winnerName: winnerMeta.name,
    status: isPlayerVictory ? 'victory' : 'defeat'
  };
}

// ------------------------------------------
// Resolution (was: battle/resolution.ts)
// ------------------------------------------

const SURVIVOR_ATTRITION_RATIO = 0.1;
const SURVIVOR_MIN_POST_BATTLE_DAMAGE = 15;

// --- HELPERS ---
const clampRemaining = (initial: number, remaining: number) => Math.min(Math.max(remaining, 0), initial);

const createEmptyAmmunitionTally = (): BattleAmmunitionTally => ({
  initial: 0,
  used: 0,
  remaining: 0
});

const createEmptyAmmunitionBreakdown = (): BattleAmmunitionBreakdown => ({
  offensiveMissiles: createEmptyAmmunitionTally(),
  torpedoes: createEmptyAmmunitionTally(),
  interceptors: createEmptyAmmunitionTally()
});

const createBattleShip = (ship: ShipEntity, fleetId: string, faction: FactionId): BattleShipState | null => {
  if (!ship || !(ship as any).type) {
    // eslint-disable-next-line no-console
    console.error(`[Battle] Invalid ship passed to createBattleShip: ${JSON.stringify(ship)}. Skipping.`);
    return null;
  }
  const stats = SHIP_STATS[ship.type];
  if (!stats) {
    devWarn(`[Battle] Unknown ship type '${ship.type}' for ship ${ship.id}. Using fallback stats.`);
  }

  const fallbackMaxHp = stats?.maxHp ?? 100;
  const maxHp = Number.isFinite(ship.maxHp) && ship.maxHp > 0 ? ship.maxHp : fallbackMaxHp;
  const clampedHp = Number.isFinite(ship.hp) ? Math.min(Math.max(ship.hp, 0), maxHp) : maxHp;

  const normalizeStock = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;

  const offensiveMissilesLeft = normalizeStock(
    (ship as any).consumables?.offensiveMissiles ?? (ship as any).offensiveMissilesLeft,
    stats?.offensiveMissileStock ?? 0
  );
  const torpedoesLeft = normalizeStock((ship as any).consumables?.torpedoes ?? (ship as any).torpedoesLeft, stats?.torpedoStock ?? 0);
  const interceptorsLeft = normalizeStock(
    (ship as any).consumables?.interceptors ?? (ship as any).interceptorsLeft,
    stats?.interceptorStock ?? 0
  );
  const evasion = stats?.evasion ?? 0.1;
  const pdStrength = stats?.pdStrength ?? 0;
  const damage = stats?.damage ?? 10;
  const missileDamage = stats?.missileDamage ?? 0;
  const torpedoDamage = stats?.torpedoDamage ?? 0;

  return {
    shipId: ship.id,
    fleetId,
    faction,
    type: ship.type,
    currentHp: clampedHp,
    maxHp,
    offensiveMissilesLeft,
    torpedoesLeft,
    interceptorsLeft,
    fireControlLock: 0,
    maneuverBudget: 0.5,
    targetId: null,
    evasion,
    pdStrength,
    damage,
    missileDamage,
    torpedoDamage,
    killHistory: [...(ship.killHistory ?? [])]
  };
};

export interface BattleResolutionResult {
  updatedBattle: Battle;
  survivingFleets: Fleet[];
  destroyedShipIds: string[];
  destroyedFleetIds: string[];
  destroyedArmyIds: string[];
}

// Optimization: Removed unused masterRng param. The battle creates its own isolated RNG.
export function resolveBattle(battle: Battle, state: GameState, turn: number): BattleResolutionResult {
  const logReference = `[Turn ${turn}]`;
  const formatLog = (message: string) => `${logReference} ${message}`;

  // 1. SETUP - Isolate Determinism
  let seedHash = 0;
  const seedString = `${battle.id}_${battle.turnCreated}`;
  for (let i = 0; i < seedString.length; i++) seedHash = (seedHash << 5) - seedHash + seedString.charCodeAt(i);

  const rng = new RNG(state.seed + seedHash);

  // 2. INITIALIZE BATTLE STATE
  const involvedFleets = state.fleets.filter(f => battle.involvedFleetIds.includes(f.id));

  // --- CAPTURE SNAPSHOT BEFORE SIMULATION ---
  let initialShips: BattleShipSnapshot[] = [];
  const initialAmmunitionByShip = new Map<string, ShipConsumables>();

  // Deterministic ship initialization
  let battleShips: BattleShipState[] = [];

  // We use a Map for O(1) lookups during the hot loop
  const shipMap = new Map<string, BattleShipState>();

  involvedFleets.forEach(f => {
    f.ships.forEach(s => {
      if (s && s.type) {
        // State - create battle ship first to validate
        const bs = createBattleShip(s, f.id, f.factionId as FactionId);
        if (!bs) {
          // Skip invalid ships - already logged in createBattleShip
          return;
        }
        // Snapshot (only if ship is valid)
        initialShips.push({
          shipId: s.id,
          fleetId: f.id,
          factionId: f.factionId,
          type: s.type,
          maxHp: s.maxHp,
          startingHp: s.hp
        });
        initialAmmunitionByShip.set(s.id, {
          offensiveMissiles: Math.max(0, bs.offensiveMissilesLeft),
          torpedoes: Math.max(0, bs.torpedoesLeft),
          interceptors: Math.max(0, bs.interceptorsLeft)
        });
        battleShips.push(bs);
        shipMap.set(s.id, bs);
      }
    });
  });

  // Deterministic Sort of snapshot and logic array
  initialShips = sorted(initialShips, (a, b) => a.shipId.localeCompare(b.shipId));
  battleShips = sorted(battleShips, (a, b) => a.shipId.localeCompare(b.shipId));

  // Safety guard: if no valid ships, return early with a draw
  if (battleShips.length === 0) {
    devWarn(`[Battle] No valid ships in battle ${battle.id}. Resolving as draw.`);
    return {
      updatedBattle: {
        ...battle,
        turnResolved: turn,
        status: 'resolved',
        initialShips: [],
        logs: [...battle.logs, formatLog('Battle resolved as draw - no valid combatants.')],
        winnerFactionId: 'draw',
        roundsPlayed: 0,
        shipsLost: {},
        survivorShipIds: [],
        missilesIntercepted: 0,
        projectilesDestroyedByPd: 0,
        ammunitionByFaction: {}
      },
      survivingFleets: involvedFleets, // Return fleets unchanged
      destroyedShipIds: [],
      destroyedFleetIds: [],
      destroyedArmyIds: []
    };
  }

  const projectiles: Projectile[] = [];
  const logs: string[] = [];
  const appendLog = (message: string) => logs.push(formatLog(message));
  let roundsPlayed = 0;

  // Stats
  let totalMissilesIntercepted = 0;
  let totalProjectilesDestroyedByPd = 0;
  const battleSystem = state.systems.find(system => system.id === battle.systemId);

  const recordKill = (attackerId: string | undefined, target: BattleShipState | undefined, method: string) => {
    if (!attackerId || !target) return;

    const attacker = shipMap.get(attackerId);
    if (!attacker) return;

    attacker.killHistory.push({
      id: rng.id('kill'),
      day: turn,
      turn,
      targetId: target.shipId,
      targetType: target.type,
      targetFactionId: target.faction
    });

    appendLog(`XX ${shortId(target.shipId)} destroyed by ${shortId(attacker.shipId)} [${method}].`);
  };

  // 3. ROUND LOOP
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    roundsPlayed = round;

    // Check for combat viability at start of round
    const aliveFactions = new Set(battleShips.filter(s => s.currentHp > 0).map(s => s.faction));
    if (aliveFactions.size <= 1) break;

    appendLog(`--- ROUND ${round} ---`);

    // --- PHASE 1: FLIGHT UPDATES ---
    // Update ETA for EXISTING projectiles.
    for (const p of projectiles) {
      if (p.eta > 0) p.eta--;
    }

    // Identify active participants
    const activeShips = battleShips.filter(s => s.currentHp > 0);
    const activeByFaction = new Map<FactionId, BattleShipState[]>();

    for (const ship of activeShips) {
      const list = activeByFaction.get(ship.faction);
      if (list) {
        list.push(ship);
      } else {
        activeByFaction.set(ship.faction, [ship]);
      }
    }

    const activeFactions = sorted(Array.from(activeByFaction.keys()));
    const enemiesByFaction = new Map<FactionId, BattleShipState[]>();
    const enemiesByFactionAndType = new Map<FactionId, Map<ShipType, BattleShipState[]>>();

    for (const faction of activeFactions) {
      const enemies: BattleShipState[] = [];
      const byType = new Map<ShipType, BattleShipState[]>();

      for (const otherFaction of activeFactions) {
        if (otherFaction === faction) continue;

        const hostileShips = activeByFaction.get(otherFaction) ?? [];
        for (const ship of hostileShips) {
          enemies.push(ship);

          const shipsOfType = byType.get(ship.type);
          if (shipsOfType) {
            shipsOfType.push(ship);
          } else {
            byType.set(ship.type, [ship]);
          }
        }
      }

      enemiesByFaction.set(faction, enemies);
      enemiesByFactionAndType.set(faction, byType);
    }

    // --- PHASE 2: TARGETING ---
    for (const ship of activeShips) {
      const enemies = enemiesByFaction.get(ship.faction) ?? [];
      ship.targetId = selectTarget(ship, enemies, () => rng.next(), {
        enemiesByType: enemiesByFactionAndType.get(ship.faction),
        shipLookup: shipMap,
        round
      });
    }

    // --- PHASE 3: MANEUVER ---
    for (const ship of activeShips) {
      if (ship.targetId) {
        ship.fireControlLock = Math.min(1.0, ship.fireControlLock + LOCK_GAIN_PER_ROUND);
      } else {
        ship.fireControlLock = Math.max(0, ship.fireControlLock - 0.1);
      }
    }

    // --- PHASE 4: LAUNCH ---
    for (const ship of activeShips) {
      if (!ship.targetId) continue;

      const torpedoCount = Math.min(ship.torpedoesLeft, MAX_LAUNCH_PER_ROUND);
      const remainingCapacity = Math.max(0, MAX_LAUNCH_PER_ROUND - torpedoCount);
      const missileCount = Math.min(ship.offensiveMissilesLeft, remainingCapacity);

      for (let k = 0; k < torpedoCount; k++) {
        projectiles.push({
          id: rng.id('torp'),
          type: 'torpedo',
          sourceId: ship.shipId,
          sourceFaction: ship.faction,
          targetId: ship.targetId,
          eta: ETA_TORPEDO,
          damage: ship.torpedoDamage,
          hp: TORPEDO_HP
        });
      }

      for (let k = 0; k < missileCount; k++) {
        projectiles.push({
          id: rng.id('msl'),
          type: 'missile',
          sourceId: ship.shipId,
          sourceFaction: ship.faction,
          targetId: ship.targetId,
          eta: ETA_MISSILE,
          damage: ship.missileDamage,
          hp: MISSILE_HP
        });
      }

      ship.torpedoesLeft -= torpedoCount;
      ship.offensiveMissilesLeft -= missileCount;

      if (torpedoCount > 0 || missileCount > 0) {
        const firedParts: string[] = [];
        if (torpedoCount > 0) {
          firedParts.push(`${torpedoCount} torpedoes [ETA:${ETA_TORPEDO}]`);
        }
        if (missileCount > 0) {
          firedParts.push(`${missileCount} missiles [ETA:${ETA_MISSILE}]`);
        }
        appendLog(`${shortId(ship.shipId)} (${ship.type}) fired ${firedParts.join(' and ')}.`);
      }
    }

    // --- PHASE 5: INTERCEPTION (Soft Kill) ---
    type ProjectileBuckets = { interceptable: Projectile[]; pd: Projectile[] };
    const projectileThreats = new Map<string, ProjectileBuckets>();
    const ensureBuckets = (targetId: string): ProjectileBuckets => {
      const existing = projectileThreats.get(targetId);
      if (existing) return existing;
      const buckets: ProjectileBuckets = { interceptable: [], pd: [] };
      projectileThreats.set(targetId, buckets);
      return buckets;
    };

    for (const projectile of projectiles) {
      if (projectile.hp <= 0) continue;
      if (projectile.eta === 0 || projectile.eta === 1) {
        ensureBuckets(projectile.targetId).interceptable.push(projectile);
      }
      if (projectile.eta === 0) {
        ensureBuckets(projectile.targetId).pd.push(projectile);
      }
    }

    const threatTargets = sorted(Array.from(projectileThreats.keys()));

    for (const targetId of threatTargets) {
      const defender = shipMap.get(targetId);
      if (!defender || defender.currentHp <= 0) continue;

      const incoming = projectileThreats.get(targetId)!;

      // Try to intercept each incoming missile
      for (const p of incoming.interceptable) {
        if (p.hp <= 0) continue;

        if (defender.interceptorsLeft > 0 && rng.next() > 0.5) {
          defender.interceptorsLeft--;
          if (rng.next() < INTERCEPTION_BASE_CHANCE) {
            p.hp = 0;
            appendLog(`>> ${shortId(defender.shipId)} launched an interceptor and neutralized incoming ${p.type}.`);
            totalMissilesIntercepted++;
          }
        }
      }
    }

    // Cleanup dead projectiles
    let aliveCount = 0;
    for (let i = 0; i < projectiles.length; i++) {
      if (projectiles[i].hp > 0) {
        projectiles[aliveCount++] = projectiles[i];
      }
    }
    projectiles.length = aliveCount;

    // --- PHASE 6: PD (Hard Kill) ---
    // Only affects projectiles hitting THIS round (ETA 0)
    for (const targetId of threatTargets) {
      const defender = shipMap.get(targetId);
      if (!defender || defender.currentHp <= 0) continue;

      let pdOutput = defender.pdStrength * PD_DAMAGE_PER_POINT;
      const incoming = projectileThreats.get(targetId)!.pd;
      if (incoming.length === 0) continue;

      for (const threat of incoming) {
        if (pdOutput <= 0) break;
        if (threat.hp <= 0) continue;

        const dmg = Math.min(threat.hp, pdOutput);
        threat.hp -= dmg;
        pdOutput -= dmg;

        if (threat.hp <= 0) {
          appendLog(`>> PD from ${shortId(defender.shipId)} destroyed ${threat.type}.`);
          totalProjectilesDestroyedByPd++;
        }
      }
    }

    // --- PHASE 7: IMPACTS & KINETIC ---
    // Process Missile/Torpedo Impacts
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      if (p.eta === 0) {
        // It hit this round (if alive)
        if (p.hp > 0) {
          const target = shipMap.get(p.targetId);
          if (target && target.currentHp > 0) {
            const previousHp = target.currentHp;
            target.currentHp -= p.damage;
            appendLog(`!! ${shortId(target.shipId)} hit by ${p.type} for ${p.damage} dmg.`);

            if (previousHp > 0 && target.currentHp <= 0) {
              recordKill(p.sourceId, target, p.type);
            }
          }
        }
        // Remove from simulation (Hit or Killed by PD)
        projectiles.splice(i, 1);
      }
    }

    // Kinetic Fire (Instant)
    for (const attacker of activeShips) {
      if (!attacker.targetId) continue;
      const target = shipMap.get(attacker.targetId);

      if (!target || target.currentHp <= 0) continue;

      const hitChance = BASE_ACCURACY * Math.max(0.1, attacker.fireControlLock) * (1 - target.evasion);
      if (rng.next() < hitChance) {
        const dmg = attacker.damage;
        const previousHp = target.currentHp;
        target.currentHp -= dmg;
        appendLog(`  ${shortId(attacker.shipId)} guns hit ${shortId(target.shipId)} [${dmg} dmg]`);

        if (previousHp > 0 && target.currentHp <= 0) {
          recordKill(attacker.shipId, target, 'kinetic');
        }
      }
    }
  }

  // 4. FINALIZE & APPLY RESULTS

  const survivingFleets: Fleet[] = [];
  const survivorShipIds: string[] = [];

  const aliveFactionsBeforeAttrition = new Set(battleShips.filter(s => s.currentHp > 0).map(s => s.faction));

  const computeStrengthByFaction = () => {
    const totals = new Map<FactionId, { hp: number; ships: number }>();
    battleShips.forEach(s => {
      if (s.currentHp <= 0) return;
      const entry = totals.get(s.faction);
      if (entry) {
        entry.hp += s.currentHp;
        entry.ships += 1;
      } else {
        totals.set(s.faction, { hp: s.currentHp, ships: 1 });
      }
    });
    return totals;
  };

  const resolveTiebreakerWinner = (): FactionId | 'draw' => {
    const totals = computeStrengthByFaction();
    if (totals.size === 0) return 'draw';

    let bestFaction: FactionId | null = null;
    let bestHp = -1;
    let bestShips = -1;

    totals.forEach((value, faction) => {
      if (value.hp > bestHp || (value.hp === bestHp && value.ships > bestShips)) {
        bestHp = value.hp;
        bestShips = value.ships;
        bestFaction = faction;
      }
    });

    const contenders = Array.from(totals.entries()).filter(([, val]) => val.hp === bestHp && val.ships === bestShips);

    if (contenders.length === 1 && bestFaction) {
      return bestFaction;
    }

    return 'draw';
  };

  // Winner is locked in before post-battle attrition so repairs/failures cannot flip the outcome.
  const winnerFactionId: FactionId | 'draw' =
    aliveFactionsBeforeAttrition.size === 1
      ? (Array.from(aliveFactionsBeforeAttrition)[0] as FactionId)
      : roundsPlayed >= MAX_ROUNDS
        ? resolveTiebreakerWinner()
        : 'draw';

  involvedFleets.forEach(oldFleet => {
    const newShips: ShipEntity[] = [];
    const orbitPosition = battleSystem?.position ?? oldFleet.targetPosition ?? oldFleet.position;
    oldFleet.ships.forEach(oldShip => {
      const battleState = shipMap.get(oldShip.id);
      if (battleState && battleState.currentHp > 0) {
        const consumables = {
          offensiveMissiles: battleState.offensiveMissilesLeft,
          torpedoes: battleState.torpedoesLeft,
          interceptors: battleState.interceptorsLeft
        };
        newShips.push({
          ...oldShip,
          hp: battleState.currentHp,
          consumables,
          offensiveMissilesLeft: battleState.offensiveMissilesLeft,
          torpedoesLeft: battleState.torpedoesLeft,
          interceptorsLeft: battleState.interceptorsLeft,
          killHistory: battleState.killHistory
        });
        survivorShipIds.push(oldShip.id);
      }
    });

    if (newShips.length > 0) {
      // Update fleet with new ships AND new derived stats (radius)
      const updatedFleet = withUpdatedFleetDerived({
        ...oldFleet,
        ships: newShips,
        position: { ...orbitPosition },
        state: FleetState.ORBIT,
        stateStartTurn: turn
      });
      survivingFleets.push(updatedFleet);
    }
  });

  // Apply post-battle attrition so survivors need repairs before returning to duty
  const attritionLogs: string[] = [];
  const adjustedSurvivorIds: string[] = [];
  const attritionAdjustedFleets: Fleet[] = [];

  survivingFleets.forEach(fleet => {
    const penalizedShips: ShipEntity[] = [];

    fleet.ships.forEach(ship => {
      const attritionDamage = Math.max(Math.floor(ship.maxHp * SURVIVOR_ATTRITION_RATIO), SURVIVOR_MIN_POST_BATTLE_DAMAGE);
      const remainingHp = Math.max(0, ship.hp - attritionDamage);
      const battleState = shipMap.get(ship.id);

      if (battleState) {
        battleState.currentHp = remainingHp;
      }

      if (remainingHp > 0) {
        penalizedShips.push({ ...ship, hp: remainingHp });
        adjustedSurvivorIds.push(ship.id);
        attritionLogs.push(formatLog(`-- ${shortId(ship.id)} is undergoing repairs (-${attritionDamage} hp).`));
      } else {
        attritionLogs.push(formatLog(`xx ${shortId(ship.id)} was lost to post-battle failures.`));
      }
    });

    if (penalizedShips.length > 0) {
      attritionAdjustedFleets.push(withUpdatedFleetDerived({ ...fleet, ships: penalizedShips, stateStartTurn: turn }));
    }
  });

  survivorShipIds.length = 0;
  survivorShipIds.push(...adjustedSurvivorIds);

  survivingFleets.length = 0;
  survivingFleets.push(...attritionAdjustedFleets);

  logs.push(...attritionLogs);

  appendLog(`BATTLE ENDED. Winner: ${winnerFactionId.toUpperCase()}`);

  const destroyedShipIds = battleShips.filter(s => s.currentHp <= 0).map(s => s.shipId);
  const survivingFleetIds = new Set(survivingFleets.map(fleet => fleet.id));
  const destroyedFleetIds = battle.involvedFleetIds.filter(fleetId => !survivingFleetIds.has(fleetId));

  const carrierArmyByShipId = new Map<string, string>();
  involvedFleets.forEach(fleet => {
    fleet.ships.forEach(ship => {
      if (ship.carriedArmyId) {
        carrierArmyByShipId.set(ship.id, ship.carriedArmyId);
      }
    });
  });

  const destroyedArmyIds = new Set<string>();
  carrierArmyByShipId.forEach((armyId, shipId) => {
    const battleShip = shipMap.get(shipId);
    if (!battleShip || battleShip.currentHp <= 0) {
      destroyedArmyIds.add(armyId);
    }
  });

  state.armies.forEach(army => {
    if (army.state === 'EMBARKED' && destroyedFleetIds.includes(army.containerId)) {
      destroyedArmyIds.add(army.id);
    }
  });

  const shipsLost: Record<FactionId, number> = {};
  battleShips.forEach(s => {
    if (s.currentHp <= 0) {
      shipsLost[s.faction] = (shipsLost[s.faction] ?? 0) + 1;
    } else {
      shipsLost[s.faction] = shipsLost[s.faction] ?? 0;
    }
  });

  const updatedBattle: Battle = {
    ...battle,
    turnResolved: turn,
    status: 'resolved',
    initialShips: initialShips,
    logs: [...battle.logs, ...logs],
    // Preserve the computed winner, even for non-player factions
    winnerFactionId,
    roundsPlayed,
    shipsLost,
    survivorShipIds,
    missilesIntercepted: totalMissilesIntercepted,
    projectilesDestroyedByPd: totalProjectilesDestroyedByPd,
    ammunitionByFaction: (() => {
      const breakdown: BattleAmmunitionByFaction = {};

      const ensureFaction = (faction: FactionId) => {
        if (!breakdown[faction]) {
          breakdown[faction] = createEmptyAmmunitionBreakdown();
        }
        return breakdown[faction];
      };

      const recordForFaction = (
        faction: FactionId,
        key: keyof BattleAmmunitionBreakdown,
        initial: number,
        remaining: number
      ) => {
        const factionBreakdown = ensureFaction(faction);
        const tally = factionBreakdown[key];
        const clampedRemaining = clampRemaining(initial, remaining);
        tally.initial += initial;
        tally.remaining += clampedRemaining;
        tally.used += initial - clampedRemaining;
      };

      battleShips.forEach(ship => {
        const initialStock = initialAmmunitionByShip.get(ship.shipId);
        if (!initialStock) return;

        const isOperational = ship.currentHp > 0;

        recordForFaction(ship.faction, 'offensiveMissiles', initialStock.offensiveMissiles, isOperational ? ship.offensiveMissilesLeft : 0);
        recordForFaction(ship.faction, 'torpedoes', initialStock.torpedoes, isOperational ? ship.torpedoesLeft : 0);
        recordForFaction(ship.faction, 'interceptors', initialStock.interceptors, isOperational ? ship.interceptorsLeft : 0);
      });

      return breakdown;
    })()
  };

  return {
    updatedBattle,
    survivingFleets,
    destroyedShipIds,
    destroyedFleetIds,
    destroyedArmyIds: Array.from(destroyedArmyIds)
  };
}

