import { GameState, FactionId } from '../types';

export const checkVictoryConditions = (state: GameState): FactionId | null => {
  const factionIds = getFactionIds(state);

  const maxTurns = state.rules.victoryConditions?.maxTurns;
  const hasSurvivalCondition =
    state.rules.victoryConditions?.conditions?.some(c => c.type === 'survival') ?? false;

  // Survival is evaluated only when maxTurns is reached.
  if (maxTurns && state.day > maxTurns) {
    if (!hasSurvivalCondition) return null;

    const playerId = state.playerFactionId;
    return hasActivePresence(state, playerId) ? playerId : null;
  }

  for (const factionId of factionIds) {
    if (checkFactionVictory(state, factionId, factionIds)) {
      return factionId;
    }
  }

  return null;
};

const getFactionIds = (state: GameState): FactionId[] => {
  // Primary source: scenario-defined factions
  const fromState = (state.factions || [])
    .map(f => f.id)
    .filter((id): id is FactionId => typeof id === 'string' && id.length > 0);

  if (fromState.length > 0) {
    return [...fromState].sort((a, b) => a.localeCompare(b));
  }

  // Fallback: discover factions from existing entities (legacy saves / partial states)
  const discovered = new Set<FactionId>();
  state.fleets.forEach(f => discovered.add(f.factionId));
  state.armies.forEach(a => discovered.add(a.factionId));
  state.systems.forEach(s => {
    if (s.ownerFactionId) discovered.add(s.ownerFactionId);
  });

  const ids = Array.from(discovered);
  if (ids.length > 0) return ids.sort((a, b) => a.localeCompare(b));

  // Last resort: keep legacy default
  return ['blue', 'red'];
};

const checkFactionVictory = (
  state: GameState,
  factionId: FactionId,
  allFactionIds: FactionId[]
): boolean => {
  const conditions = state.rules.victoryConditions?.conditions;

  // Default behavior (if not specified): elimination
  if (!conditions || conditions.length === 0) {
    return checkElimination(state, factionId, allFactionIds);
  }

  return conditions.some(condition => {
    switch (condition.type) {
      case 'elimination':
        return checkElimination(state, factionId, allFactionIds);
      case 'domination':
        return checkDomination(state, factionId, condition.threshold);
      case 'king_of_hill':
        return checkKingOfHill(state, factionId, condition.systemId, condition.turns);
      case 'survival':
        // Evaluated only via maxTurns gate above
        return false;
      default:
        return false;
    }
  });
};

const hasActivePresence = (state: GameState, factionId: FactionId): boolean => {
  // Conservative: fleets with ships is the minimum "alive" signal.
  return state.fleets.some(f => f.factionId === factionId && f.ships.length > 0);
};

const checkElimination = (
  state: GameState,
  factionId: FactionId,
  allFactionIds: FactionId[]
): boolean => {
  if (!hasActivePresence(state, factionId)) return false;

  const enemies = allFactionIds.filter(id => id !== factionId);
  if (enemies.length === 0) return false; // Solo scenario: do not auto-win.

  return enemies.every(enemyId => !hasActivePresence(state, enemyId));
};

const checkDomination = (state: GameState, factionId: FactionId, threshold: number): boolean => {
  const totalSystems = state.systems.length;
  if (totalSystems === 0) return false;

  const owned = state.systems.filter(s => s.ownerFactionId === factionId).length;
  return owned / totalSystems >= threshold;
};

const checkKingOfHill = (
  state: GameState,
  factionId: FactionId,
  systemId: string,
  requiredTurns: number
): boolean => {
  const system = state.systems.find(s => s.id === systemId);
  if (!system) return false;
  if (system.ownerFactionId !== factionId) return false;

  // Robust fallback: if captureTurn is missing, treat as "just captured now"
  // to avoid instantaneous wins on legacy states.
  const captureTurn = system.captureTurn ?? state.day;
  const heldTurns = state.day - captureTurn;

  return heldTurns >= requiredTurns;
};
