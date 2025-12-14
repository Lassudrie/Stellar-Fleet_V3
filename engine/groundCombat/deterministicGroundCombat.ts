import {
  Army,
  ArmyState,
  FactionId,
  Fleet,
  GameState,
  ShipEntity,
  ShipType,
  StarSystem,
} from '../../types';
import { CAPTURE_RANGE } from '../../data/static';
import { GroundCombatConfig } from '../../data/groundCombat';
import { distSq } from '../math/vec3';

export type GroundCombatWinner = FactionId | 'draw';

export interface GroundCombatArmyUpdate {
  id: string;
  changes: Partial<Army>;
}

export interface GroundCombatFleetUpdate {
  id: string;
  changes: Partial<Fleet>;
}

export interface DeterministicGroundCombatResult {
  systemId: string;
  winnerFactionId: GroundCombatWinner | null;
  conquestOccurred: boolean;
  nextOwnerFactionId?: FactionId | null;
  roundsPlayed: number;
  logs: string[];

  armiesDestroyed: string[];
  armyUpdates: GroundCombatArmyUpdate[];
  fleetUpdates: GroundCombatFleetUpdate[];
}

type ArmyView = {
  id: string;
  factionId: FactionId;

  // "strength points" scaled by config.strengthUnit
  strength: number;
  maxStrength: number;

  // base stats (points, persisted)
  baseAttack: number;
  baseDefense: number;

  // effective stats (points, used for combat)
  attack: number;
  defense: number;

  morale: number; // 0..100

  xp: number;
  level: number;

  moraleLossMult: number; // <=1, >= cfg.experience.moraleLossMultiplierMin

  // bookkeeping
  initStrength: number;
  damageTakenThisRound: number;
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const safeFinite = (v: any, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const strengthUnitPoints = (soldiers: number, strengthUnit: number): number => {
  const s = Math.max(0, safeFinite(soldiers, 0));
  return s / strengthUnit;
};

const toSoldiers = (points: number, strengthUnit: number): number => {
  const p = Math.max(0, points);
  const raw = Math.floor(p * strengthUnit);
  if (p > 0 && raw <= 0) return 1;
  return raw;
};

const minStrengthPoints = (cfg: GroundCombatConfig): number => 1 / Math.max(1, cfg.strengthUnit);

const normalizeCombatStat = (raw: number, strengthUnit: number, fallbackPoints: number): number => {
  const r = safeFinite(raw, 0);
  if (r <= 0) return fallbackPoints;

  // Heuristic: stats > 1000 are likely in "soldiers" scale. Convert to points.
  if (r > 1000) return r / strengthUnit;

  return r;
};

const levelFromXp = (xp: number, cfg: GroundCombatConfig): number => {
  const safeXp = Math.max(0, safeFinite(xp, 0));
  const per = Math.max(1, cfg.experience.xpPerLevel);
  const lvl = Math.floor(safeXp / per) + 1;
  return clamp(lvl, 1, Math.max(1, cfg.experience.maxLevel));
};

const applyLevelToStat = (base: number, perLevelBonus: number, level: number): number => {
  const l = Math.max(1, Math.floor(level));
  return base * (1 + Math.max(0, perLevelBonus) * (l - 1));
};

const factionName = (state: GameState, id: FactionId): string =>
  state.factions.find(f => f.id === id)?.name ?? id;

const computeSideStats = (armies: ArmyView[], cfg: GroundCombatConfig) => {
  const strength = armies.reduce((sum, a) => sum + Math.max(0, a.strength), 0);
  const maxStrength = armies.reduce((sum, a) => sum + Math.max(0, a.maxStrength), 0);
  const attack = armies.reduce((sum, a) => sum + Math.max(0, a.attack), 0);
  const defense = armies.reduce((sum, a) => sum + Math.max(0, a.defense), 0);

  const morale = strength > 0
    ? armies.reduce((sum, a) => sum + clamp(a.morale, 0, 100) * Math.max(0, a.strength), 0) / strength
    : 0;

  const efficiency = clamp(morale / 100, clamp(cfg.efficiencyMin, 0.01, 1), 1);

  return { strength, maxStrength, attack, defense, morale, efficiency };
};

const applyDamageProportional = (armies: ArmyView[], damagePoints: number) => {
  let remaining = Math.max(0, damagePoints);
  if (remaining <= 0) return;

  // Iterate, redistributing leftover if some stacks hit 0.
  for (let pass = 0; pass < armies.length && remaining > 1e-9; pass++) {
    const eligible = armies.filter(a => a.strength > 0);
    if (eligible.length === 0) break;

    const total = eligible.reduce((sum, a) => sum + a.strength, 0);
    if (total <= 0) break;

    let allocatedThisPass = 0;

    for (const a of eligible) {
      const share = a.strength / total;
      let alloc = remaining * share;
      if (alloc > a.strength) alloc = a.strength;

      if (alloc > 0) {
        a.strength = Math.max(0, a.strength - alloc);
        a.damageTakenThisRound += alloc;
        allocatedThisPass += alloc;
      }
    }

    remaining = Math.max(0, remaining - allocatedThisPass);

    // Nothing allocated (numerical lock) => stop.
    if (allocatedThisPass <= 1e-12) break;
  }
};

const applyMoraleLoss = (armies: ArmyView[], cfg: GroundCombatConfig) => {
  for (const a of armies) {
    const frac = a.maxStrength > 0 ? (a.damageTakenThisRound / a.maxStrength) : 0;
    const rawLoss = cfg.moraleLossBase + frac * cfg.moraleLossPerDamageFraction;
    const loss = Math.max(0, rawLoss) * clamp(a.moraleLossMult, 0.1, 1);

    a.morale = clamp(a.morale - loss, 0, 100);
    a.damageTakenThisRound = 0;
  }
};

const computeBombardmentScore = (fleets: Fleet[]): number => {
  // Simple, deterministic weights. (Data-driven extension can later move this to config.)
  const weight: Record<string, number> = {
    [ShipType.FIGHTER]: 0.2,
    [ShipType.BOMBER]: 1.8,
    [ShipType.FRIGATE]: 0.6,
    [ShipType.DESTROYER]: 0.9,
    [ShipType.CRUISER]: 1.2,
    [ShipType.CARRIER]: 1.4,
    [ShipType.TROOP_TRANSPORT]: 0.1,
  };

  let score = 0;
  for (const f of fleets) {
    for (const s of f.ships) {
      score += weight[s.type] ?? 0;
    }
  }
  return score;
};

const isOrbitContested = (system: StarSystem, state: GameState): boolean => {
  const r2 = CAPTURE_RANGE * CAPTURE_RANGE;
  const inOrbit = state.fleets.filter(f => distSq(f.position, system.position) <= r2);
  const factions = new Set(inOrbit.map(f => f.factionId));
  return factions.size >= 2;
};

const buildArmyView = (army: Army, cfg: GroundCombatConfig): ArmyView => {
  const strengthSoldiers = Math.max(0, safeFinite(army.strength, 0));
  const maxStrengthSoldiers = Math.max(
    strengthSoldiers,
    safeFinite((army as any).maxStrength, strengthSoldiers)
  );

  const strength = strengthUnitPoints(strengthSoldiers, cfg.strengthUnit);
  const maxStrength = Math.max(minStrengthPoints(cfg), strengthUnitPoints(maxStrengthSoldiers, cfg.strengthUnit));

  const xp = Math.max(0, safeFinite((army as any).experience, 0));
  const level = Math.max(1, safeFinite((army as any).level, levelFromXp(xp, cfg)));

  const baseAttackFallback = maxStrength; // default scales with size
  const baseDefenseFallback = maxStrength;

  const baseAttack = normalizeCombatStat(safeFinite((army as any).groundAttack, 0), cfg.strengthUnit, baseAttackFallback);
  const baseDefense = normalizeCombatStat(safeFinite((army as any).groundDefense, 0), cfg.strengthUnit, baseDefenseFallback);

  const attack = applyLevelToStat(baseAttack, cfg.experience.attackBonusPerLevel, level);
  const defense = applyLevelToStat(baseDefense, cfg.experience.defenseBonusPerLevel, level);

  const morale = clamp(safeFinite((army as any).morale, 100), 0, 100);

  const moraleLossMult = clamp(
    1 - Math.max(0, cfg.experience.moraleLossResistancePerLevel) * (level - 1),
    clamp(cfg.experience.moraleLossMultiplierMin, 0.1, 1),
    1
  );

  return {
    id: army.id,
    factionId: army.factionId,
    strength,
    maxStrength,
    baseAttack,
    baseDefense,
    attack,
    defense,
    morale,
    xp,
    level,
    moraleLossMult,
    initStrength: strength,
    damageTakenThisRound: 0,
  };
};

const getAvailableTransportShips = (system: StarSystem, state: GameState, factionId: FactionId): Array<{ fleet: Fleet; ship: ShipEntity }> => {
  const r2 = CAPTURE_RANGE * CAPTURE_RANGE;

  const fleets = state.fleets
    .filter(f => f.factionId === factionId)
    .filter(f => distSq(f.position, system.position) <= r2)
    .sort((a, b) => a.id.localeCompare(b.id));

  const transports: Array<{ fleet: Fleet; ship: ShipEntity }> = [];

  for (const f of fleets) {
    const ships = [...f.ships].sort((a, b) => a.id.localeCompare(b.id));
    for (const s of ships) {
      if (s.type !== ShipType.TROOP_TRANSPORT) continue;
      if (s.carriedArmyId) continue;
      transports.push({ fleet: f, ship: s });
    }
  }

  return transports;
};

export const resolveDeterministicGroundCombat = (
  system: StarSystem,
  state: GameState,
  cfg: GroundCombatConfig
): DeterministicGroundCombatResult | null => {
  // Feature gate: if config or rules disable later, integration controls it; solver assumes it is called intentionally.
  const deployed = state.armies.filter(a => a.state === ArmyState.DEPLOYED && a.containerId === system.id);
  if (deployed.length === 0) return null;

  // Group by faction
  const factionsOnGround = new Map<FactionId, ArmyView[]>();
  const originalArmyById = new Map<string, Army>();

  for (const a of deployed) {
    originalArmyById.set(a.id, a);
    const v = buildArmyView(a, cfg);
    const list = factionsOnGround.get(a.factionId) || [];
    list.push(v);
    factionsOnGround.set(a.factionId, list);
  }

  if (factionsOnGround.size === 0) return null;

  const sortedFactions = [...factionsOnGround.keys()].sort((a, b) => a.localeCompare(b));
  if (sortedFactions.length === 1) {
    const onlyFaction = sortedFactions[0];
    if (system.ownerFactionId === onlyFaction) return null;

    const logs: string[] = [];
    if (isOrbitContested(system, state)) {
      logs.push(
        `Ground presence established on ${system.name}, but orbit is contested; no control can be claimed yet.`
      );
      return {
        systemId: system.id,
        winnerFactionId: 'draw',
        conquestOccurred: false,
        nextOwnerFactionId: system.ownerFactionId,
        roundsPlayed: 0,
        logs,
        armiesDestroyed: [],
        armyUpdates: [],
        fleetUpdates: [],
      };
    }

    logs.push(`Unopposed ground takeover on ${system.name} by ${factionName(state, onlyFaction)}.`);
    return {
      systemId: system.id,
      winnerFactionId: onlyFaction,
      conquestOccurred: true,
      nextOwnerFactionId: onlyFaction,
      roundsPlayed: 0,
      logs,
      armiesDestroyed: [],
      armyUpdates: [],
      fleetUpdates: [],
    };
  }

  // Pick defender: owner if present, else highest total power.
  const factionPower = (id: FactionId): number => {
    const armies = factionsOnGround.get(id) || [];
    return armies.reduce((sum, a) => sum + (a.attack + a.defense) * a.strength, 0);
  };

  const factionsByPower = [...factionsOnGround.keys()].sort((a, b) => {
    const d = factionPower(b) - factionPower(a);
    if (d !== 0) return d;
    return a.localeCompare(b);
  });

  const defenderFactionId =
    system.ownerFactionId && factionsOnGround.has(system.ownerFactionId)
      ? system.ownerFactionId
      : factionsByPower[0];

  const attackerFactionId = factionsByPower.find(f => f !== defenderFactionId) || factionsByPower[1];

  const attackerArmies = (factionsOnGround.get(attackerFactionId) || []).sort((a, b) => a.id.localeCompare(b.id));
  const defenderArmies = (factionsOnGround.get(defenderFactionId) || []).sort((a, b) => a.id.localeCompare(b.id));

  if (attackerArmies.length === 0 || defenderArmies.length === 0) return null;

  const logs: string[] = [];
  logs.push(
    `Ground battle on ${system.name}: ${factionName(state, attackerFactionId)} vs ${factionName(state, defenderFactionId)}.`
  );

  // Bombardment phase (pre-round)
  if (cfg.bombardment.enabled) {
    const r2 = CAPTURE_RANGE * CAPTURE_RANGE;
    const bombardFleets = state.fleets
      .filter(f => f.factionId === attackerFactionId)
      .filter(f => distSq(f.position, system.position) <= r2);

    const score = computeBombardmentScore(bombardFleets);
    if (score > 0) {
      const sLoss = clamp(
        cfg.bombardment.strengthLossMin + score * cfg.bombardment.strengthLossPerBombardScore,
        cfg.bombardment.strengthLossMin,
        cfg.bombardment.strengthLossMax
      );

      const mLoss = clamp(
        cfg.bombardment.moraleLossMin + score * cfg.bombardment.moraleLossPerBombardScore,
        cfg.bombardment.moraleLossMin,
        cfg.bombardment.moraleLossMax
      );

      for (const d of defenderArmies) {
        d.strength = Math.max(minStrengthPoints(cfg), d.strength * (1 - sLoss));
        d.morale = Math.max(0, d.morale - mLoss);
        d.initStrength = d.strength;
      }

      logs.push(
        `Orbital bombardment: defenders suffer ${(sLoss * 100).toFixed(0)}% strength loss and -${Math.round(mLoss)} morale before combat.`
      );
    }
  }

  // Bookkeeping: initial strengths after bombardment
  for (const a of attackerArmies) a.initStrength = a.strength;

  const attackerStartStrength = attackerArmies.reduce((sum, a) => sum + a.strength, 0);
  const defenderStartStrength = defenderArmies.reduce((sum, a) => sum + a.strength, 0);

  // Rounds
  const epsilon = 1e-6;
  const attritionFactor = Math.max(0.3, cfg.attritionFactor);

  let roundsPlayed = 0;
  let winner: GroundCombatWinner = 'draw';

  for (let round = 1; round <= Math.max(1, cfg.maxRounds); round++) {
    roundsPlayed = round;

    const atk = computeSideStats(attackerArmies, cfg);
    const def = computeSideStats(defenderArmies, cfg);

    if (atk.strength <= 0 || def.strength <= 0) break;

    // Damage formulas (deterministic)
    const damageToDefender = Math.min(
      def.strength,
      Math.max(
        def.strength > 0 ? cfg.minDamagePerRoundPoints : 0,
        (atk.attack * (atk.strength / Math.max(epsilon, atk.maxStrength)) * atk.efficiency) / Math.max(epsilon, def.defense)
      )
    );

    const damageToAttacker = Math.min(
      atk.strength,
      Math.max(
        atk.strength > 0 ? cfg.minDamagePerRoundPoints : 0,
        (def.defense * (def.strength / Math.max(epsilon, def.maxStrength)) * def.efficiency) / Math.max(epsilon, atk.attack) * attritionFactor
      )
    );

    applyDamageProportional(defenderArmies, damageToDefender);
    applyDamageProportional(attackerArmies, damageToAttacker);

    applyMoraleLoss(defenderArmies, cfg);
    applyMoraleLoss(attackerArmies, cfg);

    // End checks
    const atk2 = computeSideStats(attackerArmies, cfg);
    const def2 = computeSideStats(defenderArmies, cfg);

    const attackerCollapsed = atk2.morale <= cfg.moraleCollapseThreshold;
    const defenderCollapsed = def2.morale <= cfg.moraleCollapseThreshold;

    if (atk2.strength <= 0 || def2.strength <= 0) break;
    if (attackerCollapsed || defenderCollapsed) break;
  }

  // Outcome
  const atkEnd = computeSideStats(attackerArmies, cfg);
  const defEnd = computeSideStats(defenderArmies, cfg);

  const attackerCollapsed = atkEnd.morale <= cfg.moraleCollapseThreshold;
  const defenderCollapsed = defEnd.morale <= cfg.moraleCollapseThreshold;

  if (atkEnd.strength <= 0 && defEnd.strength <= 0) {
    winner = 'draw';
  } else if (atkEnd.strength <= 0) {
    winner = defenderFactionId;
  } else if (defEnd.strength <= 0) {
    winner = attackerFactionId;
  } else if (attackerCollapsed && defenderCollapsed) {
    winner = 'draw';
  } else if (attackerCollapsed) {
    winner = defenderFactionId;
  } else if (defenderCollapsed) {
    winner = attackerFactionId;
  } else {
    winner = 'draw';
  }

  const endedByMorale = winner !== 'draw' && (attackerCollapsed || defenderCollapsed);

  // Restore winner morale slightly
  if (winner !== 'draw') {
    const winId = winner as FactionId;
    const winners = winId === attackerFactionId ? attackerArmies : defenderArmies;
    for (const a of winners) {
      a.morale = Math.max(a.morale, cfg.moraleRestoreMinOnVictory);
    }
  }

  // Retreat/capture for losing side if morale collapse
  const armiesDestroyed = new Set<string>();
  const armyUpdates: GroundCombatArmyUpdate[] = [];
  const fleetUpdates: GroundCombatFleetUpdate[] = [];

  const fleetClones = new Map<string, Fleet>();
  const ensureFleetClone = (fleet: Fleet): Fleet => {
    const existing = fleetClones.get(fleet.id);
    if (existing) return existing;
    const clone: Fleet = { ...fleet, ships: fleet.ships.map(s => ({ ...s })) };
    fleetClones.set(fleet.id, clone);
    return clone;
  };

  if (endedByMorale && winner !== 'draw') {
    const loserFactionId = (winner as FactionId) === attackerFactionId ? defenderFactionId : attackerFactionId;
    const losingArmies = loserFactionId === attackerFactionId ? attackerArmies : defenderArmies;

    const losingSurvivors = losingArmies
      .filter(a => a.strength > 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    const availableTransports = getAvailableTransportShips(system, state, loserFactionId);

    for (let i = 0; i < losingSurvivors.length; i++) {
      const army = losingSurvivors[i];
      const transport = availableTransports[i];

      if (!transport) {
        armiesDestroyed.add(army.id);
        // No evacuation capacity: treat the army as destroyed/captured for all post-battle maths.
        army.strength = 0;
        army.morale = 0;
        continue;
      }

      const nextFleet = ensureFleetClone(transport.fleet);
      const ship = nextFleet.ships.find(s => s.id === transport.ship.id);
      if (!ship || ship.carriedArmyId) {
        armiesDestroyed.add(army.id);
        army.strength = 0;
        army.morale = 0;
        continue;
      }

      ship.carriedArmyId = army.id;

      armyUpdates.push({
        id: army.id,
        changes: {
          state: ArmyState.EMBARKED,
          containerId: nextFleet.id,
          embarkedFleetId: nextFleet.id,
        },
      });
    }
  }

  // Mark annihilated armies destroyed
  for (const a of attackerArmies) if (a.strength <= 0) armiesDestroyed.add(a.id);
  for (const a of defenderArmies) if (a.strength <= 0) armiesDestroyed.add(a.id);

  // XP gains (survivors only)
  const applyXp = (sideArmies: ArmyView[], sideInitStrength: number, enemyArmies: ArmyView[], won: boolean) => {
    const enemyMax = enemyArmies.reduce((sum, a) => sum + a.maxStrength, 0);
    const enemyLost = enemyArmies.reduce((sum, a) => sum + Math.max(0, a.initStrength - a.strength), 0);
    const lostFraction = enemyMax > 0 ? clamp(enemyLost / enemyMax, 0, 1) : 0;

    const base = cfg.experience.baseXP + lostFraction * cfg.experience.scalingFactor;
    const total = Math.max(0, base);

    const multiplier = won ? cfg.experience.victoryMultiplier : 1;

    for (const a of sideArmies) {
      if (armiesDestroyed.has(a.id)) continue;

      const share = sideInitStrength > 0 ? (a.initStrength / sideInitStrength) : (1 / Math.max(1, sideArmies.length));
      const gain = total * share * multiplier;

      a.xp = Math.max(0, a.xp + gain);
      a.level = levelFromXp(a.xp, cfg);

      // Recompute effective stats for future battles (not required for this fight)
      a.attack = applyLevelToStat(a.baseAttack, cfg.experience.attackBonusPerLevel, a.level);
      a.defense = applyLevelToStat(a.baseDefense, cfg.experience.defenseBonusPerLevel, a.level);
      a.moraleLossMult = clamp(
        1 - Math.max(0, cfg.experience.moraleLossResistancePerLevel) * (a.level - 1),
        clamp(cfg.experience.moraleLossMultiplierMin, 0.1, 1),
        1
      );
    }
  };

  const attackerWon = winner === attackerFactionId;
  const defenderWon = winner === defenderFactionId;

  applyXp(attackerArmies, attackerStartStrength, defenderArmies, attackerWon);
  applyXp(defenderArmies, defenderStartStrength, attackerArmies, defenderWon);

  // Push per-fleet updates
  for (const [id, f] of fleetClones.entries()) {
    fleetUpdates.push({ id, changes: { ships: f.ships } });
  }

  // Push per-army updates (strength/morale/xp/level + ensure base stats persisted at least once)
  const pushArmyUpdate = (a: ArmyView) => {
    if (armiesDestroyed.has(a.id)) return;

    const original = originalArmyById.get(a.id);
    if (!original) return;

    const strengthSoldiers = toSoldiers(a.strength, cfg.strengthUnit);
    const originalMax = safeFinite((original as any).maxStrength, original.strength);
    const nextMax = Math.max(originalMax, original.strength, strengthSoldiers, 1);

    armyUpdates.push({
      id: a.id,
      changes: {
        strength: strengthSoldiers,
        morale: clamp(a.morale, 0, 100),
        experience: a.xp,
        level: a.level,

        maxStrength: nextMax,
        groundAttack: normalizeCombatStat(safeFinite((original as any).groundAttack, a.baseAttack), cfg.strengthUnit, a.baseAttack),
        groundDefense: normalizeCombatStat(safeFinite((original as any).groundDefense, a.baseDefense), cfg.strengthUnit, a.baseDefense),
      },
    });
  };

  for (const a of attackerArmies) pushArmyUpdate(a);
  for (const a of defenderArmies) pushArmyUpdate(a);

  const attackerLostSoldiers = toSoldiers(attackerStartStrength - attackerArmies.reduce((sum, a) => sum + a.strength, 0), cfg.strengthUnit);
  const defenderLostSoldiers = toSoldiers(defenderStartStrength - defenderArmies.reduce((sum, a) => sum + a.strength, 0), cfg.strengthUnit);

  if (winner === 'draw') {
    logs.push(`Battle ends in a stalemate after ${roundsPlayed} rounds.`);
  } else {
    logs.push(
      `Winner: ${factionName(state, winner as FactionId)} after ${roundsPlayed} rounds. Losses: attacker ${attackerLostSoldiers}, defender ${defenderLostSoldiers}.`
    );
  }

  // Conquest rule
  let conquestOccurred = false;
  let nextOwnerFactionId: FactionId | null | undefined = system.ownerFactionId;

  if (winner !== 'draw') {
    const win = winner as FactionId;

    // Must have ground presence remaining
    const winnerArmiesRemaining = (win === attackerFactionId ? attackerArmies : defenderArmies)
      .some(a => a.strength > 0 && !armiesDestroyed.has(a.id));

    if (winnerArmiesRemaining && system.ownerFactionId !== win) {
      if (isOrbitContested(system, state)) {
        logs.push(`Orbit is contested; control of ${system.name} cannot be claimed yet.`);
        conquestOccurred = false;
      } else {
        conquestOccurred = true;
        nextOwnerFactionId = win;
      }
    }
  }

  return {
    systemId: system.id,
    winnerFactionId: winner,
    conquestOccurred,
    nextOwnerFactionId,
    roundsPlayed,
    logs,
    armiesDestroyed: [...armiesDestroyed],
    armyUpdates,
    fleetUpdates,
  };
};
