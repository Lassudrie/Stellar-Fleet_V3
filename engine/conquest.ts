
import { GameState, StarSystem, FactionId, ArmyState, Army } from '../types';
import { COLORS, CAPTURE_RANGE } from '../data/static';
import { ARMY_DESTROY_THRESHOLD, MIN_ARMY_CREATION_STRENGTH } from './army';
import { Vec3, distSq } from './math/vec3';

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

export const isOrbitContested = (system: StarSystem, state: GameState): boolean => {
    const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;
    const factionsInRange = new Set(
        state.fleets
            .filter(fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= captureSq)
            .map(fleet => fleet.factionId)
    );

    return factionsInRange.size >= 2;
};

const applyLosses = (
    armies: Army[],
    totalStrengthLoss: number,
    lossFraction: number
): {
    updates: { armyId: string; strength: number; morale: number }[];
    destroyedIds: string[];
    strengthLost: number;
    moraleLost: number;
    thresholds: { armyId: string; threshold: number }[];
} => {
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

    const blueArmies = armiesOnGround.filter(a => a.factionId === 'blue');
    const redArmies = armiesOnGround.filter(a => a.factionId === 'red');

    const blueCount = blueArmies.length;
    const redCount = redArmies.length;

    // 2. Identify Conflict Type
    let winnerFactionId: FactionId | 'draw' | null = null;
    const armiesToDestroy: string[] = [];
    let logText = '';
    let armyUpdates: { armyId: string; strength: number; morale: number }[] = [];
    let casualties: { factionId: FactionId; strengthLost: number; moraleLost: number; destroyed: string[] }[] = [];

    if (blueCount > 0 && redCount === 0) {
        winnerFactionId = 'blue';
        logText = `System ${system.name} secured by BLUE ground forces (Unopposed).`;
        casualties = [];
    } else if (redCount > 0 && blueCount === 0) {
        winnerFactionId = 'red';
        logText = `System ${system.name} secured by RED ground forces (Unopposed).`;
        casualties = [];
    } else {
        // Case B: Active Combat
        const bluePower = calculatePower(blueArmies);
        const redPower = calculatePower(redArmies);

        const blueStrength = calculateTotalStrength(blueArmies);
        const redStrength = calculateTotalStrength(redArmies);

        const blueLossFraction = casualtyFraction(bluePower, redPower);
        const redLossFraction = casualtyFraction(redPower, bluePower);

        const blueStrengthLoss = Math.floor(blueStrength * blueLossFraction);
        const redStrengthLoss = Math.floor(redStrength * redLossFraction);

        const blueOutcome = applyLosses(blueArmies, blueStrengthLoss, blueLossFraction);
        const redOutcome = applyLosses(redArmies, redStrengthLoss, redLossFraction);

        const blueThresholdMap = buildDestructionThresholdMap(blueOutcome.thresholds);
        const redThresholdMap = buildDestructionThresholdMap(redOutcome.thresholds);

        const blueSurvivors = blueOutcome.updates.filter(u => u.strength > (blueThresholdMap.get(u.armyId) ?? MIN_ARMY_CREATION_STRENGTH));
        const redSurvivors = redOutcome.updates.filter(u => u.strength > (redThresholdMap.get(u.armyId) ?? MIN_ARMY_CREATION_STRENGTH));

        armiesToDestroy.push(...blueOutcome.destroyedIds, ...redOutcome.destroyedIds);
        armyUpdates = [...blueOutcome.updates, ...redOutcome.updates];
        casualties = [
            { factionId: 'blue', strengthLost: blueOutcome.strengthLost, moraleLost: blueOutcome.moraleLost, destroyed: blueOutcome.destroyedIds },
            { factionId: 'red', strengthLost: redOutcome.strengthLost, moraleLost: redOutcome.moraleLost, destroyed: redOutcome.destroyedIds }
        ];

        if (blueSurvivors.length > 0 && redSurvivors.length === 0) {
            winnerFactionId = 'blue';
            logText = `Ground Battle at ${system.name}: BLUE prevails (${bluePower.toFixed(0)} vs ${redPower.toFixed(0)}).`;
        } else if (redSurvivors.length > 0 && blueSurvivors.length === 0) {
            winnerFactionId = 'red';
            logText = `Ground Battle at ${system.name}: RED prevails (${redPower.toFixed(0)} vs ${bluePower.toFixed(0)}).`;
        } else if (blueSurvivors.length > 0 && redSurvivors.length > 0) {
            winnerFactionId = 'draw';
            logText = `Ground Battle at ${system.name}: Stalemate (${bluePower.toFixed(0)} vs ${redPower.toFixed(0)}). Both forces hold.`;
        } else {
            winnerFactionId = null;
            logText = `Ground Battle at ${system.name}: Mutual destruction (${bluePower.toFixed(0)} vs ${redPower.toFixed(0)}).`;
        }

        if (winnerFactionId !== null) {
            logText += ` Losses - BLUE: ${blueOutcome.strengthLost} soldiers (${blueOutcome.destroyedIds.length} units destroyed), RED: ${redOutcome.strengthLost} soldiers (${redOutcome.destroyedIds.length} units destroyed).`;
        }
    }

    let conquestOccurred = false;
    const conquestAttempt =
        winnerFactionId === 'blue'
            ? system.ownerFactionId !== 'blue'
            : winnerFactionId === 'red'
                ? system.ownerFactionId !== 'red'
                : false;

    if (conquestAttempt && winnerFactionId && winnerFactionId !== 'draw') {
        const contested = isOrbitContested(system, state);
        if (contested) {
            logText += ' Orbital contestation within capture range blocks the capture.';
        } else {
            conquestOccurred = true;
        }
    }

    const unopposed = blueCount === 0 || redCount === 0;
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
