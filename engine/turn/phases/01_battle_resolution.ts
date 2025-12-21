
import { GameState, Battle, Fleet, BattleAmmunitionBreakdown, BattleAmmunitionByFaction, GameMessage, FactionId, ArmyState, Army } from '../../../types';
import { TurnContext } from '../types';
import { resolveBattle } from '../../../services/battle/resolution';
import { canonicalizeMessages } from '../../state/canonicalize';

const createEmptyAmmunitionTotals = (): BattleAmmunitionBreakdown => ({
    offensiveMissiles: { initial: 0, used: 0, remaining: 0 },
    torpedoes: { initial: 0, used: 0, remaining: 0 },
    interceptors: { initial: 0, used: 0, remaining: 0 }
});

const aggregateAmmunitionTotals = (ammunitionByFaction?: BattleAmmunitionByFaction): BattleAmmunitionBreakdown => {
    const totals = createEmptyAmmunitionTotals();

    Object.values(ammunitionByFaction ?? {}).forEach(breakdown => {
        totals.offensiveMissiles.initial += breakdown.offensiveMissiles.initial;
        totals.offensiveMissiles.used += breakdown.offensiveMissiles.used;
        totals.offensiveMissiles.remaining += breakdown.offensiveMissiles.remaining;

        totals.torpedoes.initial += breakdown.torpedoes.initial;
        totals.torpedoes.used += breakdown.torpedoes.used;
        totals.torpedoes.remaining += breakdown.torpedoes.remaining;

        totals.interceptors.initial += breakdown.interceptors.initial;
        totals.interceptors.used += breakdown.interceptors.used;
        totals.interceptors.remaining += breakdown.interceptors.remaining;
    });

    return totals;
};

const formatLossesLine = (shipsLost: Record<FactionId, number>, involvedFactionIds: FactionId[]): string => {
    const sortedFactions = [...involvedFactionIds].sort((a, b) => a.localeCompare(b));
    const descriptions = sortedFactions.map(factionId => `${factionId}: ${shipsLost[factionId] ?? 0}`);
    return descriptions.join(', ');
};

const formatAmmunitionLine = (totals: BattleAmmunitionBreakdown): string => {
    const formatTally = (label: string, tally: { initial: number; used: number; remaining: number }) =>
        `${label} ${tally.used}/${tally.initial} used (${tally.remaining} remaining)`;

    return [
        formatTally('Missiles', totals.offensiveMissiles),
        formatTally('Torpedoes', totals.torpedoes),
        formatTally('Interceptors', totals.interceptors)
    ].join(' | ');
};

