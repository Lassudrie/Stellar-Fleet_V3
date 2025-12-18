
import { GameState, Fleet, Army } from '../../../types';
import { TurnContext } from '../types';
import { resolveFleetMovement } from '../../../services/movement/movementPhase';

export const phaseMovement = (state: GameState, ctx: TurnContext): GameState => {
    const nextDay = ctx.turn; // Movement projects to current turn positions
    
    const nextFleets: Fleet[] = [];
    const newLogs = [];
    const armyUpdates = new Map<string, Partial<Army>>();

    // 1. Process each fleet
    state.fleets.forEach(fleet => {
        // resolveFleetMovement is pure, returns nextFleet + effects
        const res = resolveFleetMovement(fleet, state.systems, state.armies, nextDay, ctx.rng, state.fleets);
        nextFleets.push(res.nextFleet);
        newLogs.push(...res.logs);
        res.armyUpdates.forEach(u => armyUpdates.set(u.id, u.changes));
    });

    // 2. Apply Army Updates (Embark/Deploy)
    let nextArmies = state.armies;
    if (armyUpdates.size > 0) {
        nextArmies = state.armies.map(a => {
            if (armyUpdates.has(a.id)) {
                return { ...a, ...armyUpdates.get(a.id) };
            }
            return a;
        });
    }

    return {
        ...state,
        fleets: nextFleets,
        armies: nextArmies,
        logs: [...state.logs, ...newLogs]
    };
};
