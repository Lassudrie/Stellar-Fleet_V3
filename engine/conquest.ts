
import { GameState, StarSystem, FactionId, ArmyState, Army } from '../types';
import { COLORS, CAPTURE_RANGE } from '../data/static';
import { MIN_ARMY_STRENGTH } from './army';
import { Vec3, distSq } from './math/vec3';

export interface ConquestResult {
  allowed: boolean;
  reason: string;
}

export interface ArmyCasualty {
    armyId: string;
    factionId: FactionId;
    strengthLost: number;
    moraleLost: number;
    destroyed: boolean;
}

export interface GroundBattleResult {
    systemId: string;
    winnerFactionId: FactionId | 'draw' | null;
    conquestOccurred: boolean;
    armiesDestroyed: string[]; // IDs of destroyed armies
    armyUpdates: Record<string, Partial<Army>>;
    casualties: ArmyCasualty[];
    logs: string[];
}

/**
 * Validates if a faction can conquer a specific system.
 * 
 * NEW RULE: A system can never change owner without at least one 
 * Army deployed on the ground (ArmyState.DEPLOYED).
 * Orbital presence (Fleets) is insufficient.
 */
export const canConquerSystem = (
  system: StarSystem,
  attackerFactionId: FactionId,
  state: GameState
): ConquestResult => {
  // 0. Sanity Check
  if (system.ownerFactionId === attackerFactionId) {
    return { allowed: false, reason: 'System already owned.' };
  }

  // 1. ABSOLUTE RULE: Boots on the Ground
  // Check for at least one deployed army belonging to the attacker on this system.
  const hasBootsOnGround = state.armies.some(army => 
    army.factionId === attackerFactionId &&
    army.state === ArmyState.DEPLOYED &&
    army.containerId === system.id
  );

  if (!hasBootsOnGround) {
    return { 
      allowed: false, 
      reason: 'Conquest Failed: Orbital supremacy established, but no Ground Army deployed.' 
    };
  }

  return { allowed: true, reason: 'Ground forces established.' };
};

/**
 * Helper to calculate total ground power
 */
const calculatePower = (armies: Army[]): number => {
    return armies.reduce((sum, army) => sum + (army.strength * (army.morale ?? 1)), 0);
};

const MAX_LOSS_RATIO_PER_TURN = 0.35;
const MORALE_LOSS_FACTOR = 0.5;

const distributeCasualties = (
    armies: Army[],
    lossRatio: number
): { updates: Record<string, Partial<Army>>; destroyed: string[]; casualties: ArmyCasualty[] } => {
    const updates: Record<string, Partial<Army>> = {};
    const destroyed: string[] = [];
    const casualties: ArmyCasualty[] = [];

    armies.forEach(army => {
        const strengthLost = Math.floor(army.strength * lossRatio);
        const moraleLost = lossRatio * MORALE_LOSS_FACTOR;
        const nextStrength = Math.max(0, army.strength - strengthLost);
        const nextMorale = Math.max(0, Math.min(1, army.morale - moraleLost));
        const isDestroyed = nextStrength < MIN_ARMY_STRENGTH;

        if (isDestroyed) {
            destroyed.push(army.id);
        } else if (strengthLost > 0 || moraleLost > 0) {
            updates[army.id] = {
                strength: nextStrength,
                morale: nextMorale
            };
        }

        if (strengthLost > 0 || moraleLost > 0 || isDestroyed) {
            casualties.push({
                armyId: army.id,
                factionId: army.factionId,
                strengthLost,
                moraleLost,
                destroyed: isDestroyed
            });
        }
    });

    return { updates, destroyed, casualties };
};