export const phaseBattleResolution = (state: GameState, ctx: TurnContext): GameState => {
    // 1. Identify Scheduled Battles
    const scheduledBattles = state.battles.filter(b => b.status === 'scheduled');
    
    if (scheduledBattles.length === 0) return state;

    // DETERMINISM FIX: Sort battles canonically before processing
    // This ensures RNG consumption order is consistent regardless of array insertion order
    scheduledBattles.sort((a, b) => {
        // Primary: by systemId (alphabetical)
        const sysCompare = a.systemId.localeCompare(b.systemId);
        if (sysCompare !== 0) return sysCompare;
        // Secondary: by battle id (ensures uniqueness)
        return a.id.localeCompare(b.id);
    });

    let nextBattles = [...state.battles];
    let nextFleets = [...state.fleets];
    let nextArmies = [...state.armies];
    let nextLogs = [...state.logs];
    let nextMessages = [...state.messages];

    // 2. Resolve Each Battle
    scheduledBattles.forEach(battle => {
        const fleetsInBattle = nextFleets.filter(fleet => battle.involvedFleetIds.includes(fleet.id));
        const result = resolveBattle(battle, { ...state, fleets: nextFleets }, ctx.turn);

        // Update Battle in list (Mark as resolved, add logs, stats)
        nextBattles = nextBattles.map(b => b.id === battle.id ? result.updatedBattle : b);
        
        // Update Fleets:
        // A. Remove ALL fleets originally involved (some might have died, some survived with new state)
        nextFleets = nextFleets.filter(f => !battle.involvedFleetIds.includes(f.id));
        
        // B. Add survivors back (These are new immutable Fleet objects returned by resolver)
        nextFleets.push(...result.survivingFleets);

        const destroyedFleetIds = new Set<string>(
            result.destroyedFleetIds && result.destroyedFleetIds.length > 0
                ? result.destroyedFleetIds
                : battle.involvedFleetIds.filter(fleetId => !result.survivingFleets.some(fleet => fleet.id === fleetId))
        );
        const destroyedShipIds = new Set(result.destroyedShipIds ?? []);
        const destroyedArmyIds = new Set(result.destroyedArmyIds ?? []);

        fleetsInBattle.forEach(fleet => {
            fleet.ships.forEach(ship => {
                if (ship.carriedArmyId && destroyedShipIds.has(ship.id)) {
                    destroyedArmyIds.add(ship.carriedArmyId);
                }
            });
        });

        const armiesAfterBattle: Army[] = [];
        const lostArmyIds: string[] = [];

        nextArmies.forEach(army => {
            if (army.state !== ArmyState.EMBARKED) {
                armiesAfterBattle.push(army);
                return;
            }

            if (destroyedArmyIds.has(army.id) || destroyedFleetIds.has(army.containerId)) {
                destroyedArmyIds.add(army.id);
                lostArmyIds.push(army.id);
                return;
            }

            armiesAfterBattle.push(army);
        });

        nextArmies = armiesAfterBattle;
        
        // Global Notification
        if (result.updatedBattle.winnerFactionId) {
             const sysName = state.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
             nextLogs.push({
                 id: ctx.rng.id('log'),
                 day: ctx.turn,
                 text: `Combat resolved at ${sysName}. Outcome: ${result.updatedBattle.winnerFactionId.toUpperCase()}.`,
                 type: 'combat'
             });
        }

        // Battle Message
        const involvedFactionIdsSet = new Set<FactionId>();
        battle.involvedFleetIds.forEach(fleetId => {
            const fleet = state.fleets.find(f => f.id === fleetId) || nextFleets.find(f => f.id === fleetId);
            if (fleet) involvedFactionIdsSet.add(fleet.factionId as FactionId);
        });
        Object.keys(result.updatedBattle.shipsLost ?? {}).forEach(factionId => involvedFactionIdsSet.add(factionId as FactionId));
        const involvedFactionIds = Array.from(involvedFactionIdsSet).sort((a, b) => a.localeCompare(b));

        const systemName = state.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
        const isPlayerInvolved = involvedFactionIds.includes(state.playerFactionId);
        const ammunitionTotals = aggregateAmmunitionTotals(result.updatedBattle.ammunitionByFaction);
        const battleSystemName = systemName || battle.systemId;

        if (lostArmyIds.length > 0) {
            lostArmyIds.sort().forEach(armyId => {
                nextLogs.push({
                    id: ctx.rng.id('log'),
                    day: ctx.turn,
                    text: `Army ${armyId} was lost with its transport during the battle at ${battleSystemName}.`,
                    type: 'combat'
                });
            });
        }

        const message: GameMessage = {
            id: ctx.rng.id('msg'),
            day: ctx.turn,
            type: 'battle_resolution',
            priority: isPlayerInvolved ? 2 : 1,
            title: `Battle resolved at ${systemName}`,
            subtitle: result.updatedBattle.winnerFactionId
                ? `Winner: ${result.updatedBattle.winnerFactionId.toUpperCase()}`
                : 'Outcome undetermined',
            lines: [
                `Ships lost - ${formatLossesLine(result.updatedBattle.shipsLost ?? {}, involvedFactionIds)}`,
                `Munitions - ${formatAmmunitionLine(ammunitionTotals)}`
            ],
            payload: {
                battleId: battle.id,
                systemId: battle.systemId,
                involvedFactionIds
            },
            read: false,
            dismissed: false,
            createdAtTurn: ctx.turn
        };

        nextMessages = canonicalizeMessages([...nextMessages, message]);
    });

    return {
        ...state,
        battles: nextBattles,
        fleets: nextFleets,
        armies: nextArmies,
        logs: nextLogs,
        messages: nextMessages
    };
};
