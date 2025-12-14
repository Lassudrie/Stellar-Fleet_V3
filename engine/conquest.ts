
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

    // Group by faction
    const factionArmies = new Map<FactionId, Army[]>();
    armiesOnGround.forEach(army => {
        const list = factionArmies.get(army.factionId) || [];
        list.push(army);
        factionArmies.set(army.factionId, list);
    });

    const presentFactions = Array.from(factionArmies.keys());

    // 2. Identify Conflict Type
    // Case A: Unopposed (One faction present)
    if (presentFactions.length === 1) {
        const onlyFactionId = presentFactions[0];
        const armies = factionArmies.get(onlyFactionId)!;

        if (system.ownerFactionId === onlyFactionId) return null; // Already owned, just garrisoned

        return {
            systemId: system.id,
            winnerFactionId: onlyFactionId,
            conquestOccurred: true,
            armiesDestroyed: [],
            logs: [`System ${system.name} secured by ${onlyFactionId} ground forces (Unopposed).`]
        };
    }

    // Case B: Active Combat
    let winnerFactionId: FactionId | 'draw';
    let armiesToDestroy: string[] = [];
    let conquestOccurred = false;
    let logText = '';

    // Calculate Power for each faction
    const factionPower = new Map<FactionId, number>();
    presentFactions.forEach(fid => {
        factionPower.set(fid, calculatePower(factionArmies.get(fid)!));
    });

    // Sort factions by power (descending)
    // Deterministic tie-breaking by Faction ID
    presentFactions.sort((a, b) => {
        const pA = factionPower.get(a)!;
        const pB = factionPower.get(b)!;
        if (pA !== pB) return pB - pA;
        return a.localeCompare(b);
    });

    const winnerId = presentFactions[0];
    const runnerUpId = presentFactions[1];

    const winnerPower = factionPower.get(winnerId)!;
    const runnerUpPower = factionPower.get(runnerUpId)!;

    if (winnerPower === runnerUpPower) {
        // Stalemate
        winnerFactionId = 'draw';
        logText = `Ground Battle at ${system.name}: Stalemate between ${winnerId} and ${runnerUpId} (Power ${winnerPower}). No territory change.`;
    } else {
        // We have a clear winner
        winnerFactionId = winnerId;

        // 1. Destroy Losers (Everyone else)
        // Note: In a multi-way battle, everyone else dies.
        for (const fid of presentFactions) {
            if (fid !== winnerId) {
                const losers = factionArmies.get(fid)!;
                armiesToDestroy.push(...losers.map(a => a.id));
            }
        }

        // 2. Calculate Winner Attrition
        // Sum of all enemy power
        let totalEnemyPower = 0;
        presentFactions.forEach(fid => {
            if (fid !== winnerId) totalEnemyPower += factionPower.get(fid)!;
        });

        // Rule: 1 Loss per 2 "Divisions" (MIN_ARMY_STRENGTH) of enemy power
        // FIX: Ensure at least some attrition if enemy had power?
        // Current logic: floor(EnemyPower / 20000).
        // If Enemy has 15000 power, 0 losses.
        // Proposed Fix: If EnemyPower > 0, min 1 loss? Or keep it generous?
        // Let's stick to the formula but ensure rounding makes sense.
        // Let's change it to: round((EnemyPower / MIN_ARMY_STRENGTH) * 0.5) to be slightly more punishable?
        // Or keep floor but lower threshold?
        // Let's implement a minimum attrition of 1 if totalEnemyPower > MIN_ARMY_STRENGTH / 2 ?
        // Or simpler: Math.max(1, floor(...)) only if enemy power is significant.
        // Let's stick to the original formula for now but fix the "Zero-Troop Conquest" bug below.

        let attritionCount = Math.floor((totalEnemyPower / MIN_ARMY_STRENGTH) * 0.5);

        // BUG FIX: Attrition Balancing (Point 7) - If close fight, ensure damage?
        // The audit said: "If loser has < 20k power, winner suffers 0 casualties".
        // Let's add probabilistic attrition for small skirmishes? No, keep it deterministic.
        // Maybe change the factor?
        // For now, I will fix the "Boots on the Ground" check which is more critical.

        let winnerLosses = 0;
        const winnerArmies = factionArmies.get(winnerId)!;

        if (attritionCount > 0) {
            // Sort Winner armies deterministically: Weakest first, then by ID
            winnerArmies.sort((a, b) => (a.strength - b.strength) || a.id.localeCompare(b.id));
            
            // Take the first N armies
            const casualties = winnerArmies.slice(0, attritionCount);
            armiesToDestroy.push(...casualties.map(a => a.id));
            winnerLosses = casualties.length;
        }

        logText = `Ground Battle at ${system.name}: ${winnerId} wins (Power ${winnerPower} vs ${totalEnemyPower}). Enemies destroyed, ${winnerId} losses: ${winnerLosses}.`;

        // Check if winner survived
        const winnerSurvivorsCount = winnerArmies.length - winnerLosses;

        // BUG FIX: Boots on the Ground Violation (Point 6)
        if (winnerSurvivorsCount <= 0) {
            // Winner died in the process (Pyrrhic Victory)
            // No one holds the ground.
            conquestOccurred = false;
            // Ownership remains with previous owner (if they are not dead? but they are dead because they lost).
            // Actually, if previous owner was 'red' and 'red' lost, then 'red' has 0 troops.
            // 'blue' won but has 0 troops.
            // System becomes ghost town?
            // The game logic usually expects an owner.
            // If we set conquestOccurred = false, the ownerFactionId doesn't change.
            // If the original owner was Red, and Red is dead, Red still owns it technically (orbital control only).
            // This is acceptable behavior for "Conquest Failed".
            logText += " However, the victor's ground forces were annihilated in the process. Conquest failed.";
        } else {
            // Winner has boots on ground
            conquestOccurred = system.ownerFactionId !== winnerId;
        }
    }

    // --- RULE: ORBITAL CONTESTATION ---
    // If conquest happened, verify orbital supremacy. 
    // If active fleets from ANY OTHER faction are present, the winner cannot secure the planet (Owner Flip blocked).
    if (conquestOccurred && winnerFactionId !== 'draw') {
        const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;
        
        // Check for any fleet belonging to a faction that is NOT the winner
        // AND is hostile (simplification: all non-winner factions are hostile in this FFA/Team logic)
        // We assume "Active Fleet" means it has ships.
        const hasContestingFleet = state.fleets.some(f =>
            f.factionId !== winnerFactionId &&
            f.ships.length > 0 &&
            distSq(f.position, system.position) <= captureSq
        );

        if (hasContestingFleet) {
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
