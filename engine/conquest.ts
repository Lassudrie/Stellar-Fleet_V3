import { GameState, StarSystem, Army, ArmyState, FactionId } from '../types';
import { CAPTURE_RANGE } from '../data/static';
import { MIN_ARMY_STRENGTH } from './army';
import { distSq } from './math/vec3';

export interface GroundBattleResult {
  systemId: string;
  winnerFactionId: FactionId | 'draw' | null;
  conquestOccurred: boolean;
  armiesDestroyed: string[];
  logEntry: string;
}

const factionLabel = (state: GameState, factionId: FactionId): string => {
  const faction = state.factions.find(f => f.id === factionId);
  return faction?.name || factionId.toUpperCase();
};

// Resolve ground conflict for a single system.
export const resolveGroundConflict = (system: StarSystem, state: GameState): GroundBattleResult | null => {
  const armiesOnGround = state.armies.filter(
    a => a.state === ArmyState.DEPLOYED && a.containerId === system.id
  );

  if (armiesOnGround.length === 0) return null;

  // Group armies by faction
  const armiesByFaction = new Map<FactionId, Army[]>();
  for (const army of armiesOnGround) {
    const list = armiesByFaction.get(army.factionId);
    if (list) list.push(army);
    else armiesByFaction.set(army.factionId, [army]);
  }

  // Unopposed presence (single faction)
  if (armiesByFaction.size === 1) {
    const [onlyFactionId] = Array.from(armiesByFaction.keys());

    // Already owned by the same faction => no battle / no conquest event.
    if (system.ownerFactionId === onlyFactionId) return null;

    return {
      systemId: system.id,
      winnerFactionId: onlyFactionId,
      conquestOccurred: true,
      armiesDestroyed: [],
      logEntry: `System ${system.name} secured by ${factionLabel(state, onlyFactionId)} ground forces (Unopposed).`
    };
  }

  // Multi-faction battle: compute power per faction
  const powerByFaction: Array<{ factionId: FactionId; power: number; armies: Army[] }> = [];
  for (const [factionId, armies] of armiesByFaction.entries()) {
    powerByFaction.push({ factionId, power: computeGroundPower(armies), armies });
  }

  // Determine winner (unique max power) or draw (tie)
  powerByFaction.sort((a, b) => (b.power - a.power) || a.factionId.localeCompare(b.factionId));
  const topPower = powerByFaction[0].power;
  const top = powerByFaction.filter(p => p.power === topPower);

  if (top.length > 1) {
    const tied = top.map(t => factionLabel(state, t.factionId)).join(', ');
    return {
      systemId: system.id,
      winnerFactionId: 'draw',
      conquestOccurred: false,
      armiesDestroyed: [],
      logEntry: `Ground battle at ${system.name} ends in a stalemate between ${tied} (power ${topPower}).`
    };
  }

  const winnerFactionId = top[0].factionId;
  const winnerArmies = top[0].armies;
  const losers = powerByFaction.filter(p => p.factionId !== winnerFactionId);

  const loserPower = losers.reduce((sum, l) => sum + l.power, 0);

  // All losing armies are destroyed
  const destroyedLoserArmyIds = losers.flatMap(l => l.armies.map(a => a.id));

  // Winner takes attrition proportional to defeated power
  const winnerLossCount = Math.floor((loserPower / MIN_ARMY_STRENGTH) * 0.5);
  const winnerArmiesSorted = [...winnerArmies].sort((a, b) => (a.strength - b.strength) || a.id.localeCompare(b.id));
  const destroyedWinnerArmyIds = winnerArmiesSorted
    .slice(0, Math.min(winnerLossCount, winnerArmiesSorted.length))
    .map(a => a.id);

  const armiesDestroyed = [...destroyedLoserArmyIds, ...destroyedWinnerArmyIds];

  // Conquest occurs if system owner differs from winner
  let conquestOccurred = system.ownerFactionId !== winnerFactionId;

  // Orbital contestation rule: prevent conquest if winner AND enemy fleets both contest orbit.
  if (conquestOccurred && !canConquerSystem(system, state, winnerFactionId)) {
    conquestOccurred = false;
  }

  const parts: string[] = [];
  parts.push(
    `Ground battle at ${system.name}: ${factionLabel(state, winnerFactionId)} victorious (power ${topPower} vs ${loserPower}).`
  );
  if (destroyedLoserArmyIds.length > 0) parts.push(`Defender losses: ${destroyedLoserArmyIds.length} armies destroyed.`);
  if (destroyedWinnerArmyIds.length > 0) parts.push(`Attacker losses: ${destroyedWinnerArmyIds.length} armies lost.`);
  if (conquestOccurred) {
    parts.push(`Control transferred to ${factionLabel(state, winnerFactionId)}.`);
  } else if (system.ownerFactionId !== winnerFactionId) {
    parts.push(`Control remains contested due to orbital contestation.`);
  }

  return {
    systemId: system.id,
    winnerFactionId,
    conquestOccurred,
    armiesDestroyed,
    logEntry: parts.join(' ')
  };
};

const canConquerSystem = (system: StarSystem, state: GameState, attackerFactionId: FactionId): boolean => {
  // Must have boots on the ground
  const attackerHasTroops = state.armies.some(
    a => a.state === ArmyState.DEPLOYED && a.containerId === system.id && a.factionId === attackerFactionId
  );
  if (!attackerHasTroops) return false;

  const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;

  const attackerFleetPresent = state.fleets.some(
    f => f.factionId === attackerFactionId && f.ships.length > 0 && distSq(f.position, system.position) <= captureSq
  );

  const enemyFleetPresent = state.fleets.some(
    f => f.factionId !== attackerFactionId && f.ships.length > 0 && distSq(f.position, system.position) <= captureSq
  );

  // Match legacy behavior: contestation only blocks conquest if BOTH sides have active fleets in orbit.
  if (attackerFleetPresent && enemyFleetPresent) return false;

  return true;
};

const computeGroundPower = (armies: Army[]): number => {
  return armies.reduce((sum, army) => sum + army.strength, 0);
};

export const estimateInvasionCost = (system: StarSystem, state: GameState): number => {
  const defenders = state.armies.filter(
    a => a.state === ArmyState.DEPLOYED && a.containerId === system.id && a.factionId === system.ownerFactionId
  );

  if (defenders.length === 0) return 1;

  const defenderPower = computeGroundPower(defenders);
  return Math.ceil((defenderPower / MIN_ARMY_STRENGTH) * 1.2);
};
