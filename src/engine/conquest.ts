
import { GameState, StarSystem, FactionId, ArmyState, Army, PlanetBody } from '../shared/types';
import { sorted } from '../shared/sorting';

export interface GroundBattleResult {
    systemId: string;
    planetId: string;
    winnerFactionId: FactionId | 'draw' | null;
    armiesDestroyed: string[]; // IDs of destroyed armies
    armyUpdates: { armyId: string; members: number; condition: number }[];
    casualties: { factionId: FactionId; membersLost: number; conditionLost: number; destroyed: string[] }[];
    logs: string[];
}

const MAX_CASUALTY_FRACTION_PER_TURN = 0.35;
const CONDITION_LOSS_MULTIPLIER = 0.6;
const MIN_CONDITION_FACTOR = 0.25;
const MAX_CONDITION_FACTOR = 2;

/**
 * Helper to calculate total ground power
 */
const clampConditionFactor = (condition: number): number => {
    return Math.min(MAX_CONDITION_FACTOR, Math.max(MIN_CONDITION_FACTOR, condition));
};

const calculatePower = (armies: Army[]): number => {
    return armies.reduce((sum, army) => sum + army.members * clampConditionFactor(army.condition), 0);
};

const calculateTotalMembers = (armies: Army[]): number => armies.reduce((sum, army) => sum + army.members, 0);

const casualtyFraction = (ownPower: number, enemyPower: number): number => {
    if (ownPower <= 0) return 0;
    const pressure = enemyPower / Math.max(ownPower + enemyPower, 1);
    return Math.min(MAX_CASUALTY_FRACTION_PER_TURN, pressure);
};

interface LossOutcome {
    updates: { armyId: string; members: number; condition: number }[];
    destroyedIds: string[];
    membersLost: number;
    conditionLost: number;
}

const applyLosses = (
    armies: Army[],
    totalMembersLoss: number,
    lossFraction: number
): LossOutcome => {
    if (armies.length === 0) {
        return { updates: [], destroyedIds: [], membersLost: 0, conditionLost: 0 };
    }

    const sortedArmies = sorted(armies, (a, b) => a.id.localeCompare(b.id));
    const totalMembers = calculateTotalMembers(sortedArmies);
    const clampedMembersLoss = Math.max(0, Math.min(totalMembersLoss, totalMembers));
    let remainingLoss = clampedMembersLoss;
    let appliedLoss = 0;
    let conditionLost = 0;
    const updates: { armyId: string; members: number; condition: number }[] = [];
    const destroyedIds: string[] = [];

    sortedArmies.forEach((army, index) => {
        const isLast = index === sortedArmies.length - 1;
        const proportionalLoss = totalMembers > 0 ? Math.floor((clampedMembersLoss * army.members) / totalMembers) : 0;
        const plannedLoss = isLast ? remainingLoss : proportionalLoss;
        const loss = Math.max(0, Math.min(army.members, plannedLoss, remainingLoss));
        const newMembers = Math.max(0, army.members - loss);
        const conditionPenalty = loss > 0 ? lossFraction * CONDITION_LOSS_MULTIPLIER : 0;
        const newCondition = clampConditionFactor(army.condition * (1 - conditionPenalty));

        appliedLoss += army.members - newMembers;
        remainingLoss -= loss;
        conditionLost += Math.max(0, army.condition - newCondition);

        updates.push({ armyId: army.id, members: newMembers, condition: newCondition });
        if (newMembers === 0 || newCondition < 0.20) {
            destroyedIds.push(army.id);
        }
    });

    return { updates, destroyedIds, membersLost: appliedLoss, conditionLost };
};

/**
 * Resolves ground combat for a specific system (V3: Morale-weighted power & proportional attrition).
 *
 * Rules:
 * - Effective power = strength × morale factor (clamped for stability).
 * - Each side suffers proportional losses capped per turn, applied across armies.
 * - Surviving armies update strength and morale; units below the destruction threshold are removed.
 * - Conquest only triggers when one faction retains armies above the threshold and the opponent has none.
 */
