
import { GameState, FactionId } from '../shared/types';

/**
 * Checks all active victory conditions to determine if a faction has won.
 * Returns the winning Faction, or null if the game continues.
 */
export const checkVictoryConditions = (state: GameState): FactionId | 'draw' | null => {
  const factionIds = state.factions.map(f => f.id);

  // 1. Check Max Turns (Draw/Timeout)
  // If maxTurns is reached, the game ends.
  // In a typical scenario, if you haven't won by X turns, you might lose, or it might be a score check.
  // For now, if 'survival' is a condition and turns are reached, Blue wins. Otherwise null/draw.
  // Turn limit is inclusive: reaching the specified day should immediately trigger end-of-game logic.
  if (state.objectives.maxTurns && state.day >= state.objectives.maxTurns) {
    return resolveTurnLimitOutcome(state);
  }

  // 2. Check each Faction against Global Conditions
  // Note: Most scenarios are symmetrical for "Elimination" and "Domination".
  for (const factionId of factionIds) {
    if (checkFactionVictory(factionId, state)) {
      return factionId;
    }
  }

  return null;
};

/**
 * Checks if a specific faction fulfills any of the victory conditions.
 */
const checkFactionVictory = (factionId: FactionId, state: GameState): boolean => {
  // If there are no explicit conditions, default to Elimination check (fallback)
  if (state.objectives.conditions.length === 0) {
    return checkElimination(factionId, state);
  }

  // A faction wins if it satisfies ANY of the "OR" conditions defined in the scenario.
  return state.objectives.conditions.some(condition => {
    switch (condition.type) {
      case 'elimination':
        return checkElimination(factionId, state);
      case 'domination':
        return checkDomination(factionId, state, condition.value);
      case 'king_of_the_hill':
        return checkKingOfTheHill(factionId, state, condition.value);
      case 'survival':
        // Survival is time-based, checked in the main loop above (MaxTurns).
        // It cannot be triggered "early".
        return false; 
      default:
        return false;
    }
  });
};

// --- CONDITION EVALUATORS ---

/**
 * Elimination: A faction wins if all opposing factions have no active fleets and no owned systems.
 */
const checkElimination = (factionId: FactionId, state: GameState): boolean => {
  const enemies = state.factions.map(f => f.id).filter(f => f !== factionId);

  // Are all enemies wiped out?
  const allEnemiesDestroyed = enemies.every(enemyFactionId => {
    const hasFleets = state.fleets.some(f => f.factionId === enemyFactionId && f.ships.length > 0);
    const hasSystems = state.systems.some(s => s.ownerFactionId === enemyFactionId);
    return !hasFleets && !hasSystems;
  });

  return allEnemiesDestroyed;
};

/**
 * Domination: A faction wins if it owns >= X% of the systems.
 */
const checkDomination = (factionId: FactionId, state: GameState, value?: number | string): boolean => {
  const percentage = typeof value === 'number' ? value : 50; // Default 50%
  
  const totalSystems = state.systems.length;
  if (totalSystems === 0) return false;

  const ownedCount = state.systems.filter(s => s.ownerFactionId === factionId).length;
  const ratio = (ownedCount / totalSystems) * 100;

  return ratio >= percentage;
};

/**
 * King of the Hill: A faction wins if it owns a specific target system.
 */
const checkKingOfTheHill = (factionId: FactionId, state: GameState, value?: number | string): boolean => {
  if (!value || typeof value !== 'string') return false;
  const targetSystemId = value;

  const system = state.systems.find(s => s.id === targetSystemId);
  return system ? system.ownerFactionId === factionId : false;
};

// --- UTILS ---

const hasActivePresence = (state: GameState, factionId: FactionId): boolean => {
  return state.fleets.some(f => f.factionId === factionId && f.ships.length > 0);
};

const resolveTurnLimitOutcome = (state: GameState): FactionId | 'draw' => {
  const survivalCondition = state.objectives.conditions.find(c => c.type === 'survival');
  if (survivalCondition) {
    const playerAlive = hasActivePresence(state, state.playerFactionId);
    return playerAlive ? state.playerFactionId : 'draw';
  }

  const ownershipByFaction: Record<FactionId, number> = state.factions.reduce((acc, faction) => {
    acc[faction.id] = state.systems.filter(system => system.ownerFactionId === faction.id).length;
    return acc;
  }, {} as Record<FactionId, number>);

  const maxOwned = Math.max(...Object.values(ownershipByFaction));
  if (maxOwned === 0) return 'draw';

  const leaders = Object.entries(ownershipByFaction)
    .filter(([, owned]) => owned === maxOwned)
    .map(([factionId]) => factionId as FactionId);

  return leaders.length === 1 ? leaders[0] : 'draw';
};
