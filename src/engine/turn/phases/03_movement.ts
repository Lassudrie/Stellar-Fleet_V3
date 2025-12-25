
import { GameState, Fleet, LogEntry } from '../../../shared/types';
import { TurnContext } from '../types';
import { moveFleet, executeArrivalOperations, MovementStepResult } from '../../movement/movementPhase';
import { sorted } from '../../../shared/sorting';

export const phaseMovement = (state: GameState, ctx: TurnContext): GameState => {
    const nextDay = ctx.turn; // Movement projects to current turn positions

    const fleetsToProcess = sorted(state.fleets, (a, b) => a.id.localeCompare(b.id));
    const newLogs: LogEntry[] = [];

    let workingArmies = state.armies;
    let workingFleets = fleetsToProcess;

    const movementResults: Array<MovementStepResult & {
        invasionTargetSystemId: string | null;
        loadTargetSystemId: string | null;
        unloadTargetSystemId: string | null;
    }> = [];

    // First pass: compute final positions for all fleets without arrival operations
    fleetsToProcess.forEach(fleet => {
        const moveResult = moveFleet(fleet, state.systems, nextDay, ctx.rng);
        movementResults.push({
            ...moveResult,
            invasionTargetSystemId: fleet.invasionTargetSystemId ?? null,
            loadTargetSystemId: fleet.loadTargetSystemId ?? null,
            unloadTargetSystemId: fleet.unloadTargetSystemId ?? null
        });
        workingFleets = workingFleets.map(existing => (existing.id === fleet.id ? moveResult.fleet : existing));
        newLogs.push(...moveResult.logs);
    });

    // Second pass: execute arrival operations using the fully updated fleet positions
    movementResults.forEach(result => {
        if (!result.arrivalSystemId) return;

        const system = state.systems.find(s => s.id === result.arrivalSystemId);
        if (!system) return;

        const fleet = workingFleets.find(f => f.id === result.fleet.id);
        if (!fleet) return;

        const arrivalFleet: Fleet = {
            ...fleet,
            invasionTargetSystemId: result.invasionTargetSystemId,
            loadTargetSystemId: result.loadTargetSystemId,
            unloadTargetSystemId: result.unloadTargetSystemId
        };

        const arrivalOutcome = executeArrivalOperations(arrivalFleet, system, workingArmies, workingFleets, ctx.rng, nextDay);

        workingArmies = arrivalOutcome.armies;
        workingFleets = workingFleets.map(existing =>
            existing.id === fleet.id
                ? {
                      ...arrivalOutcome.fleet,
                      invasionTargetSystemId: null,
                      loadTargetSystemId: null,
                      unloadTargetSystemId: null
                  }
                : existing
        );
        newLogs.push(...arrivalOutcome.logs);
    });

    return {
        ...state,
        fleets: workingFleets,
        armies: workingArmies,
        logs: [...state.logs, ...newLogs]
    };
};
