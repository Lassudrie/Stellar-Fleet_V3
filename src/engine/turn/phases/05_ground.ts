
import { GameState, FactionId, AIState, Army, ArmyState, GameMessage } from '../../../shared/types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';
import { COLORS } from '../../../content/data/static';
import { AI_HOLD_TURNS, createEmptyAIState, getLegacyAiFactionId } from '../../ai';
import { canonicalizeMessages } from '../../state/canonicalize';
import { sorted } from '../../../shared/sorting';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
    let nextLogs = [...state.logs];
    let nextMessages = [...state.messages];
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

    // Track initial solid-planet owners for change detection
    const initialPlanetOwners = new Map<string, FactionId | null>();

    // Track ground battle outcomes per planet
    const groundResults = new Map<string, ReturnType<typeof resolveGroundConflict>>();
    
    // 1. Resolve Conflict per Planet
    state.systems.forEach(system => {
        system.planets
            .filter(planet => planet.isSolid)
            .forEach(planet => {
                initialPlanetOwners.set(planet.id, planet.ownerFactionId ?? null);
                const result = resolveGroundConflict(planet, system, state);

                if (!result) return;

                groundResults.set(planet.id, result);
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

    const armiesBySystemId = new Map<string, Army[]>();

    nextArmies.forEach(army => {
        if (army.state !== ArmyState.DEPLOYED) return;
        const match = planetIndex.get(army.containerId);
        if (!match) return;
        const list = armiesBySystemId.get(match.systemId) ?? [];
        list.push(army);
        armiesBySystemId.set(match.systemId, list);
    });

    const updatedSystems = nextSystems.map(system => {
        const armiesInSystem = armiesBySystemId.get(system.id) ?? [];
        const groundFactionIds = sorted(
            Array.from(new Set(armiesInSystem.map(army => army.factionId))),
            (a, b) => a.localeCompare(b)
        );
        const soleGroundFaction = groundFactionIds.length === 1 ? groundFactionIds[0] : null;

        const updatedPlanets = system.planets.map(planet => {
            const armies = armiesByPlanetId.get(planet.id) ?? [];
            const factionIds = new Set(armies.map(a => a.factionId));
            const ownerFromLocalPresence =
                factionIds.size === 1
                    ? Array.from(factionIds)[0]
                    : planet.ownerFactionId;
            const ownerFactionId =
                planet.isSolid && soleGroundFaction
                    ? soleGroundFaction
                    : ownerFromLocalPresence;

            const initialOwner = initialPlanetOwners.get(planet.id) ?? null;
            const ownerChanged = planet.isSolid && ownerFactionId !== initialOwner;

            const shouldNotifyPlanetConquest = ownerChanged && armies.length > 0;

            if (shouldNotifyPlanetConquest) {
                const battleResult = groundResults.get(planet.id);
                const casualtiesByFaction = new Map<FactionId, { strengthLost: number; destroyed: number }>();

                battleResult?.casualties.forEach(entry => {
                    const current = casualtiesByFaction.get(entry.factionId) ?? { strengthLost: 0, destroyed: 0 };
                    casualtiesByFaction.set(entry.factionId, {
                        strengthLost: current.strengthLost + entry.strengthLost,
                        destroyed: current.destroyed + entry.destroyed.length
                    });
                });

                const remainingByFaction = new Map<FactionId, number>();
                armies.forEach(army => {
                    remainingByFaction.set(army.factionId, (remainingByFaction.get(army.factionId) ?? 0) + army.strength);
                });

                const involvedFactionIds = new Set<FactionId>();
                casualtiesByFaction.forEach((_, factionId) => involvedFactionIds.add(factionId));
                remainingByFaction.forEach((_, factionId) => involvedFactionIds.add(factionId));
                [initialOwner, ownerFactionId].forEach(factionId => {
                    if (factionId) involvedFactionIds.add(factionId);
                });

                const formatCasualtiesLine = (): string => {
                    if (casualtiesByFaction.size === 0) return 'Losses - none';
                    const parts = sorted(
                        Array.from(casualtiesByFaction.entries()),
                        ([a], [b]) => a.localeCompare(b)
                    )
                        .map(([factionId, data]) => `${factionId}: ${data.strengthLost} strength (${data.destroyed} destroyed)`);
                    return `Losses - ${parts.join(', ')}`;
                };

                const formatRemainingLine = (): string => {
                    if (remainingByFaction.size === 0) return 'Remaining forces - none';
                    const parts = sorted(
                        Array.from(remainingByFaction.entries()),
                        ([a], [b]) => a.localeCompare(b)
                    )
                        .map(([factionId, totalStrength]) => `${factionId}: ${totalStrength} strength`);
                    return `Remaining forces - ${parts.join(', ')}`;
                };

                const isPlayerInvolved = involvedFactionIds.has(state.playerFactionId);

                const message: GameMessage = {
                    id: ctx.rng.id('msg'),
                    day: ctx.turn,
                    type: 'PLANET_CONQUERED',
                    priority: isPlayerInvolved ? 2 : 1,
                    title: `${planet.name} conquered`,
                    subtitle: `${system.name} • Turn ${ctx.turn}`,
                    lines: [formatCasualtiesLine(), formatRemainingLine()],
                    payload: {
                        planetId: planet.id,
                        systemId: system.id,
                        involvedFactionIds: sorted(Array.from(involvedFactionIds), (a, b) => a.localeCompare(b))
                    },
                    read: false,
                    dismissed: false,
                    createdAtTurn: ctx.turn
                };

                nextMessages = canonicalizeMessages([...nextMessages, message]);
            }

            return { ...planet, ownerFactionId };
        });

        const solidBodies = updatedPlanets.filter(planet => planet.isSolid);
        const uniformSolidOwner = (() => {
            if (solidBodies.length === 0) return null;
            const [firstBody] = solidBodies;
            if (!firstBody.ownerFactionId) return null;

            const sharedOwner = firstBody.ownerFactionId;
            const hasMismatch = solidBodies.some(body => body.ownerFactionId !== sharedOwner);

            return hasMismatch ? null : sharedOwner;
        })();

        const newOwnerFactionId = soleGroundFaction ?? uniformSolidOwner ?? system.ownerFactionId;
        const ownerChanged = newOwnerFactionId !== system.ownerFactionId;
        const solidBodiesHeldByNewOwner = solidBodies.filter(planet => planet.ownerFactionId === newOwnerFactionId);

        if (ownerChanged && newOwnerFactionId && aiFactionIds.has(newOwnerFactionId)) {
            if (!holdUpdates[newOwnerFactionId]) {
                holdUpdates[newOwnerFactionId] = [];
            }
            holdUpdates[newOwnerFactionId].push(system.id);
        }

        if (ownerChanged && newOwnerFactionId) {
            const sortedBodies = sorted(solidBodies, (a, b) => a.name.localeCompare(b.name));
            const involvedFactionIds = new Set<FactionId>([
                system.ownerFactionId,
                newOwnerFactionId
            ].filter((factionId): factionId is FactionId => Boolean(factionId)));

            nextLogs = [
                ...nextLogs,
                {
                    id: ctx.rng.id('log'),
                    day: ctx.turn,
                    text: `System ${system.name} control set to ${newOwnerFactionId} after enemy ground presence was cleared. Solid worlds now held: ${sortedBodies.filter(body => body.ownerFactionId === newOwnerFactionId).map(body => body.name).join(', ') || 'none'}.`,
                    type: 'combat'
                }
            ];

            const isPlayerInvolved =
                newOwnerFactionId === state.playerFactionId || system.ownerFactionId === state.playerFactionId;

            if (isPlayerInvolved) {
                const systemMessage: GameMessage = {
                    id: ctx.rng.id('msg'),
                    day: ctx.turn,
                    type: 'SYSTEM_SECURED',
                    priority: newOwnerFactionId === state.playerFactionId ? 2 : 1,
                    title: `${system.name} secured`,
                    subtitle: `Turn ${ctx.turn}`,
                    lines: [
                        groundFactionIds.length > 0
                            ? `No opposing ground armies remain; ${newOwnerFactionId} holds surface control.`
                            : `${newOwnerFactionId} controls the system following ground resolution.`,
                        `Solid bodies held: ${solidBodiesHeldByNewOwner.map(body => body.name).join(', ') || 'None'}.`
                    ],
                    payload: {
                        systemId: system.id,
                        newOwnerFactionId,
                        involvedFactionIds: sorted(
                            Array.from(new Set<FactionId>([...involvedFactionIds, ...groundFactionIds])),
                            (a, b) => a.localeCompare(b)
                        )
                    },
                    read: false,
                    dismissed: false,
                    createdAtTurn: ctx.turn
                };

                nextMessages = canonicalizeMessages([...nextMessages, systemMessage]);
            }
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
        messages: nextMessages,
        aiStates: nextAiStates
    };
};
