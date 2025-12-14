import { Battle, GameState, LogEntry, ShipType, StarSystem } from '../../types';

/**
 * TURN REPORT (SITREP) — V1
 *
 * This module generates end-of-turn structured reports as LogEntry payloads.
 *
 * Why logs?
 * - No SaveFormat / serialization changes required.
 * - Reports are naturally persisted with existing save files.
 * - UI can parse & render them into a dedicated "Turn Report" screen.
 *
 * Important constraints:
 * - Must NOT consume RNG (do not call rng.id()) to preserve determinism.
 * - Must NOT leak hidden information: report is player-centric.
 * - Must be optional & disable-able.
 */

export const TURN_REPORT_JSON_PREFIX = '[TURN_REPORT_JSON]';
export const TURN_REPORT_SUMMARY_PREFIX = '[TURN_REPORT]';
export const TURN_REPORT_ENABLED_STORAGE_KEY = 'sf_turnReportsEnabled';
export const TURN_REPORT_MAX_KEEP_DEFAULT = 200;

export type TurnReportSchemaVersion = 1;

export type TurnReportShipDeltaV1 = { created: number; destroyed: number };
export type TurnReportShipDeltaByTypeV1 = Record<string, TurnReportShipDeltaV1>;

export type TurnReportSystemChangeKindV1 = 'CAPTURED' | 'LOST';
export interface TurnReportSystemChangeV1 {
  systemId: string;
  systemName: string;
  fromOwnerFactionId: string | null;
  toOwnerFactionId: string | null;
  kind: TurnReportSystemChangeKindV1;
}

export interface TurnReportBattleV1 {
  battleId: string;
  systemId: string;
  systemName: string;
  winnerFactionId: string | 'draw' | null;
  roundsPlayed: number | null;

  playerFleetIds: string[];
  enemyFleetIds: string[];

  playerShipsLostByType: Record<string, number>;
  enemyShipsLostByType: Record<string, number>;

  missilesIntercepted: number;
  projectilesDestroyedByPd: number;
}

export interface TurnReportSummaryV1 {
  battles: number;
  battlesWon: number;
  battlesLost: number;

  systemsCaptured: number;
  systemsLost: number;

  shipsCreated: number;
  shipsDestroyed: number;

  fleetsCreated: number;
  fleetsDestroyed: number;

  xpDeltaTotal: number;
}

export interface TurnReportLogPayloadV1 {
  v: TurnReportSchemaVersion;
  turn: number;

  playerFactionId: string;

  summary: TurnReportSummaryV1;

  systems: TurnReportSystemChangeV1[];
  battles: TurnReportBattleV1[];

  deltas: {
    shipByType: TurnReportShipDeltaByTypeV1;
    fleetCreated: string[];
    fleetDestroyed: string[];
  };

  xp: {
    fleetXpDelta: Record<string, number>;
  };
}

const safeGetLocalStorageItem = (key: string): string | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

export const isTurnReportEnabled = (defaultValue = true): boolean => {
  const raw = safeGetLocalStorageItem(TURN_REPORT_ENABLED_STORAGE_KEY);
  if (raw === null) return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') return true;

  return defaultValue;
};

const findSystem = (systems: StarSystem[], systemId: string): StarSystem | undefined =>
  systems.find(s => s.id === systemId);

const emptyShipDelta = (): TurnReportShipDeltaV1 => ({ created: 0, destroyed: 0 });

const bump = (rec: Record<string, number>, key: string, delta = 1) => {
  rec[key] = (rec[key] ?? 0) + delta;
};

const sumRecord = (rec: Record<string, number>) =>
  Object.values(rec).reduce((acc, v) => acc + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);

const buildShipTypeDeltaTemplate = (): TurnReportShipDeltaByTypeV1 => {
  const out: TurnReportShipDeltaByTypeV1 = {};
  // Pre-seed known ship types for stable UI ordering; still allow arbitrary keys.
  for (const t of Object.values(ShipType)) {
    out[t] = emptyShipDelta();
  }
  return out;
};

