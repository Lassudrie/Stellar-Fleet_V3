
import { GameState, StarSystem, FactionId, ArmyState, Army } from '../types';
import { COLORS, CAPTURE_RANGE } from '../data/static';
import { ARMY_DESTROY_THRESHOLD, MIN_ARMY_CREATION_STRENGTH } from './army';
import { Vec3 } from './math/vec3';
import { isOrbitContested } from './orbit';

export interface GroundBattleResult {
    systemId: string;
    winnerFactionId: FactionId | 'draw' | null;
    conquestOccurred: boolean;
    armiesDestroyed: string[]; // IDs of destroyed armies
    armyUpdates: { armyId: string; strength: number; morale: number }[];
    casualties: { factionId: FactionId; strengthLost: number; moraleLost: number; destroyed: string[] }[];
    logs: string[];
}

const MAX_CASUALTY_FRACTION_PER_TURN = 0.35;
const MORALE_LOSS_MULTIPLIER = 0.6;
const MIN_MORALE_FACTOR = 0.25;
const MAX_MORALE_FACTOR = 2;

const buildDestructionThresholdMap = (entries: { armyId: string; threshold: number }[]): Map<string, number> => {
    return new Map(entries.map(entry => [entry.armyId, entry.threshold]));
};

/**
 * Helper to calculate total ground power
 */
const clampMoraleFactor = (morale: number): number => {
    return Math.min(MAX_MORALE_FACTOR, Math.max(MIN_MORALE_FACTOR, morale));
};

const calculatePower = (armies: Army[]): number => {
    return armies.reduce((sum, army) => sum + army.strength * clampMoraleFactor(army.morale), 0);
};

const calculateTotalStrength = (armies: Army[]): number => armies.reduce((sum, army) => sum + army.strength, 0);

const casualtyFraction = (ownPower: number, enemyPower: number): number => {
    if (ownPower <= 0) return 0;
    const pressure = enemyPower / Math.max(ownPower + enemyPower, 1);
    return Math.min(MAX_CASUALTY_FRACTION_PER_TURN, pressure);
};

interface LossOutcome {
    updates: { armyId: string; strength: number; morale: number }[];
    destroyedIds: string[];
    strengthLost: number;
    moraleLost: number;
    thresholds: { armyId: string; threshold: number }[];
}

