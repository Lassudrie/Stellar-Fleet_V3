import type {
  Army,
  Battle,
  Fleet,
  GameMessage,
  GameState,
  GroundBuilding,
  LaserShot,
  LogEntry,
  SettlementControlState,
  StarSystem,
  Station
} from '../shared/shared';
import { sorted } from '../shared/shared';

// ============================================================
// Immutability guards (was: engine/state/immutability.ts)
// ============================================================

/**
 * Recursively freezes an object and its properties.
 * ONLY executes in Development mode. In Production, it simply returns the object.
 * This is used to enforce immutability in the Redux-like state management pattern.
 */
export function deepFreezeDev<T>(obj: T): T {
  const importMetaEnv = (import.meta as any)?.env;
  const isDevEnv = Boolean(importMetaEnv?.DEV);
  const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
  const isTestEnv = nodeEnv === 'test';
  const shouldFreeze = isDevEnv || isTestEnv;

  if (!shouldFreeze) {
    return obj;
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Object.isFrozen(obj)) {
    return obj;
  }

  const propNames = Object.getOwnPropertyNames(obj);

  for (const name of propNames) {
    const value = (obj as any)[name];
    deepFreezeDev(value);
  }

  return Object.freeze(obj);
}

// ============================================================
// Canonicalization (was: engine/state/canonicalize.ts)
// ============================================================

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

const isSortedByDayThenId = (entries: Array<{ day: number; id: string }>): boolean => {
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    if (curr.day < prev.day) return false;
    if (curr.day === prev.day && compareIds(curr.id, prev.id) < 0) return false;
  }
  return true;
};

/**
 * Returns a new GameState with all entity arrays sorted in canonical order.
 *
 * This ensures that:
 * 1. Iteration order is consistent regardless of insertion order
 * 2. RNG consumption patterns are reproducible
 * 3. State comparisons are meaningful
 *
 * Note: This creates shallow copies of arrays, not deep copies of entities.
 */
export const canonicalizeState = (state: GameState): GameState => {
  return {
    ...state,
    systems: canonicalizeSystems(state.systems),
    fleets: canonicalizeFleets(state.fleets),
    stations: canonicalizeStations(state.stations ?? []),
    armies: canonicalizeArmies(state.armies),
    lasers: canonicalizeLasers(state.lasers),
    groundBuildings: canonicalizeGroundBuildings(state.groundBuildings ?? []),
    settlementControl: canonicalizeSettlementControl(state.settlementControl),
    bombardedTilesByBodyId: canonicalizeBombardedTilesByBodyId(state.bombardedTilesByBodyId),
    battles: canonicalizeBattles(state.battles),
    logs: canonicalizeLogs(state.logs),
    messages: canonicalizeMessages(state.messages)
  };
};

export const canonicalizeSystems = (systems: StarSystem[]): StarSystem[] => {
  return sorted(systems, (a, b) => compareIds(a.id, b.id));
};

/**
 * Canonicalize fleets array - sorted by ID
 * Also canonicalizes ships within each fleet
 */
export const canonicalizeFleets = (fleets: Fleet[]): Fleet[] => {
  return sorted(
    fleets.map(fleet => ({
      ...fleet,
      ships: sorted(fleet.ships, (a, b) => compareIds(a.id, b.id))
    })),
    (a, b) => compareIds(a.id, b.id)
  );
};

export const canonicalizeStations = (stations: Station[]): Station[] => {
  return sorted(stations, (a, b) => compareIds(a.id, b.id));
};

export const canonicalizeArmies = (armies: Army[]): Army[] => {
  return sorted(armies, (a, b) => compareIds(a.id, b.id));
};

export const canonicalizeLasers = (lasers: LaserShot[]): LaserShot[] => {
  return sorted(lasers, (a, b) => compareIds(a.id, b.id));
};

export const canonicalizeGroundBuildings = (buildings: GroundBuilding[]): GroundBuilding[] => {
  return sorted(buildings, (a, b) => compareIds(a.id, b.id));
};

export const canonicalizeSettlementControl = (
  control?: Record<string, SettlementControlState>
): Record<string, SettlementControlState> | undefined => {
  if (!control) return control;
  const keys = Object.keys(control);
  if (keys.length <= 1 && (keys.length === 0 || keys[0] in control)) return control;
  const ordered = sorted(keys, (a, b) => compareIds(a, b));
  const next: Record<string, SettlementControlState> = {};
  ordered.forEach(key => {
    next[key] = control[key];
  });
  return next;
};

