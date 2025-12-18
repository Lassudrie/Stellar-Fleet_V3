
import { GameState, Fleet, Army } from '../../../types';
import { TurnContext } from '../types';
import { resolveFleetMovement, ArmyUpdate } from '../../../services/movement/movementPhase';

export const phaseMovement = (state: GameState, ctx: TurnContext): GameState => {
    const nextDay = ctx.turn; // Movement projects to current turn positions

    const fleetsToProcess = [...state.fleets].sort((a, b) => a.id.localeCompare(b.id));
    const newLogs = [];

    const applyArmyUpdates = (armies: Army[], updates: ArmyUpdate[]): Army[] => {
        if (updates.length === 0) {
            return armies;
        }

        const updatesById = new Map<string, Partial<Army>>(updates.map(update => [update.id, update.changes]));

        return armies.map(army => (updatesById.has(army.id) ? { ...army, ...updatesById.get(army.id) } : army));
    };

    let workingArmies = state.armies;
    let workingFleets = fleetsToProcess;

    // 1. Process each fleet
    fleetsToProcess.forEach(fleet => {
        // resolveFleetMovement is pure, returns nextFleet + effects
        const res = resolveFleetMovement(fleet, state.systems, workingArmies, nextDay, ctx.rng, workingFleets);

        workingArmies = applyArmyUpdates(workingArmies, res.armyUpdates);
        workingFleets = workingFleets.map(existing => (existing.id === fleet.id ? res.nextFleet : existing));
        newLogs.push(...res.logs);
    });

    return {
        ...state,
        fleets: workingFleets,
        armies: workingArmies,
        logs: [...state.logs, ...newLogs]
    };
};