export const resolveGroundConflict = (planet: PlanetBody, system: StarSystem, state: GameState): GroundBattleResult | null => {
    // 1. Gather Forces
    const armiesOnGround = state.armies.filter(a =>
        a.containerId === planet.id &&
        a.state === ArmyState.DEPLOYED
    );

    if (armiesOnGround.length === 0) return null;

    const armiesByFaction = armiesOnGround.reduce<Map<FactionId, Army[]>>((map, army) => {
        const current = map.get(army.factionId) ?? [];
        current.push(army);
        map.set(army.factionId, current);
        return map;
    }, new Map());

    const defendingFactionId = (() => {
        const planetOwner = planet.ownerFactionId ?? null;

        if (!planetOwner) {
            return null;
        }

        if (!armiesByFaction.has(planetOwner)) {
            return null;
        }

        return planetOwner;
    })();
    const attackingFactions = defendingFactionId
        ? Array.from(armiesByFaction.keys()).filter(factionId => factionId !== defendingFactionId)
        : [];
    const battleMode: 'coalition_vs_defender' | 'free_for_all' =
        defendingFactionId && attackingFactions.length > 0 ? 'coalition_vs_defender' : 'free_for_all';

    // 2. Identify Conflict Type
    let winnerFactionId: FactionId | 'draw' | null = null;
    const armiesToDestroy: string[] = [];
    let logText = '';
    let armyUpdates: { armyId: string; members: number; condition: number }[] = [];
    let casualties: { factionId: FactionId; membersLost: number; conditionLost: number; destroyed: string[] }[] = [];

    const getFactionLabel = (factionId: FactionId): string => {
        const faction = state.factions.find(f => f.id === factionId);
        return faction?.name ?? factionId.toUpperCase();
    };

    if (armiesByFaction.size === 1) {
        const soleFactionResult = armiesByFaction.keys().next();
        if (soleFactionResult.done || !soleFactionResult.value) {
            // Safety guard: should never happen given size === 1, but prevents crash
            console.error('[Conquest] CRITICAL: armiesByFaction.size === 1 but iterator returned empty. Planet:', planet.id, 'System:', system.id);
            return null;
        }
        const soleFaction = soleFactionResult.value as FactionId;
        winnerFactionId = soleFaction;
        logText = `Planet ${planet.name} secured by ${getFactionLabel(soleFaction)} ground forces (unopposed).`;
        casualties = [{ factionId: soleFaction, membersLost: 0, conditionLost: 0, destroyed: [] }];
    } else {
        // Case B: Active Combat (rule depends on defender presence)
        const factionOutcomes = new Map<FactionId, LossOutcome>();
        const factionPowers = new Map<FactionId, number>();
        const factionMembers = new Map<FactionId, number>();

        armiesByFaction.forEach((factionArmies, factionId) => {
            factionPowers.set(factionId, calculatePower(factionArmies));
            factionMembers.set(factionId, calculateTotalMembers(factionArmies));
        });

        const getEnemyFactions = (factionId: FactionId): FactionId[] => {
            if (battleMode === 'coalition_vs_defender' && defendingFactionId) {
                if (factionId === defendingFactionId) return attackingFactions;
                return [defendingFactionId];
            }

            return Array.from(armiesByFaction.keys()).filter(otherId => otherId !== factionId);
        };

        armiesByFaction.forEach((factionArmies, factionId) => {
            const power = factionPowers.get(factionId) ?? 0;
            const members = factionMembers.get(factionId) ?? 0;
            const enemyPower = getEnemyFactions(factionId).reduce((sum, enemyId) => {
                return sum + (factionPowers.get(enemyId) ?? 0);
            }, 0);
            const lossFraction = casualtyFraction(power, enemyPower);
            const membersLoss = Math.floor(members * lossFraction);

            const outcome = applyLosses(factionArmies, membersLoss, lossFraction);
            factionOutcomes.set(factionId, outcome);
        });

        const survivorsByFaction = new Map<FactionId, { updates: { armyId: string; members: number; condition: number }[] }>();
        const originalArmiesById = new Map(armiesOnGround.map(army => [army.id, army]));

        factionOutcomes.forEach((outcome, factionId) => {
        const survivors = outcome.updates.filter(update => update.members > 0 && update.condition >= 0.20);
        survivorsByFaction.set(factionId, { updates: survivors });

            armiesToDestroy.push(...outcome.destroyedIds);
            armyUpdates.push(...outcome.updates);
            casualties.push({
                factionId,
                membersLost: outcome.membersLost,
                conditionLost: outcome.conditionLost,
                destroyed: outcome.destroyedIds
            });
        });

        const survivingPowers: { factionId: FactionId; remainingPower: number }[] = [];

        survivorsByFaction.forEach((survivors, factionId) => {
            if (survivors.updates.length === 0) return;

            const reconstructedArmies: Army[] = survivors.updates.map(update => {
                const baseArmy = originalArmiesById.get(update.armyId);
                return baseArmy
                    ? { ...baseArmy, members: update.members, condition: update.condition }
                    : {
                        id: update.armyId,
                        factionId,
                        unitType: 'mechanized_infantry',
                        maxMembers: update.members,
                        members: update.members,
                        attack: 1,
                        defense: 1,
                        condition: update.condition,
                        state: ArmyState.DEPLOYED,
                        containerId: planet.id
                      };
            });

            survivingPowers.push({ factionId, remainingPower: calculatePower(reconstructedArmies) });
        });

        const defendersRemainingPower = defendingFactionId
            ? survivingPowers
                .filter(entry => entry.factionId === defendingFactionId)
                .reduce((sum, entry) => sum + entry.remainingPower, 0)
            : 0;
        const attackersRemainingPower = battleMode === 'coalition_vs_defender'
            ? survivingPowers
                .filter(entry => entry.factionId !== defendingFactionId)
                .reduce((sum, entry) => sum + entry.remainingPower, 0)
            : 0;

        if (battleMode === 'coalition_vs_defender' && defendingFactionId) {
            if (attackersRemainingPower === 0 && defendersRemainingPower === 0) {
                winnerFactionId = null;
            } else if (Math.abs(attackersRemainingPower - defendersRemainingPower) < 1e-6) {
                winnerFactionId = 'draw';
            } else if (attackersRemainingPower > defendersRemainingPower) {
                const topAttacker = sorted(
                  survivingPowers.filter(entry => entry.factionId !== defendingFactionId),
                  (a, b) => b.remainingPower - a.remainingPower
                )[0];
                winnerFactionId = topAttacker?.factionId ?? null;
            } else {
                winnerFactionId = defendingFactionId;
            }
        } else {
            if (survivingPowers.length === 0) {
                winnerFactionId = null;
            } else {
                const survivingPowersByStrength = sorted(
                  survivingPowers,
                  (a, b) => b.remainingPower - a.remainingPower
                );
                const [top, second] = survivingPowersByStrength;
                if (second && Math.abs(top.remainingPower - second.remainingPower) < 1e-6) {
                    winnerFactionId = 'draw';
                } else {
                    winnerFactionId = top.factionId;
                }
            }
        }

        const outcomeLabel =
            winnerFactionId === null
                ? 'mutual destruction'
                : winnerFactionId === 'draw'
                    ? 'stalemate'
                    : `${getFactionLabel(winnerFactionId)} leads`;

        const survivorsText = survivingPowers
            .map(entry => `${getFactionLabel(entry.factionId)} ${entry.remainingPower.toFixed(0)} power`)
            .join(', ');

        const ruleDescription =
            battleMode === 'coalition_vs_defender'
                ? 'attacker coalition vs defender (attackers cooperate; strongest surviving attacker claims the conquest; defender keeps control on ties)'
                : 'free-for-all (everyone fights everyone else; highest remaining ground power wins; ties are stalemates; no survivors neutralize the site)';

        logText = `Ground battle at ${planet.name} (${system.name}) resolved as ${ruleDescription}. Outcome: ${outcomeLabel}.`;
        if (survivorsText.length > 0) {
            logText += ` Remaining power: ${survivorsText}.`;
        }

        if (casualties.length > 0) {
            const lossSummary = casualties
                .map(entry => `${getFactionLabel(entry.factionId)} lost ${entry.membersLost} members (${entry.destroyed.length} units destroyed)`)
                .join(', ');
            logText += ` Losses - ${lossSummary}.`;
        }
    }

    const unopposed = armiesByFaction.size === 1;
    const hasUpdates = armyUpdates.length > 0 || armiesToDestroy.length > 0;

    if (!hasUpdates && unopposed) {
        return null;
    }

    return {
        systemId: system.id,
        planetId: planet.id,
        winnerFactionId,
        armiesDestroyed: armiesToDestroy,
        armyUpdates,
        casualties,
        logs: [logText]
    };
};
