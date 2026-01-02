
import { AIState, Army, ArmyState, FactionId, GameMessage, GameState, HexCoord } from '../../../shared/types';
import { COLORS } from '../../../content/data/static';
import { AI_HOLD_TURNS, createEmptyAIState, getLegacyAiFactionId } from '../../ai';
import { canonicalizeMessages } from '../../state/canonicalize';
import { sorted } from '../../../shared/sorting';
import { generateSurfaceMapForState } from '../../planetSurface/access';
import { neighborsAxial } from '../../planetSurface/hex';
import { isPassable, relocateSurfacePosDeterministic } from '../../planetSurface/validation';
import { deriveTerrainType } from '../../ground/terrain';
import { computeSupplyDistanceMapForBody, SUPPLY_RADIUS } from '../../ground/supply';
import { computeZocSnapshotForBody } from '../../ground/zoc';
import { executeMoveOrder } from '../../ground/movement';
import { resolveEngagement } from '../../ground/combat';
import { applyOverrunPenalty, chooseDefenderRetreat } from '../../ground/breakOutcome';
import { hexKey } from '../../ground/utils';
import { TurnContext } from '../types';

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

    // --- Ground Surface Combat V1 (map-based) ---

    const outOfCombat = (army: Army): boolean => army.members === 0 || army.condition < 0.20;

    const bodyIndex = new Map<string, { systemId: string; bodyId: string }>();
    state.systems.forEach(system => {
        system.planets.forEach(body => {
            if (!body.isSolid) return;
            bodyIndex.set(body.id, { systemId: system.id, bodyId: body.id });
        });
    });

    const deployedArmies = state.armies.filter(a => a.state === ArmyState.DEPLOYED && bodyIndex.has(a.containerId));
    const armiesByBodyId = deployedArmies.reduce<Map<string, Army[]>>((acc, army) => {
        const list = acc.get(army.containerId) ?? [];
        list.push(army);
        acc.set(army.containerId, list);
        return acc;
    }, new Map());

    const initialBodyOwners = new Map<string, FactionId | null>();
    state.systems.forEach(system => {
        system.planets.forEach(body => {
            if (!body.isSolid) return;
            initialBodyOwners.set(body.id, body.ownerFactionId ?? null);
        });
    });

    // Transient movement stats needed for attack situation flags
    const moveStatsByArmyId = new Map<string, { mpEff: number; mpUsedCenti: number; used75pct: boolean; supplied: boolean }>();

    // Patch armies incrementally via a map (structural sharing at the end)
    const armiesById = new Map(state.armies.map(a => [a.id, a]));
    const removeArmyIds = new Set<string>();

    // Execute per body to localize caches (surfaceMap, supply, occupancy)
    const bodyIds = sorted(Array.from(armiesByBodyId.keys()), (a, b) => a.localeCompare(b));

    bodyIds.forEach(bodyId => {
        const bodyArmies = sorted(armiesByBodyId.get(bodyId) ?? [], (a, b) => a.id.localeCompare(b.id));
        const surfaceMap = generateSurfaceMapForState(state, bodyId);
        if (!surfaceMap) return;
        const { w, h, wrapX } = surfaceMap.descriptor.config;

        // --- Pre-cleanup: remove already-out-of-combat units so they don't block movement/retreat/ownership ---
        bodyArmies.forEach(armyBase => {
            const current = armiesById.get(armyBase.id) ?? armyBase;
            if (removeArmyIds.has(current.id)) return;
            if (current.state !== ArmyState.DEPLOYED) return;
            if (current.containerId !== bodyId) return;
            if (!current.surfacePos) return;
            if (outOfCombat(current)) {
                removeArmyIds.add(current.id);
            }
        });

        const bodyArmiesLive = bodyArmies
            .map(a => armiesById.get(a.id) ?? a)
            .filter(a => a.state === ArmyState.DEPLOYED && a.containerId === bodyId && a.surfacePos && !removeArmyIds.has(a.id));

        // --- Occupancy (no stacking) with deterministic destacking ---
        const occupancy = new Map<string, string>(); // hexKey -> armyId
        const stacks = new Map<string, string[]>(); // hexKey -> armyIds
        const originByKey = new Map<string, HexCoord>();
        bodyArmiesLive.forEach(army => {
            if (!army.surfacePos) return;
            const origin: HexCoord = { q: army.surfacePos.q, r: army.surfacePos.r };
            const key = hexKey(origin);
            const ids = stacks.get(key) ?? [];
            ids.push(army.id);
            stacks.set(key, ids);
            if (!originByKey.has(key)) originByKey.set(key, origin);
        });

        // Place primary occupant per hex (lexicographically smallest id)
        stacks.forEach((ids, key) => {
            ids.sort((a, b) => a.localeCompare(b));
            occupancy.set(key, ids[0]);
        });

        const isOccupied = (coord: HexCoord): boolean => occupancy.has(hexKey(coord));
        const deleteIfMatches = (coord: HexCoord, armyId: string): void => {
            const key = hexKey(coord);
            if (occupancy.get(key) === armyId) occupancy.delete(key);
        };

        // Resolve stacks by relocating non-primary occupants to the nearest free passable tile.
        stacks.forEach((ids, key) => {
            if (ids.length <= 1) return;
            ids.sort((a, b) => a.localeCompare(b));
            const origin = originByKey.get(key);
            if (!origin) return;
            const extras = ids.slice(1);
            extras.forEach(extraId => {
                const relocated = relocateSurfacePosDeterministic({
                    state,
                    entityId: extraId,
                    kind: 'army',
                    bodyId,
                    origin,
                    predicate: (biome) => isPassable(biome),
                    isOccupied: (q, r) => occupancy.has(hexKey({ q, r }))
                });

                if (!relocated) {
                    removeArmyIds.add(extraId);
                    nextLogs.push({
                        id: ctx.rng.id('log'),
                        day: ctx.turn,
                        type: 'info',
                        text: `[SYSTEM] Ground stacking on ${bodyId} at (${origin.q},${origin.r}) could not be resolved; removing ${extraId}.`
                    });
                    return;
                }

                const extraArmy = armiesById.get(extraId);
                if (extraArmy && extraArmy.surfacePos) {
                    armiesById.set(extraId, {
                        ...extraArmy,
                        surfacePos: { bodyId, q: relocated.q, r: relocated.r }
                    });
                }
                occupancy.set(hexKey(relocated), extraId);
                nextLogs.push({
                    id: ctx.rng.id('log'),
                    day: ctx.turn,
                    type: 'info',
                    text: `[SYSTEM] Ground stacking resolved on ${bodyId} at (${origin.q},${origin.r}): relocated ${extraId} to (${relocated.q},${relocated.r}).`
                });
            });
        });

        // Stable per-body list after stacking resolution/removals
        const bodyArmiesResolved = sorted(
            bodyArmies
                .map(a => armiesById.get(a.id) ?? a)
                .filter(a => a.state === ArmyState.DEPLOYED && a.containerId === bodyId && a.surfacePos && !removeArmyIds.has(a.id)),
            (a, b) => a.id.localeCompare(b.id)
        );

        // --- Supply maps per faction involved on this body ---
        const factionIdsOnBody = sorted(
            Array.from(new Set(bodyArmiesResolved.map(a => a.factionId))),
            (a, b) => a.localeCompare(b)
        );
        const supplyByFaction = new Map<FactionId, Uint16Array | null>();
        factionIdsOnBody.forEach(fid => {
            supplyByFaction.set(fid, computeSupplyDistanceMapForBody(state, bodyId, fid));
        });
        const isArmySupplied = (army: Army): boolean => {
            if (!army.surfacePos) return false;
            const dist = supplyByFaction.get(army.factionId);
            if (!dist) return false;
            const idx = army.surfacePos.r * w + army.surfacePos.q;
            const d = dist[idx] ?? 0xffff;
            return d <= SUPPLY_RADIUS;
        };

        // Snapshot ZOC before movement
        const zocPre = computeZocSnapshotForBody(state, bodyId, bodyArmiesResolved) ?? null;

        // --- Execute move orders ---
        bodyArmiesResolved.forEach(army => {
            if (!army.surfacePos) return;
            if (removeArmyIds.has(army.id)) return;
            const current = armiesById.get(army.id) ?? army;
            if (!current.surfacePos) return;
            if (current.groundOrder?.type !== 'move') return;
            if (outOfCombat(current)) return;

            const supplied = isArmySupplied(current);
            // Remove self from occupancy before pathing
            deleteIfMatches({ q: current.surfacePos.q, r: current.surfacePos.r }, current.id);

            const target: HexCoord = { q: current.groundOrder.to.q, r: current.groundOrder.to.r };
            const result = executeMoveOrder({
                state,
                army: current,
                to: target,
                supplied,
                zocSnapshot: zocPre,
                isOccupied
            });

            const updatedArmy = result.updatedArmy;
            armiesById.set(updatedArmy.id, updatedArmy);
            moveStatsByArmyId.set(updatedArmy.id, {
                mpEff: result.mpEff,
                mpUsedCenti: result.mpUsedCenti,
                used75pct: result.used75pct,
                supplied
            });

            // If the unit became out-of-combat due to fatigue, remove it immediately.
            if (outOfCombat(updatedArmy)) {
                removeArmyIds.add(updatedArmy.id);
                return;
            }

            // Re-add occupancy at final position (or original if no move)
            const finalPos = updatedArmy.surfacePos ?? current.surfacePos;
            occupancy.set(hexKey({ q: finalPos.q, r: finalPos.r }), updatedArmy.id);

            if (result.moved) {
                nextLogs.push({
                    id: ctx.rng.id('log'),
                    day: ctx.turn,
                    type: 'move',
                    text: `Ground unit ${current.id} moved ${result.steps} hexes on ${bodyId} (fatigue -${result.fatigueDelta.toFixed(2)} C).`
                });
            }
        });

        // Snapshot ZOC after movement (used for retreat heuristics)
        const postMoveArmies = bodyArmiesResolved
            .map(a => armiesById.get(a.id) ?? a)
            .filter(
                a =>
                    a.state === ArmyState.DEPLOYED &&
                    a.containerId === bodyId &&
                    a.surfacePos &&
                    !removeArmyIds.has(a.id)
            );
        const zocPost = computeZocSnapshotForBody(state, bodyId, postMoveArmies) ?? null;

        // --- Execute attack orders ---
        const attackers = sorted(
            postMoveArmies.filter(a => a.groundOrder?.type === 'attack'),
            (a, b) => a.id.localeCompare(b.id)
        );

        const isAdjacent = (a: HexCoord, b: HexCoord): boolean => {
            const ns = neighborsAxial(a, w, h, wrapX);
            return ns.some(n => n.q === b.q && n.r === b.r);
        };

        attackers.forEach(attackerBase => {
            const attacker = armiesById.get(attackerBase.id);
            if (!attacker || !attacker.surfacePos) return;
            if (removeArmyIds.has(attacker.id)) return;
            if (outOfCombat(attacker)) return;
            if (attacker.condition < 0.4) return;

            const targetId = attacker.groundOrder?.type === 'attack' ? attacker.groundOrder.targetArmyId : null;
            if (!targetId) return;
            const defender = armiesById.get(targetId);
            if (!defender || defender.state !== ArmyState.DEPLOYED || defender.containerId !== bodyId || !defender.surfacePos) return;
            if (removeArmyIds.has(defender.id)) return;
            if (attacker.factionId === defender.factionId) return;
            if (!isAdjacent({ q: attacker.surfacePos.q, r: attacker.surfacePos.r }, { q: defender.surfacePos.q, r: defender.surfacePos.r })) return;

            const defenderHex: HexCoord = { q: defender.surfacePos.q, r: defender.surfacePos.r };
            const terrainType = deriveTerrainType(state, bodyId, defenderHex);

            const aMove = moveStatsByArmyId.get(attacker.id);
            const aSupplied = aMove?.supplied ?? isArmySupplied(attacker);
            const dSupplied = isArmySupplied(defender);

            const engagement = resolveEngagement(attacker, defender, {
                turn: ctx.turn,
                terrainType,
                attackerSituation: { spent75pctMp: aMove?.used75pct ?? false },
                defenderSituation: {},
                attackerStatus: { outOfSupply: !aSupplied },
                defenderStatus: { outOfSupply: !dSupplied }
            });

            let attackerAfter = engagement.attackerAfter;
            let defenderAfter = engagement.defenderAfter;

            // Apply break outcome (defender)
            const defenderStartKey = hexKey(defenderHex);

            if (engagement.defenderBroke && !outOfCombat(defenderAfter)) {
                const outcome = chooseDefenderRetreat({
                    state,
                    defender: defenderAfter,
                    from: defenderHex,
                    zocSnapshot: zocPost,
                    isOccupied
                });
                if (outcome.type === 'retreat') {
                    // Free defender origin and occupy retreat destination.
                    deleteIfMatches(defenderHex, defenderAfter.id);
                    defenderAfter = {
                        ...defenderAfter,
                        surfacePos: { bodyId, q: outcome.to.q, r: outcome.to.r }
                    };
                    occupancy.set(hexKey(outcome.to), defenderAfter.id);
                } else {
                    defenderAfter = applyOverrunPenalty(defenderAfter);
                }
            }

            // Advance (MVP): if defender left hex, attacker may advance into it
            const defenderNowKey = defenderAfter.surfacePos ? hexKey({ q: defenderAfter.surfacePos.q, r: defenderAfter.surfacePos.r }) : null;
            const defenderLeftHex = defenderNowKey !== null && defenderNowKey !== defenderStartKey;
            if (defenderLeftHex && !outOfCombat(attackerAfter)) {
                const attackerFrom = { q: attacker.surfacePos.q, r: attacker.surfacePos.r };
                // If defenderStart is now free, advance
                if (!occupancy.get(defenderStartKey)) {
                    deleteIfMatches(attackerFrom, attackerAfter.id);
                    occupancy.set(defenderStartKey, attackerAfter.id);
                    attackerAfter = {
                        ...attackerAfter,
                        surfacePos: { bodyId, q: defenderHex.q, r: defenderHex.r }
                    };
                }
            }

            armiesById.set(attackerAfter.id, attackerAfter);
            armiesById.set(defenderAfter.id, defenderAfter);

            if (outOfCombat(attackerAfter)) {
                removeArmyIds.add(attackerAfter.id);
                if (attackerAfter.surfacePos) deleteIfMatches({ q: attackerAfter.surfacePos.q, r: attackerAfter.surfacePos.r }, attackerAfter.id);
            }
            if (outOfCombat(defenderAfter)) {
                removeArmyIds.add(defenderAfter.id);
                if (defenderAfter.surfacePos) deleteIfMatches({ q: defenderAfter.surfacePos.q, r: defenderAfter.surfacePos.r }, defenderAfter.id);
            }

            nextLogs.push({
                id: ctx.rng.id('log'),
                day: ctx.turn,
                type: 'combat',
                text: `Ground combat on ${bodyId} (${terrainType}): ${attacker.id} vs ${defender.id} R=${engagement.r.toFixed(2)}; losses A=${engagement.lossesAtt}, D=${engagement.lossesDef}; break=${engagement.defenderBroke ? 'yes' : 'no'}.`
            });
        });
    });

    const nextArmies: Army[] = state.armies
        .map(a => armiesById.get(a.id) ?? a)
        .map(a => ({ ...a, groundOrder: undefined })) // clear orders each turn
        .filter(a => !removeArmyIds.has(a.id));

    const nextSystems = state.systems.map(system => ({
        ...system,
        planets: system.planets.map(planet => ({ ...planet }))
    }));

    const planetIndex = new Map<string, { systemId: string; bodyId: string }>();
    nextSystems.forEach(system => {
        system.planets.forEach(body => {
            planetIndex.set(body.id, { systemId: system.id, bodyId: body.id });
        });
    });

    const armiesByBodyIdAfter = new Map<string, Army[]>();
    const armiesBySystemId = new Map<string, Army[]>();

    nextArmies.forEach(army => {
        if (army.state !== ArmyState.DEPLOYED) return;
        const match = planetIndex.get(army.containerId);
        if (!match) return;
        const listBody = armiesByBodyIdAfter.get(match.bodyId) ?? [];
        listBody.push(army);
        armiesByBodyIdAfter.set(match.bodyId, listBody);
        const listSys = armiesBySystemId.get(match.systemId) ?? [];
        listSys.push(army);
        armiesBySystemId.set(match.systemId, listSys);
    });

    const updatedSystems = nextSystems.map(system => {
        const armiesInSystem = armiesBySystemId.get(system.id) ?? [];
        const groundFactionIds = sorted(
            Array.from(new Set(armiesInSystem.map(army => army.factionId))),
            (a, b) => a.localeCompare(b)
        );
        const soleGroundFaction = groundFactionIds.length === 1 ? groundFactionIds[0] : null;

        const updatedPlanets = system.planets.map(body => {
            if (!body.isSolid) return body;
            const armies = armiesByBodyIdAfter.get(body.id) ?? [];
            const factionIds = new Set(armies.map(a => a.factionId));
            const ownerFromLocalPresence =
                factionIds.size === 1 && armies.length > 0
                    ? Array.from(factionIds)[0]
                    : body.ownerFactionId;
            const ownerFactionId =
                soleGroundFaction
                    ? soleGroundFaction
                    : ownerFromLocalPresence;

            const initialOwner = initialBodyOwners.get(body.id) ?? null;
            const ownerChanged = ownerFactionId !== initialOwner;
            const shouldNotify = ownerChanged && armies.length > 0;

            if (shouldNotify) {
                const remainingByFaction = new Map<FactionId, number>();
                armies.forEach(army => {
                    remainingByFaction.set(army.factionId, (remainingByFaction.get(army.factionId) ?? 0) + army.members);
                });
                const involvedFactionIds = new Set<FactionId>();
                remainingByFaction.forEach((_, factionId) => involvedFactionIds.add(factionId));
                [initialOwner, ownerFactionId].forEach(fid => { if (fid) involvedFactionIds.add(fid); });

                const formatRemainingLine = (): string => {
                    if (remainingByFaction.size === 0) return 'Remaining forces - none';
                    const parts = sorted(
                        Array.from(remainingByFaction.entries()),
                        ([a], [b]) => a.localeCompare(b)
                    ).map(([factionId, totalMembers]) => `${factionId}: ${totalMembers} members`);
                    return `Remaining forces - ${parts.join(', ')}`;
                };

                const isPlayerInvolved = involvedFactionIds.has(state.playerFactionId);
                const message: GameMessage = {
                    id: ctx.rng.id('msg'),
                    day: ctx.turn,
                    type: 'PLANET_CONQUERED',
                    priority: isPlayerInvolved ? 2 : 1,
                    title: `${body.name} conquered`,
                    subtitle: `${system.name} • Turn ${ctx.turn}`,
                    lines: ['Losses - see combat log', formatRemainingLine()],
                    payload: {
                        planetId: body.id,
                        systemId: system.id,
                        involvedFactionIds: sorted(Array.from(involvedFactionIds), (a, b) => a.localeCompare(b))
                    },
                    read: false,
                    dismissed: false,
                    createdAtTurn: ctx.turn
                };
                nextMessages = canonicalizeMessages([...nextMessages, message]);
            }

            return { ...body, ownerFactionId };
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