export const canonicalizeBombardedTilesByBodyId = (
  value?: Record<string, number[]>
): Record<string, number[]> | undefined => {
  if (!value) return value;
  const keys = Object.keys(value);
  if (keys.length === 0) return value;
  const orderedKeys = sorted(keys, (a, b) => compareIds(a, b));
  const next: Record<string, number[]> = {};
  orderedKeys.forEach(bodyId => {
    const tiles = value[bodyId] ?? [];
    const orderedTiles = sorted(tiles, (a, b) => a - b);
    next[bodyId] = orderedTiles.map(tileId => Math.floor(tileId));
  });
  return next;
};

export const canonicalizeBattles = (battles: Battle[]): Battle[] => {
  return sorted(battles, (a, b) => compareIds(a.id, b.id));
};

/**
 * Canonicalize logs array - sorted by day (ascending), then by ID
 * Preserves chronological order while ensuring determinism within a day
 */
export const canonicalizeLogs = (logs: LogEntry[]): LogEntry[] => {
  if (isSortedByDayThenId(logs)) return logs;
  return sorted(logs, (a, b) => {
    const dayDiff = a.day - b.day;
    if (dayDiff !== 0) return dayDiff;
    return compareIds(a.id, b.id);
  });
};

export const canonicalizeMessages = (messages: GameMessage[]): GameMessage[] => {
  if (isSortedByDayThenId(messages)) return messages;
  return sorted(messages, (a, b) => {
    const dayDiff = a.day - b.day;
    if (dayDiff !== 0) return dayDiff;
    return compareIds(a.id, b.id);
  });
};

/**
 * Checks if a state is already in canonical order.
 * Useful for debug assertions without the cost of re-sorting.
 */
export const isCanonical = (state: GameState): boolean => {
  // Check fleets order
  for (let i = 1; i < state.fleets.length; i++) {
    if (compareIds(state.fleets[i].id, state.fleets[i - 1].id) < 0) {
      return false;
    }
  }

  // Check ships order within fleets
  for (const fleet of state.fleets) {
    for (let i = 1; i < fleet.ships.length; i++) {
      if (compareIds(fleet.ships[i].id, fleet.ships[i - 1].id) < 0) {
        return false;
      }
    }
  }

  // Check armies order
  for (let i = 1; i < state.armies.length; i++) {
    if (compareIds(state.armies[i].id, state.armies[i - 1].id) < 0) {
      return false;
    }
  }

  // Check lasers order
  for (let i = 1; i < state.lasers.length; i++) {
    if (compareIds(state.lasers[i].id, state.lasers[i - 1].id) < 0) {
      return false;
    }
  }

  const groundBuildings = state.groundBuildings ?? [];
  for (let i = 1; i < groundBuildings.length; i++) {
    if (compareIds(groundBuildings[i].id, groundBuildings[i - 1].id) < 0) {
      return false;
    }
  }

  const settlementControl = state.settlementControl;
  if (settlementControl) {
    const keys = Object.keys(settlementControl);
    for (let i = 1; i < keys.length; i++) {
      if (compareIds(keys[i - 1], keys[i]) > 0) {
        return false;
      }
    }
  }

  const bombardedTilesByBodyId = state.bombardedTilesByBodyId;
  if (bombardedTilesByBodyId) {
    const keys = Object.keys(bombardedTilesByBodyId);
    for (let i = 1; i < keys.length; i++) {
      if (compareIds(keys[i - 1], keys[i]) > 0) {
        return false;
      }
    }
    for (const key of keys) {
      const tiles = bombardedTilesByBodyId[key] ?? [];
      for (let i = 1; i < tiles.length; i++) {
        if (tiles[i] < tiles[i - 1]) return false;
      }
    }
  }

  const stations = state.stations ?? [];
  for (let i = 1; i < stations.length; i++) {
    if (compareIds(stations[i].id, stations[i - 1].id) < 0) {
      return false;
    }
  }

  // Check battles order
  for (let i = 1; i < state.battles.length; i++) {
    if (compareIds(state.battles[i].id, state.battles[i - 1].id) < 0) {
      return false;
    }
  }

  // Check systems order
  for (let i = 1; i < state.systems.length; i++) {
    if (compareIds(state.systems[i].id, state.systems[i - 1].id) < 0) {
      return false;
    }
  }

  // Check logs order
  if (!isSortedByDayThenId(state.logs)) {
    return false;
  }

  // Check messages order
  if (!isSortedByDayThenId(state.messages)) {
    return false;
  }

  return true;
};