const applyLosses = (
    armies: Army[],
    totalStrengthLoss: number,
    lossFraction: number
): LossOutcome => {
    if (armies.length === 0) {
        return { updates: [], destroyedIds: [], strengthLost: 0, moraleLost: 0, thresholds: [] };
    }

    if (totalStrengthLoss <= 0) {
        const thresholds = armies.map(army => ({ armyId: army.id, threshold: ARMY_DESTROY_THRESHOLD(army.maxStrength) }));
        const strengthById = new Map(armies.map(army => [army.id, army.strength]));
        const destroyedIds = thresholds
            .filter(({ armyId, threshold }) => (strengthById.get(armyId) ?? 0) <= threshold)
            .map(entry => entry.armyId);

        const updates = armies.map(army => ({ armyId: army.id, strength: army.strength, morale: army.morale }));

        return {
            updates,
            destroyedIds,
            strengthLost: 0,
            moraleLost: 0,
            thresholds
        };
    }

    const sortedArmies = [...armies].sort((a, b) => a.id.localeCompare(b.id));
    const totalStrength = calculateTotalStrength(sortedArmies);
    let remainingLoss = Math.min(totalStrengthLoss, totalStrength);
    let appliedLoss = 0;
    let moraleLost = 0;
    const updates: { armyId: string; strength: number; morale: number }[] = [];
    const destroyedIds: string[] = [];
    const thresholds: { armyId: string; threshold: number }[] = [];

    sortedArmies.forEach((army, index) => {
        if (remainingLoss <= 0) {
            updates.push({ armyId: army.id, strength: army.strength, morale: army.morale });
            return;
        }

        const isLast = index === sortedArmies.length - 1;
        const proportionalLoss = isLast ? remainingLoss : Math.floor((totalStrengthLoss * army.strength) / totalStrength);
        const loss = Math.min(army.strength, Math.max(0, proportionalLoss));
        const newStrength = Math.max(0, army.strength - loss);
        const moralePenalty = lossFraction * MORALE_LOSS_MULTIPLIER;
        const newMorale = clampMoraleFactor(army.morale * (1 - moralePenalty));
        const destructionThreshold = ARMY_DESTROY_THRESHOLD(army.maxStrength);

        appliedLoss += army.strength - newStrength;
        remainingLoss -= loss;
        moraleLost += Math.max(0, army.morale - newMorale);

        updates.push({ armyId: army.id, strength: newStrength, morale: newMorale });
        thresholds.push({ armyId: army.id, threshold: destructionThreshold });
        if (newStrength <= destructionThreshold) {
            destroyedIds.push(army.id);
        }
    });

    return { updates, destroyedIds, strengthLost: appliedLoss, moraleLost, thresholds };
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
export const resolveGroundConflict = (system: StarSystem, state: GameState): GroundBattleResult | null => {
    // 1. Gather Forces
    const armiesOnGround = state.armies.filter(a =>
        a.containerId === system.id &&
        a.state === ArmyState.DEPLOYED
    );

    if (armiesOnGround.length === 0) return null;

    const armiesByFaction = armiesOnGround.reduce<Map<FactionId, Army[]>>((map, army) => {
        const current = map.get(army.factionId) ?? [];
        current.push(army);
        map.set(army.factionId, current);
        return map;
    }, new Map());

    const defendingFactionId =
        system.ownerFactionId && armiesByFaction.has(system.ownerFactionId) ? system.ownerFactionId : null;
    const attackingFactions = defendingFactionId
        ? Array.from(armiesByFaction.keys()).filter(factionId => factionId !== defendingFactionId)
        : [];
    const battleMode: 'coalition_vs_defender' | 'free_for_all' =
        defendingFactionId && attackingFactions.length > 0 ? 'coalition_vs_defender' : 'free_for_all';

    // 2. Identify Conflict Type
    let winnerFactionId: FactionId | 'draw' | null = null;
    const armiesToDestroy: string[] = [];
    let logText = '';
    let armyUpdates: { armyId: string; strength: number; morale: number }[] = [];
    let casualties: { factionId: FactionId; strengthLost: number; moraleLost: number; destroyed: string[] }[] = [];

    const getFactionLabel = (factionId: FactionId): string => {
        const faction = state.factions.find(f => f.id === factionId);
        return faction?.name ?? factionId.toUpperCase();
    };

    if (armiesByFaction.size === 1) {
        const soleFactionResult = armiesByFaction.keys().next();
        if (soleFactionResult.done || !soleFactionResult.value) {
            // Safety guard: should never happen given size === 1, but prevents crash
            return null;
        }
        const soleFaction = soleFactionResult.value as FactionId;
        winnerFactionId = soleFaction;
        logText = `System ${system.name} secured by ${getFactionLabel(soleFaction)} ground forces (unopposed).`;
        casualties = [{ factionId: soleFaction, strengthLost: 0, moraleLost: 0, destroyed: [] }];
    } else {
        // Case B: Active Combat (rule depends on defender presence)
        const factionOutcomes = new Map<FactionId, LossOutcome>();
        const factionThresholds = new Map<FactionId, Map<string, number>>();
        const factionPowers = new Map<FactionId, number>();
        const factionStrengths = new Map<FactionId, number>();

        armiesByFaction.forEach((factionArmies, factionId) => {
            factionPowers.set(factionId, calculatePower(factionArmies));
            factionStrengths.set(factionId, calculateTotalStrength(factionArmies));
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
            const strength = factionStrengths.get(factionId) ?? 0;
            const enemyPower = getEnemyFactions(factionId).reduce((sum, enemyId) => {
                return sum + (factionPowers.get(enemyId) ?? 0);
            }, 0);
            const lossFraction = casualtyFraction(power, enemyPower);
            const strengthLoss = Math.floor(strength * lossFraction);

            const outcome = applyLosses(factionArmies, strengthLoss, lossFraction);
            factionOutcomes.set(factionId, outcome);
            factionThresholds.set(factionId, buildDestructionThresholdMap(outcome.thresholds));
        });

        const survivorsByFaction = new Map<FactionId, { updates: { armyId: string; strength: number; morale: number }[] }>();
        const originalArmiesById = new Map(armiesOnGround.map(army => [army.id, army]));

        factionOutcomes.forEach((outcome, factionId) => {
            const thresholdMap = factionThresholds.get(factionId) ?? new Map<string, number>();
            const survivors = outcome.updates.filter(update => update.strength > (thresholdMap.get(update.armyId) ?? MIN_ARMY_CREATION_STRENGTH));
            survivorsByFaction.set(factionId, { updates: survivors });

            armiesToDestroy.push(...outcome.destroyedIds);
            armyUpdates.push(...outcome.updates);
            casualties.push({
                factionId,
                strengthLost: outcome.strengthLost,
                moraleLost: outcome.moraleLost,
                destroyed: outcome.destroyedIds
            });
        });

        const survivingPowers: { factionId: FactionId; remainingPower: number }[] = [];

        survivorsByFaction.forEach((survivors, factionId) => {
            if (survivors.updates.length === 0) return;

            const reconstructedArmies: Army[] = survivors.updates.map(update => {
                const baseArmy = originalArmiesById.get(update.armyId);
                return baseArmy
                    ? { ...baseArmy, strength: update.strength, morale: update.morale }
                    : { id: update.armyId, factionId, strength: update.strength, morale: update.morale, maxStrength: update.strength, state: ArmyState.DEPLOYED, containerId: system.id };
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
                const topAttacker = survivingPowers
                    .filter(entry => entry.factionId !== defendingFactionId)
                    .sort((a, b) => b.remainingPower - a.remainingPower)[0];
                winnerFactionId = topAttacker?.factionId ?? null;
            } else {
                winnerFactionId = defendingFactionId;
            }
        } else {
            if (survivingPowers.length === 0) {
                winnerFactionId = null;
            } else {
                survivingPowers.sort((a, b) => b.remainingPower - a.remainingPower);
                const [top, second] = survivingPowers;
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

        logText = `Ground battle at ${system.name} resolved as ${ruleDescription}. Outcome: ${outcomeLabel}.`;
        if (survivorsText.length > 0) {
            logText += ` Remaining power: ${survivorsText}.`;
        }

        if (casualties.length > 0) {
            const lossSummary = casualties
                .map(entry => `${getFactionLabel(entry.factionId)} lost ${entry.strengthLost} strength (${entry.destroyed.length} units destroyed)`)
                .join(', ');
            logText += ` Losses - ${lossSummary}.`;
        }
    }

    let conquestOccurred = false;
    const conquestAttempt = winnerFactionId && winnerFactionId !== 'draw' && system.ownerFactionId !== winnerFactionId;

    if (conquestAttempt && winnerFactionId && winnerFactionId !== 'draw') {
        const contested = isOrbitContested(system, state);
        if (contested) {
            logText += ' Orbital contestation within capture range blocks the capture.';
        } else {
            conquestOccurred = true;
        }
    }

    const unopposed = armiesByFaction.size === 1;
    const hasUpdates = armyUpdates.length > 0 || armiesToDestroy.length > 0;

    if (!hasUpdates && !conquestAttempt && !conquestOccurred && unopposed) {
        return null;
    }

    return {
        systemId: system.id,
        winnerFactionId,
        conquestOccurred,
        armiesDestroyed: armiesToDestroy,
        armyUpdates,
        casualties,
        logs: [logText]
    };
};