const computePlayerFleetIds = (state: GameState, playerFactionId: string): Set<string> => {
  const ids = new Set<string>();
  for (const f of state.fleets) {
    if (f.factionId === playerFactionId) ids.add(f.id);
  }
  return ids;
};

const computePlayerShipTypeById = (state: GameState, playerFactionId: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const f of state.fleets) {
    if (f.factionId !== playerFactionId) continue;
    for (const ship of f.ships) {
      map.set(ship.id, ship.type);
    }
  }
  return map;
};

const computeFleetFactionById = (prev: GameState, next: GameState): Map<string, string> => {
  const m = new Map<string, string>();
  for (const f of prev.fleets) m.set(f.id, f.factionId);
  for (const f of next.fleets) m.set(f.id, f.factionId);
  return m;
};

const isBattleResolvedOnTurn = (b: Battle, turn: number): boolean => b.status === 'resolved' && b.turnResolved === turn;

const computeBattleLossesByType = (battle: Battle, playerFactionId: string) => {
  const playerLossByType: Record<string, number> = {};
  const enemyLossByType: Record<string, number> = {};

  // Best effort: use initialShips + survivorShipIds when available (gives type breakdown).
  if (battle.initialShips && battle.survivorShipIds) {
    const survivor = new Set(battle.survivorShipIds);
    for (const s of battle.initialShips) {
      if (survivor.has(s.shipId)) continue;
      if (s.factionId === playerFactionId) bump(playerLossByType, s.type);
      else bump(enemyLossByType, s.type);
    }
    return { playerLossByType, enemyLossByType };
  }

  // Fallback: no type breakdown.
  const shipsLost = battle.shipsLost ?? {};
  const playerLost = shipsLost[playerFactionId] ?? 0;
  if (playerLost > 0) bump(playerLossByType, 'unknown', playerLost);

  const enemyLost = Object.entries(shipsLost)
    .filter(([fid]) => fid !== playerFactionId)
    .reduce((acc, [, v]) => acc + (typeof v === 'number' ? v : 0), 0);
  if (enemyLost > 0) bump(enemyLossByType, 'unknown', enemyLost);

  return { playerLossByType, enemyLossByType };
};

const computeMotivationXp = (
  winnerFactionId: string | 'draw' | null,
  playerShipsLost: number,
  playerFleetCount: number
): number => {
  // This XP is purely for the report/UI "reward loop" — it does not affect combat.
  // Tuned to be small and positive most of the time.
  const base = 2;
  const outcomeBonus = winnerFactionId === null ? 1 : winnerFactionId === 'draw' ? 2 : 4; // victory feels good
  const lossPenalty = Math.min(3, Math.floor(playerShipsLost / Math.max(1, playerFleetCount)));
  return Math.max(0, base + outcomeBonus - lossPenalty);
};

