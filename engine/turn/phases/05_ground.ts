
import { GameState, FactionId, AIState, Army, ArmyState } from '../../../types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';
import { COLORS } from '../../../data/static';
import { AI_HOLD_TURNS, createEmptyAIState, getLegacyAiFactionId } from '../../ai';
import { isOrbitContested } from '../../orbit';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
    let nextLogs = [...state.logs];
    let nextAiStates: Record<FactionId, AIState> = { ...(state.aiStates ?? {}) };

    const aiFactionIds = new Set(state.factions.filter(faction => faction.aiProfile).map(faction => faction.id));
    const legacyAiFactionId = getLegacyAiFactionId(state.factions);

    aiFactionIds.forEach(factionId => {
        if (!nextAiStates[factionId]) {
            const legacyState = factionId === legacyAiFactionId ? state.aiState : undefined;
            nextAiStates[factionId] = legacyState ?? createEmptyAIState();
        }
    });

    const holdUpdates: Record<FactionId, string[]> = {};

    // Track armies to remove (destroyed)
    const armiesToDestroyIds = new Set<string>();

    // Track strength/morale updates for surviving armies
    const armyUpdatesMap = new Map<string, { strength: number; morale: number }>();
    
    // 1. Resolve Conflict per Planet
    state.systems.forEach(system => {
        system.planets
            .filter(planet => planet.isSolid)
            .forEach(planet => {
                const result = resolveGroundConflict(planet, system, state);

                if (!result) return;

                result.armiesDestroyed.forEach(id => armiesToDestroyIds.add(id));

                result.armyUpdates.forEach(update => {
                    armyUpdatesMap.set(update.armyId, { strength: update.strength, morale: update.morale });
                });

                result.logs.forEach(txt => {
                    nextLogs.push({
                        id: ctx.rng.id('log'),
                        day: ctx.turn,
                        text: txt,
                        type: 'combat'
                    });
                });
            });
    });

    // 2. Apply accumulated updates then filter destroyed armies
    const patchedArmies = state.armies.map(army => {
        const pending = armyUpdatesMap.get(army.id);

        if (!pending) return army;

        return { ...army, strength: pending.strength, morale: pending.morale };
    });

    const nextArmies: Army[] = patchedArmies.filter(army => !armiesToDestroyIds.has(army.id));

    const nextSystems = state.systems.map(system => ({
        ...system,
        planets: system.planets.map(planet => ({ ...planet }))
    }));

    const planetIndex = new Map<string, { systemId: string; planetId: string }>();
    nextSystems.forEach(system => {
        system.planets.forEach(planet => {
            planetIndex.set(planet.id, { systemId: system.id, planetId: planet.id });
        });
    });

    const armiesByPlanetId = new Map<string, Army[]>();
    nextArmies.forEach(army => {
        if (army.state !== ArmyState.DEPLOYED) return;
        const match = planetIndex.get(army.containerId);
        if (!match) return;
        const list = armiesByPlanetId.get(match.planetId) ?? [];
        list.push(army);
        armiesByPlanetId.set(match.planetId, list);
    });

    const updatedSystems = nextSystems.map(system => {
        const contestedOrbit = isOrbitContested(system, state);

        const updatedPlanets = system.planets.map(planet => {
            const armies = armiesByPlanetId.get(planet.id) ?? [];
            const factionIds = new Set(armies.map(a => a.factionId));
            const ownerFactionId =
                factionIds.size === 1 && !contestedOrbit
                    ? Array.from(factionIds)[0]
                    : planet.ownerFactionId;

            return { ...planet, ownerFactionId };
        });

        const systemFactionIds = new Set<FactionId>();
        updatedPlanets.forEach(planet => {
            if (!planet.isSolid) return;
            const armies = armiesByPlanetId.get(planet.id) ?? [];
            armies.forEach(army => systemFactionIds.add(army.factionId));
        });

        const newOwnerFactionId =
            systemFactionIds.size === 1 && !contestedOrbit
                ? Array.from(systemFactionIds)[0]
                : system.ownerFactionId;
        const ownerChanged = newOwnerFactionId !== system.ownerFactionId;

        if (ownerChanged && newOwnerFactionId && aiFactionIds.has(newOwnerFactionId)) {
            if (!holdUpdates[newOwnerFactionId]) {
                holdUpdates[newOwnerFactionId] = [];
            }
            holdUpdates[newOwnerFactionId].push(system.id);
        }

        const newColor =
            ownerChanged && newOwnerFactionId
                ? state.factions.find(faction => faction.id === newOwnerFactionId)?.color ?? COLORS.star
                : system.color;

        return {
            ...system,
            ownerFactionId: newOwnerFactionId,
            color: newColor,
            planets: updatedPlanets
        };
    });

    if (Object.keys(holdUpdates).length > 0) {
        nextAiStates = { ...nextAiStates };

        Object.entries(holdUpdates).forEach(([factionId, systemIds]) => {
            const existingState: AIState = nextAiStates[factionId] ?? createEmptyAIState();

            const updatedState: AIState = {
                ...existingState,
                holdUntilTurnBySystemId: {
                    ...existingState.holdUntilTurnBySystemId,
                    ...systemIds.reduce<Record<string, number>>((acc, systemId) => {
                        acc[systemId] = ctx.turn + AI_HOLD_TURNS;
                        return acc;
                    }, {})
                }
            };

            nextAiStates[factionId] = updatedState;
        });
    }

    return {
        ...state,
        systems: updatedSystems,
        armies: nextArmies,
        logs: nextLogs,
        aiStates: nextAiStates
    };
};
