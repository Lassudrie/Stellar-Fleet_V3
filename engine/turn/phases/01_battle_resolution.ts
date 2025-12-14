
import { GameState, Battle, Fleet } from '../../../types';
import { TurnContext } from '../types';
import { resolveBattle } from '../../../services/battle/resolution';

export const phaseBattleResolution = (state: GameState, ctx: TurnContext): GameState => {
    // 1. Identify Scheduled Battles
    const scheduledBattles = state.battles.filter(b => b.status === 'scheduled');
    
    if (scheduledBattles.length === 0) return state;

    let nextBattles = [...state.battles];
    let nextFleets = [...state.fleets];
    let nextLogs = [...state.logs];

    // 2. Resolve Each Battle
    scheduledBattles.forEach(battle => {
        const result = resolveBattle(battle, state);
        
        // Update Battle in list (Mark as resolved, add logs, stats)
        nextBattles = nextBattles.map(b => b.id === battle.id ? result.updatedBattle : b);
        
        // Update Fleets:
        // A. Remove ALL fleets originally involved (some might have died, some survived with new state)
        nextFleets = nextFleets.filter(f => !battle.involvedFleetIds.includes(f.id));
        
        // B. Add survivors back (These are new immutable Fleet objects returned by resolver)
        nextFleets.push(...result.survivingFleets);
        
        // Global Notification
        if (result.updatedBattle.winnerFactionId) {
             const sysName = state.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
             nextLogs.push({
                 id: ctx.rng.id('log'),
                 day: state.day,
                 text: `Combat resolved at ${sysName}. Outcome: ${result.updatedBattle.winnerFactionId.toUpperCase()}.`,
                 type: 'combat'
             });
        }
    });

    return {
        ...state,
        battles: nextBattles,
        fleets: nextFleets,
        logs: nextLogs
    };
};
