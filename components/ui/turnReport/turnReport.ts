import { LogEntry } from '../../../types';

/**
 * UI TURN REPORT PARSER (SITREP) — V1
 *
 * Reports are stored as LogEntry.text prefixed with `[TURN_REPORT_JSON]`.
 * Engine writes them deterministically at end of each turn.
 */

export const TURN_REPORT_JSON_PREFIX = '[TURN_REPORT_JSON]';
export const TURN_REPORT_SUMMARY_PREFIX = '[TURN_REPORT]';
export const TURN_REPORT_ENABLED_STORAGE_KEY = 'sf_turnReportsEnabled';

export type TurnReportTab = 'SUMMARY' | 'BATTLES' | 'SYSTEMS' | 'SHIPS' | 'FLEETS' | 'XP';

export interface TurnReportSystemChangeV1 {
  systemId: string;
  systemName: string;
  fromOwnerFactionId: string | null;
  toOwnerFactionId: string | null;
  kind: 'CAPTURED' | 'LOST';
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

export interface TurnReportLogPayloadV1 {
  v: 1;
  turn: number;

  playerFactionId: string;

  summary: {
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
  };

  systems: TurnReportSystemChangeV1[];
  battles: TurnReportBattleV1[];

  deltas: {
    shipByType: Record<string, { created: number; destroyed: number }>;
    fleetCreated: string[];
    fleetDestroyed: string[];
  };

  xp: {
    fleetXpDelta: Record<string, number>;
  };
}

const safeGet = (key: string): string | null => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const safeSet = (key: string, value: string): void => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(key, value);
  } catch {
    // ignore
  }
};

export const readTurnReportsEnabled = (defaultValue = true): boolean => {
  const raw = safeGet(TURN_REPORT_ENABLED_STORAGE_KEY);
  if (raw === null) return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') return true;

  return defaultValue;
};

export const writeTurnReportsEnabled = (enabled: boolean): void => {
  safeSet(TURN_REPORT_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
};

export const parseTurnReportsFromLogs = (logs: LogEntry[]): TurnReportLogPayloadV1[] => {
  const parsed: TurnReportLogPayloadV1[] = [];

  for (const log of logs ?? []) {
    if (!log || typeof log.text !== 'string') continue;
    if (!log.text.startsWith(TURN_REPORT_JSON_PREFIX)) continue;

    const jsonPart = log.text.slice(TURN_REPORT_JSON_PREFIX.length).trim();
    if (!jsonPart) continue;

    try {
      const payload = JSON.parse(jsonPart);
      if (!payload || payload.v !== 1) continue;
      if (typeof payload.turn !== 'number') continue;

      parsed.push(payload as TurnReportLogPayloadV1);
    } catch {
      // ignore malformed entries
    }
  }

  // de-dupe by turn, keep last occurrence
  const byTurn = new Map<number, TurnReportLogPayloadV1>();
  for (const r of parsed) byTurn.set(r.turn, r);

  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
};
