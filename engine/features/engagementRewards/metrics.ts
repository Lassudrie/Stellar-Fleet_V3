import { Battle, FactionId, GameState, StarSystem } from '../../../types';
import { TurnMetrics } from './types';

const countSystemsOwned = (systems: StarSystem[], factionId: FactionId): number =>
  systems.reduce((acc, s) => acc + (s.ownerFactionId === factionId ? 1 : 0), 0);

const countGasSystemsOwned = (systems: StarSystem[], factionId: FactionId): number =>
  systems.reduce((acc, s) => {
    if (s.ownerFactionId !== factionId) return acc;
    return acc + (s.type === 'gas' ? 1 : 0);
  }, 0);

const resolvedBattlesThisTurn = (battles: Battle[], day: number): Battle[] =>
  battles.filter((b) => b.status === 'resolved' && b.turnResolved === day);

const battleInvolvesFaction = (battle: Battle, factionId: FactionId): boolean => {
  if (battle.attackerFleetFactionId === factionId) return true;
  if (battle.defenderFleetFactionId === factionId) return true;
  return false;
};

const countWinsLosses = (battles: Battle[], factionId: FactionId): { won: number; lost: number } => {
  let won = 0;
  let lost = 0;

  for (const b of battles) {
    if (!battleInvolvesFaction(b, factionId)) continue;
    if (!b.winnerFactionId) continue;

    if (b.winnerFactionId === factionId) won += 1;
    else lost += 1;
  }

  return { won, lost };
};

const countNewlyConqueredSystems = (prevSystems: StarSystem[], nextSystems: StarSystem[], factionId: FactionId): number => {
  const prevOwnerById = new Map<string, FactionId | null>();
  for (const s of prevSystems) prevOwnerById.set(s.id, s.ownerFactionId);

  let conquered = 0;
  for (const s of nextSystems) {
    const prevOwner = prevOwnerById.get(s.id);
    if (s.ownerFactionId === factionId && prevOwner !== factionId) conquered += 1;
  }
  return conquered;
};

export const computeTurnMetrics = (prev: GameState, next: GameState): TurnMetrics => {
  const playerFactionId = next.playerFactionId as FactionId;

  const systemsOwnedPrev = countSystemsOwned(prev.systems, playerFactionId);
  const systemsOwnedNext = countSystemsOwned(next.systems, playerFactionId);

  const gasSystemsOwnedPrev = countGasSystemsOwned(prev.systems, playerFactionId);
  const gasSystemsOwnedNext = countGasSystemsOwned(next.systems, playerFactionId);

  const resolved = resolvedBattlesThisTurn(next.battles, next.day);
  const { won, lost } = countWinsLosses(resolved, playerFactionId);

  const systemsConqueredThisTurn = countNewlyConqueredSystems(prev.systems, next.systems, playerFactionId);

  return {
    playerFactionId,

    systemsOwnedPrev,
    systemsOwnedNext,
    deltaSystemsOwned: systemsOwnedNext - systemsOwnedPrev,

    gasSystemsOwnedPrev,
    gasSystemsOwnedNext,
    deltaGasSystemsOwned: gasSystemsOwnedNext - gasSystemsOwnedPrev,

    battlesResolvedThisTurn: resolved.length,
    battlesWonThisTurn: won,
    battlesLostThisTurn: lost,

    systemsConqueredThisTurn,
  };
};
