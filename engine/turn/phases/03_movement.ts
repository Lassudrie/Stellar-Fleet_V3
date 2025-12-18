
import { GameState, Fleet } from '../../../types';
import { TurnContext } from '../types';
import {
    moveFleet,
    executeArrivalOperations,
    MovementOrdersSnapshot,
    MovementStepResult
} from '../../../services/movement/movementPhase';

export const phaseMovement = (state: GameState, ctx: TurnContext): GameState => {
    const nextDay = ctx.turn; // Movement projects to current turn positions

    const fleetsToProcess = [...state.fleets].sort((a, b) => a.id.localeCompare(b.id));
    const newLogs = [];

    let workingArmies = state.armies;
    let workingFleets = fleetsToProcess;

    const movementResults: MovementStepResult[] = [];

    // First pass: compute final positions for all fleets without arrival operations
    fleetsToProcess.forEach(fleet => {
        const ordersSnapshot: MovementOrdersSnapshot = {
            invasionTargetSystemId: fleet.invasionTargetSystemId ?? null,
            loadTargetSystemId: fleet.loadTargetSystemId ?? null,
            unloadTargetSystemId: fleet.unloadTargetSystemId ?? null
        };

        const moveResult = moveFleet(fleet, state.systems, nextDay, ctx.rng);
        movementResults.push({ ...moveResult, orders: ordersSnapshot });
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

        const arrivalOrders = result.orders ?? {
            invasionTargetSystemId: fleet.invasionTargetSystemId ?? null,
            loadTargetSystemId: fleet.loadTargetSystemId ?? null,
            unloadTargetSystemId: fleet.unloadTargetSystemId ?? null
        };

        const arrivalFleet = {
            ...fleet,
            invasionTargetSystemId: arrivalOrders.invasionTargetSystemId,
            loadTargetSystemId: arrivalOrders.loadTargetSystemId,
            unloadTargetSystemId: arrivalOrders.unloadTargetSystemId
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
