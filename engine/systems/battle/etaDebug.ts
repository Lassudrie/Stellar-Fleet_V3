
import { Vector3 } from 'three';
import { GameState, Battle, FactionId, Fleet, ShipType, FleetState } from '../../../types';
import { RNG } from '../../rng';
import { resolveBattle } from './resolution';

/**
 * DEBUG UTILITY
 * Run this function in console or main execution to verify ETA logic.
 * Usage: import { debugSimulateEta } from './engine/systems/battle/etaDebug'; debugSimulateEta();
 */
export const debugSimulateEta = () => {
    console.log("--- DEBUGGING ETA LOGIC ---");
    
    // 1. Mock State
    const rng = new RNG(12345);
    
    const blueFleet: Fleet = {
        id: 'fleet_blue',
        factionId: 'blue',
        state: FleetState.COMBAT,
        position: new Vector3(0, 0, 0),
        targetPosition: null,
        targetSystemId: null,
        stateStartTurn: 0,
        radius: 1,
        ships: [{ id: 'ship_blue_1', type: ShipType.FRIGATE, hp: 500, maxHp: 500, carriedArmyId: null }] // Frigate has missiles
    };

    const redFleet: Fleet = {
        id: 'fleet_red',
        factionId: 'red',
        state: FleetState.COMBAT,
        position: new Vector3(0, 0, 0),
        targetPosition: null,
        targetSystemId: null,
        stateStartTurn: 0,
        radius: 1,
        ships: [{ id: 'ship_red_1', type: ShipType.CARRIER, hp: 2000, maxHp: 2000, carriedArmyId: null }] // Carrier has HP to soak
    };

    const state: GameState = {
        scenarioId: 'debug_scenario',
        seed: 12345,
        rngState: 12345,
        startYear: 3000,
        day: 5, // Arbitrary day
        playerFactionId: 'blue',
        factions: [
            { id: 'blue', name: 'Blue Team', color: 'blue', isPlayable: true },
            { id: 'red', name: 'Red Team', color: 'red', isPlayable: false }
        ],
        systems: [],
        fleets: [blueFleet, redFleet],
        armies: [],
        lasers: [],
        battles: [],
        logs: [],
        selectedFleetId: null,
        winnerFactionId: null,
        objectives: { conditions: [] },
        rules: {
            fogOfWar: false,
            useAdvancedCombat: true,
            aiEnabled: false,
            totalWar: true
        }
    };

    const battle: Battle = {
        id: 'debug_battle',
        systemId: 'sys_debug',
        turnCreated: 5,
        status: 'scheduled',
        involvedFleetIds: ['fleet_blue', 'fleet_red'],
        logs: []
    };

    // 2. Resolve (Updated signature)
    const { updatedBattle, survivingFleets } = resolveBattle(battle, state);

    // 3. Analyze Logs
    console.log("Battle Logs:");
    updatedBattle.logs.forEach(l => console.log(l));

    // 4. Assertions (Visual Check)
    const firedLogIndex = updatedBattle.logs.findIndex(l => l.includes("fired") && l.includes("ETA"));
    const hitLogIndex = updatedBattle.logs.findIndex(l => l.includes("hit by missile"));

    if (firedLogIndex === -1) console.error("FAIL: No missile fired.");
    else if (hitLogIndex === -1) console.error("FAIL: No missile hit recorded (maybe intercepted?).");
    else {
        // We expect fire in Round 1, hit in Round 3 (index distance depends on other logs)
        // Better to check the Round Headers between them.
        const logsBetween = updatedBattle.logs.slice(firedLogIndex, hitLogIndex);
        const roundHeaders = logsBetween.filter(l => l.includes("--- ROUND"));
        
        // If fired R1 (header R1 is above), and Hit R3 (header R3 is above), 
        // logsBetween should contain header R2 and maybe R3 depending on print order.
        
        console.log(`\nAnalysis: Missile fired at Log[${firedLogIndex}]. Hit at Log[${hitLogIndex}].`);
        console.log(`Rounds elapsed between fire and hit: ${roundHeaders.length}`);
        
        // If logic is R+2, we expect Round 2 header to appear between Launch (R1) and Hit (R3).
        // If Logic was R+1, we would see hit in Round 2.
        
        if (updatedBattle.logs[hitLogIndex-1]?.includes("ROUND 3") || updatedBattle.logs.find((l, i) => i < hitLogIndex && i > firedLogIndex && l.includes("ROUND 3"))) {
             console.log("PASS: Missile hit in Round 3 (Launch + 2).");
        } else if (updatedBattle.logs.find((l, i) => i < hitLogIndex && i > firedLogIndex && l.includes("ROUND 2"))) {
             console.warn("WARN: Missile hit in Round 2? (Launch + 1). Check logic.");
        } else {
             console.log("INFO: Could not strictly determine round from logs, check console output above.");
        }
    }

    // 5. Check State Start Turn Invariant
    console.log("\n--- INVARIANT CHECK ---");
    const survivor = survivingFleets[0];
    if (survivor) {
        if (survivor.state !== FleetState.ORBIT) console.error("FAIL: Survivor is not in ORBIT.");
        else console.log("PASS: Survivor returned to ORBIT.");

        if (survivor.stateStartTurn !== state.day) {
            console.error(`FAIL: Survivor stateStartTurn (${survivor.stateStartTurn}) != state.day (${state.day}).`);
        } else {
            console.log(`PASS: Survivor stateStartTurn updated to ${state.day}.`);
        }
    } else {
        console.warn("No survivors to check invariant.");
    }
};
