import { Army, Fleet, GameState, FactionId, StarSystem } from '../../../types';
import { getGroundCombatConfig } from '../../../data/groundCombat';
import { resolveGroundConflict } from '../../conquest';
import { resolveDeterministicGroundCombat } from '../../groundCombat';
import { TurnContext } from '../types';

const isFactionId = (v: any): v is FactionId => typeof v === 'string' && v.length > 0;

const getFactionColorSafe = (state: GameState, factionId: FactionId, fallback: string): string => {
  const faction = state.factions.find(f => f.id === factionId);
  return faction?.color || fallback;
};

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
  let nextLogs = [...state.logs];

  // Track armies to remove (destroyed)
  const armiesToDestroyIds = new Set<string>();

  // Store system updates (systemId -> updated system)
  const systemUpdates = new Map<string, StarSystem>();

  // Deterministic ground combat may update armies (strength/morale/xp) and fleets (retreat embarkation)
  const armyUpdatesById = new Map<string, Partial<Army>>();
  const fleetUpdatesById = new Map<string, Partial<Fleet>>();

  const deterministicEnabled =
    !!state.rules.groundCombat?.enabled && state.rules.groundCombat.model === 'deterministic_attrition_v1';

  const groundCfg = deterministicEnabled ? getGroundCombatConfig(state.rules.groundCombat?.configId) : null;

  // Resolve conflict per system (sorted by ID for determinism)
  const sortedSystems = [...state.systems].sort((a, b) => a.id.localeCompare(b.id));

  for (const system of sortedSystems) {
    const result = deterministicEnabled && groundCfg
      ? resolveDeterministicGroundCombat(system, state, groundCfg)
      : resolveGroundConflict(system, state);

    if (!result) continue;

    // Queue destroyed armies
    result.armiesDestroyed.forEach(id => armiesToDestroyIds.add(id));

    // Apply deterministic per-army updates (if present)
    if ('armyUpdates' in result && Array.isArray((result as any).armyUpdates)) {
      for (const u of (result as any).armyUpdates as Array<{ id: string; changes: Partial<Army> }>) {
        if (!u || typeof u.id !== 'string') continue;
        const existing = armyUpdatesById.get(u.id) || {};
        armyUpdatesById.set(u.id, { ...existing, ...u.changes });
      }
    }

    // Apply deterministic per-fleet updates (if present)
    if ('fleetUpdates' in result && Array.isArray((result as any).fleetUpdates)) {
      for (const u of (result as any).fleetUpdates as Array<{ id: string; changes: Partial<Fleet> }>) {
        if (!u || typeof u.id !== 'string') continue;
        const existing = fleetUpdatesById.get(u.id) || {};
        fleetUpdatesById.set(u.id, { ...existing, ...u.changes });
      }
    }

    // Add logs
    result.logs.forEach(txt => {
      nextLogs.push({
        id: ctx.rng.id('log'),
        day: state.day,
        text: txt,
        type: 'combat',
      });
    });

    // Update ownership
    if (result.conquestOccurred && result.winnerFactionId && result.winnerFactionId !== 'draw') {
      const winnerFactionId = result.winnerFactionId as any;
      if (!isFactionId(winnerFactionId)) continue;

      systemUpdates.set(system.id, {
        ...system,
        ownerFactionId: winnerFactionId,
        color: getFactionColorSafe(state, winnerFactionId, system.color),
      });
    }
  }

  // Apply system updates (preserve original array order)
  const nextSystems = state.systems.map(system => systemUpdates.get(system.id) || system);

  // Apply fleet updates (retreat embarkation)
  const nextFleets = fleetUpdatesById.size
    ? state.fleets.map(fleet => {
        const changes = fleetUpdatesById.get(fleet.id);
        return changes ? { ...fleet, ...changes } : fleet;
      })
    : state.fleets;

  // Apply army updates
  let nextArmies = armyUpdatesById.size
    ? state.armies.map(army => {
        const changes = armyUpdatesById.get(army.id);
        return changes ? { ...army, ...changes } : army;
      })
    : state.armies;

  // Filter destroyed armies
  if (armiesToDestroyIds.size > 0) {
    nextArmies = nextArmies.filter(a => !armiesToDestroyIds.has(a.id));
  }

  return {
    ...state,
    systems: nextSystems,
    fleets: nextFleets,
    armies: nextArmies,
    logs: nextLogs,
  };
};