export const computeTurnReportPayloadV1 = (prev: GameState, next: GameState): TurnReportLogPayloadV1 => {
  const turn = prev.day;
  const playerFactionId = prev.playerFactionId;

  // Systems captured/lost (player-involved only)
  const prevSysById = new Map(prev.systems.map(s => [s.id, s] as const));
  const systems: TurnReportSystemChangeV1[] = [];
  for (const sNext of next.systems) {
    const sPrev = prevSysById.get(sNext.id);
    if (!sPrev) continue;
    if (sPrev.ownerFactionId === sNext.ownerFactionId) continue;

    const from = sPrev.ownerFactionId ?? null;
    const to = sNext.ownerFactionId ?? null;

    if (from !== playerFactionId && to !== playerFactionId) continue;

    systems.push({
      systemId: sNext.id,
      systemName: sNext.name,
      fromOwnerFactionId: from,
      toOwnerFactionId: to,
      kind: to === playerFactionId ? 'CAPTURED' : 'LOST',
    });
  }

  // Fleet deltas (player only)
  const prevPlayerFleetIds = computePlayerFleetIds(prev, playerFactionId);
  const nextPlayerFleetIds = computePlayerFleetIds(next, playerFactionId);
  const fleetCreated = [...nextPlayerFleetIds].filter(id => !prevPlayerFleetIds.has(id)).sort();
  const fleetDestroyed = [...prevPlayerFleetIds].filter(id => !nextPlayerFleetIds.has(id)).sort();

  // Ship deltas (player only)
  const shipByType = buildShipTypeDeltaTemplate();
  const prevShipTypeById = computePlayerShipTypeById(prev, playerFactionId);
  const nextShipTypeById = computePlayerShipTypeById(next, playerFactionId);

  const prevShipIds = new Set(prevShipTypeById.keys());
  const nextShipIds = new Set(nextShipTypeById.keys());

  const shipsCreatedIds = [...nextShipIds].filter(id => !prevShipIds.has(id));
  const shipsDestroyedIds = [...prevShipIds].filter(id => !nextShipIds.has(id));

  for (const id of shipsCreatedIds) {
    const type = nextShipTypeById.get(id) ?? 'unknown';
    shipByType[type] = shipByType[type] ?? emptyShipDelta();
    shipByType[type].created += 1;
  }
  for (const id of shipsDestroyedIds) {
    const type = prevShipTypeById.get(id) ?? 'unknown';
    shipByType[type] = shipByType[type] ?? emptyShipDelta();
    shipByType[type].destroyed += 1;
  }

  // Battles resolved this turn (player-involved only)
  const fleetFactionById = computeFleetFactionById(prev, next);
  const resolved = (next.battles ?? []).filter(b => isBattleResolvedOnTurn(b, turn));

  const battles: TurnReportBattleV1[] = [];
  const fleetXpDelta: Record<string, number> = {};

  for (const b of resolved) {
    const playerFleetIds: string[] = [];
    const enemyFleetIds: string[] = [];

    for (const fid of b.involvedFleetIds ?? []) {
      const faction = fleetFactionById.get(fid);
      if (!faction) continue;
      if (faction === playerFactionId) playerFleetIds.push(fid);
      else enemyFleetIds.push(fid);
    }

    if (playerFleetIds.length === 0) continue; // don't leak enemy-only battles

    const sysName = findSystem(next.systems, b.systemId)?.name ?? b.systemId;
    const winner = b.winnerFactionId ?? null;

    const { playerLossByType, enemyLossByType } = computeBattleLossesByType(b, playerFactionId);
    const playerLost = sumRecord(playerLossByType);

    // Compute "motivation XP" per involved player fleet
    const perFleetXp = computeMotivationXp(
      typeof winner === 'string' ? winner : null,
      playerLost,
      playerFleetIds.length
    );
    for (const fid of playerFleetIds) {
      fleetXpDelta[fid] = (fleetXpDelta[fid] ?? 0) + perFleetXp;
    }

    battles.push({
      battleId: b.id,
      systemId: b.systemId,
      systemName: sysName,
      winnerFactionId: winner,
      roundsPlayed: typeof b.roundsPlayed === 'number' ? b.roundsPlayed : null,

      playerFleetIds: playerFleetIds.slice().sort(),
      enemyFleetIds: enemyFleetIds.slice().sort(),

      playerShipsLostByType: playerLossByType,
      enemyShipsLostByType: enemyLossByType,

      missilesIntercepted: b.missilesIntercepted ?? 0,
      projectilesDestroyedByPd: b.projectilesDestroyedByPd ?? 0,
    });
  }

  const summary: TurnReportSummaryV1 = {
    battles: battles.length,
    battlesWon: battles.filter(b => b.winnerFactionId === playerFactionId).length,
    battlesLost: battles.filter(b => b.winnerFactionId && b.winnerFactionId !== 'draw' && b.winnerFactionId !== playerFactionId).length,

    systemsCaptured: systems.filter(s => s.kind === 'CAPTURED').length,
    systemsLost: systems.filter(s => s.kind === 'LOST').length,

    shipsCreated: shipsCreatedIds.length,
    shipsDestroyed: shipsDestroyedIds.length,

    fleetsCreated: fleetCreated.length,
    fleetsDestroyed: fleetDestroyed.length,

    xpDeltaTotal: sumRecord(fleetXpDelta),
  };

  return {
    v: 1,
    turn,
    playerFactionId,

    summary,

    systems: systems.sort((a, b) => a.systemName.localeCompare(b.systemName)),
    battles: battles.sort((a, b) => a.systemName.localeCompare(b.systemName)),

    deltas: {
      shipByType,
      fleetCreated,
      fleetDestroyed,
    },

    xp: {
      fleetXpDelta,
    },
  };
};