/**
 * Resolves ground combat for a specific system (V2: Power Sum & Attrition).
 * 
 * Rules:
 * - Compare total Strength (Power).
 * - Highest power wins.
 * - Losing side gets wiped out completely.
 * - Winner suffers attrition: 1 Army lost per (LoserPower / MIN_ARMY_STRENGTH * 0.5).
 * - Attrition targets weakest armies first (Deterministically sorted).
 * - Draw = Stalemate (No deaths).
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
    // Case A: Unopposed (One faction present)
    if (blueCount > 0 && redCount === 0) {
        if (system.ownerFactionId === 'blue') return null; // Already owned, just garrisoned
        return {
            systemId: system.id,
            winnerFactionId: 'blue',
            conquestOccurred: true,
            armiesDestroyed: [],
            armyUpdates: {},
            casualties: [],
            logs: [`System ${system.name} secured by BLUE ground forces (Unopposed).`]
        };
    }

    if (redCount > 0 && blueCount === 0) {
        if (system.ownerFactionId === 'red') return null;
        return {
            systemId: system.id,
            winnerFactionId: 'red',
            conquestOccurred: true,
            armiesDestroyed: [],
            armyUpdates: {},
            casualties: [],
            logs: [`System ${system.name} secured by RED ground forces (Unopposed).`]
        };
    }

    // Case B: Active Combat
    let winnerFactionId: FactionId | 'draw' = 'draw';
    let armiesToDestroy: string[] = [];
    let conquestOccurred = false;
    let logText = '';
    const armyUpdates: Record<string, Partial<Army>> = {};
    const allCasualties: ArmyCasualty[] = [];

    const bluePower = calculatePower(blueArmies);
    const redPower = calculatePower(redArmies);

    const totalPower = bluePower + redPower;
    const blueLossRatio = totalPower > 0 ? Math.min(MAX_LOSS_RATIO_PER_TURN, redPower / totalPower) : 0;
    const redLossRatio = totalPower > 0 ? Math.min(MAX_LOSS_RATIO_PER_TURN, bluePower / totalPower) : 0;

    const blueOutcome = distributeCasualties(blueArmies, blueLossRatio);
    const redOutcome = distributeCasualties(redArmies, redLossRatio);

    Object.assign(armyUpdates, blueOutcome.updates, redOutcome.updates);
    armiesToDestroy.push(...blueOutcome.destroyed, ...redOutcome.destroyed);
    allCasualties.push(...blueOutcome.casualties, ...redOutcome.casualties);

    const survivingBlue = blueArmies.filter(a => {
        const nextStrength = armyUpdates[a.id]?.strength ?? a.strength;
        return nextStrength >= MIN_ARMY_STRENGTH;
    });

    const survivingRed = redArmies.filter(a => {
        const nextStrength = armyUpdates[a.id]?.strength ?? a.strength;
        return nextStrength >= MIN_ARMY_STRENGTH;
    });

    const blueSurvives = survivingBlue.length > 0;
    const redSurvives = survivingRed.length > 0;

    if (blueSurvives && !redSurvives) {
        winnerFactionId = 'blue';
        conquestOccurred = system.ownerFactionId !== 'blue';
    } else if (redSurvives && !blueSurvives) {
        winnerFactionId = 'red';
        conquestOccurred = system.ownerFactionId !== 'red';
    } else if (!blueSurvives && !redSurvives) {
        winnerFactionId = 'draw';
    }

    const blueCasualties = allCasualties.filter(c => c.factionId === 'blue');
    const redCasualties = allCasualties.filter(c => c.factionId === 'red');
    const blueLossStrength = blueCasualties.reduce((sum, c) => sum + c.strengthLost, 0);
    const redLossStrength = redCasualties.reduce((sum, c) => sum + c.strengthLost, 0);

    logText = `Ground Battle at ${system.name}: power BLUE ${bluePower.toFixed(0)} vs RED ${redPower.toFixed(0)}.`;
    logText += ` Losses -> BLUE: ${blueLossStrength} strength, ${blueCasualties.length} events; RED: ${redLossStrength} strength, ${redCasualties.length} events.`;

    // --- RULE: ORBITAL CONTESTATION ---
    // If conquest happened, verify orbital supremacy. 
    // If active fleets from BOTH factions are present, the winner cannot secure the planet (Owner Flip blocked).
    if (conquestOccurred && winnerFactionId !== 'draw') {
        const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;

        const hasBlueFleet = state.fleets.some(f => f.factionId === 'blue' && f.ships.length > 0 && distSq(f.position, system.position) <= captureSq);
        const hasRedFleet = state.fleets.some(f => f.factionId === 'red' && f.ships.length > 0 && distSq(f.position, system.position) <= captureSq);

        if (hasBlueFleet && hasRedFleet) {
            conquestOccurred = false;
            logText += " Orbital contestation prevents establishing sovereign control.";
        }
    }

    return {
        systemId: system.id,
        winnerFactionId,
        conquestOccurred,
        armiesDestroyed: armiesToDestroy,
        armyUpdates,
        casualties: allCasualties,
        logs: [logText]
    };
};

// --- STRATEGIC AI HELPERS ---

/**
 * Determines if a system is a valid target for invasion by the specified faction.
 */
export const canInvade = (systemId: string, state: GameState, attackerFactionId: FactionId): boolean => {
    const system = state.systems.find(s => s.id === systemId);
    if (!system) return false;
    
    // Valid if we don't own it
    return system.ownerFactionId !== attackerFactionId;
};

/**
 * Estimates the minimum number of armies required to capture the system.
 * Based on current intelligence (state).
 * Rule: Must strictly exceed defender count.
 */
export const estimateRequiredArmies = (systemId: string, state: GameState, attackerFactionId: FactionId): number => {
    const defenders = state.armies.filter(a => 
        a.containerId === systemId && 
        a.state === ArmyState.DEPLOYED && 
        a.factionId !== attackerFactionId
    );
    
    // Simple Heuristic: Match count + 1 (Assuming equal strength)
    return defenders.length + 1;
};

/**
 * Calculates a heuristic cost for the invasion operation.
 * Used by AI to weigh targets.
 */
export const estimateInvasionCost = (systemId: string, state: GameState, attackerFactionId: FactionId): number => {
    const required = estimateRequiredArmies(systemId, state, attackerFactionId);
    
    // Cost Heuristic: 
    // 100 per required army (Recruitment/Transport effort)
    const cost = required * 100;
    
    // console.log(`[Strategy] Eval ${systemId}: Needs ${required} armies. Cost Index: ${cost}`);
    return cost;
};
