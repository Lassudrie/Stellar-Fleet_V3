
import { GameState, StarSystem, FactionId, ArmyState, Army } from '../types';
import { COLORS, CAPTURE_RANGE } from '../data/static';
import { MIN_ARMY_STRENGTH } from './army';
import { Vec3, distSq } from './math/vec3';

export interface ConquestResult {
  allowed: boolean;
  reason: string;
}

export interface GroundBattleResult {
    systemId: string;
    winnerFactionId: FactionId | 'draw' | null;
    conquestOccurred: boolean;
    armiesDestroyed: string[]; // IDs of destroyed armies
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
    return armies.reduce((sum, army) => sum + army.strength, 0);
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
            logs: [`System ${system.name} secured by RED ground forces (Unopposed).`]
        };
    }

    // Case B: Active Combat
    let winnerFactionId: FactionId | 'draw';
    let armiesToDestroy: string[] = [];
    let conquestOccurred = false;
    let logText = '';

    const bluePower = calculatePower(blueArmies);
    const redPower = calculatePower(redArmies);

    if (bluePower > redPower) {
        // BLUE WINS
        winnerFactionId = 'blue';
        conquestOccurred = system.ownerFactionId !== 'blue';
        
        // 1. Destroy Loser (All Red)
        armiesToDestroy.push(...redArmies.map(a => a.id));

        // 2. Calculate Winner Attrition
        // Rule: 1 Loss per 2 "Divisions" (MIN_ARMY_STRENGTH) of enemy power
        const attritionCount = Math.floor((redPower / MIN_ARMY_STRENGTH) * 0.5);
        let blueLosses = 0;

        if (attritionCount > 0) {
            // Sort Blue armies deterministically: Weakest first, then by ID
            blueArmies.sort((a, b) => (a.strength - b.strength) || a.id.localeCompare(b.id));
            
            // Take the first N armies
            const casualties = blueArmies.slice(0, attritionCount);
            armiesToDestroy.push(...casualties.map(a => a.id));
            blueLosses = casualties.length;
        }

        logText = `Ground Battle at ${system.name}: BLUE wins (Power ${bluePower} vs ${redPower}). RED destroyed: ${redCount}, BLUE losses: ${blueLosses}.`;

    } else if (redPower > bluePower) {
        // RED WINS
        winnerFactionId = 'red';
        conquestOccurred = system.ownerFactionId !== 'red';

        // 1. Destroy Loser (All Blue)
        armiesToDestroy.push(...blueArmies.map(a => a.id));

        // 2. Calculate Winner Attrition
        const attritionCount = Math.floor((bluePower / MIN_ARMY_STRENGTH) * 0.5);
        let redLosses = 0;

        if (attritionCount > 0) {
            // Sort Red armies deterministically
            redArmies.sort((a, b) => (a.strength - b.strength) || a.id.localeCompare(b.id));
            
            const casualties = redArmies.slice(0, attritionCount);
            armiesToDestroy.push(...casualties.map(a => a.id));
            redLosses = casualties.length;
        }

        logText = `Ground Battle at ${system.name}: RED wins (Power ${redPower} vs ${bluePower}). BLUE destroyed: ${blueCount}, RED losses: ${redLosses}.`;

    } else {
        // DRAW
        winnerFactionId = 'draw';
        logText = `Ground Battle at ${system.name}: Stalemate (Power ${bluePower} vs ${redPower}). No territory change.`;
    }

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