export const pruneTurnReportLogs = (logs: LogEntry[], minTurnToKeep: number): LogEntry[] => {
  return logs.filter(l => {
    const isReportLog =
      typeof l.text === 'string' &&
      (l.text.startsWith(TURN_REPORT_JSON_PREFIX) || l.text.startsWith(TURN_REPORT_SUMMARY_PREFIX));

    if (!isReportLog) return true;

    // `day` is used as turn index for logs in this codebase.
    return (l.day ?? 0) >= minTurnToKeep;
  });
};

export const buildTurnReportLogs = (payload: TurnReportLogPayloadV1): { jsonLog: LogEntry; summaryLog: LogEntry } => {
  const jsonLog: LogEntry = {
    id: `turnReport_json_${payload.turn}`,
    day: payload.turn,
    type: 'info',
    text: `${TURN_REPORT_JSON_PREFIX} ${JSON.stringify(payload)}`,
  };

  const s = payload.summary;
  const summaryText =
    `${TURN_REPORT_SUMMARY_PREFIX} Turn ${payload.turn}: ` +
    `Battles ${s.battles} (W${s.battlesWon}/L${s.battlesLost}), ` +
    `Systems +${s.systemsCaptured}/-${s.systemsLost}, ` +
    `Ships +${s.shipsCreated}/-${s.shipsDestroyed}, ` +
    `XP +${s.xpDeltaTotal}`;

  const summaryLog: LogEntry = {
    id: `turnReport_${payload.turn}`,
    day: payload.turn,
    type: 'info',
    text: summaryText,
  };

  return { jsonLog, summaryLog };
};

export const withTurnReportLogs = (
  prev: GameState,
  next: GameState,
  opts: { maxKeep?: number; defaultEnabled?: boolean } = {}
): GameState => {
  if (!isTurnReportEnabled(opts.defaultEnabled ?? true)) return next;

  const payload = computeTurnReportPayloadV1(prev, next);
  const { jsonLog, summaryLog } = buildTurnReportLogs(payload);

  // Avoid duplicates if a save was loaded and advanceTurn is called again.
  const alreadyHasJson = next.logs?.some(l => l.id === jsonLog.id) ?? false;
  const alreadyHasSummary = next.logs?.some(l => l.id === summaryLog.id) ?? false;
  if (alreadyHasJson && alreadyHasSummary) return next;

  const maxKeep = opts.maxKeep ?? TURN_REPORT_MAX_KEEP_DEFAULT;
  const minTurnToKeep = Math.max(0, payload.turn - (maxKeep - 1));
  const pruned = pruneTurnReportLogs(next.logs ?? [], minTurnToKeep);

  const newLogs = pruned.concat(
    alreadyHasJson ? [] : [jsonLog],
    alreadyHasSummary ? [] : [summaryLog]
  );

  return {
    ...next,
    logs: newLogs,
  };
};
