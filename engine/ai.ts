import { 
    GameState, 
    Fleet, 
    StarSystem, 
    FactionId,
    FleetState,
    ShipType
} from '../types';
import { GameCommand } from './commands';
import { dist, distSq, Vec3 } from './math/vec3';
import { CAPTURE_RANGE, AI_CONFIG } from '../data/static';
import { RNG } from './rng';
import { aiDebugger } from './aiDebugger';

// AI memory structure
export interface AIState {
    lastKnownSystemOwners: Record<string, FactionId | null>;
    fleetAssignments: Record<string, string>; // fleetId -> taskId
    enemySightings: EnemySighting[];
}

export interface EnemySighting {
    position: Vec3;
    factionId: FactionId;
    fleetStrength: number;
    turnSeen: number;
}

export interface AITask {
    id: string;
    type: 'DEFEND' | 'INVADE' | 'EXPAND' | 'ATTACK_FLEET';
    priority: number;
    systemId: string;
    targetFleetId?: string;
}

type AICommand = GameCommand;

interface FleetAssignment {
    fleet: Fleet;
    task: AITask;
}

export const planAiTurn = (
    state: GameState, 
    aiFactionId: FactionId, 
    existingState?: any,
    rng?: RNG
): AICommand[] => {
    // Create AI state if none exists or convert from old format
    const aiState: AIState = (existingState && 'enemySightings' in existingState && Array.isArray(existingState.enemySightings)) 
        ? existingState 
        : {
            lastKnownSystemOwners: existingState?.lastOwnerBySystemId || {},
            fleetAssignments: {},
            enemySightings: []
        };

    // Update system ownership knowledge
    state.systems.forEach(system => {
        aiState.lastKnownSystemOwners[system.id] = system.ownerFactionId;
    });

    // Update enemy sightings
    updateEnemySightings(state, aiFactionId, aiState);

    // Generate tasks
    const tasks = generateTasks(state, aiFactionId, aiState);

    // Update debugger
    aiDebugger.setAIState(aiState);
    aiDebugger.setPlannedTasks(tasks);

    // Assign fleets to tasks
    const assignments = assignFleetsToTasks(state, aiFactionId, tasks, aiState);

    // Generate commands
    const commands = generateCommands(state, aiFactionId, assignments, rng);

    // Update debugger
    aiDebugger.setPlannedCommands(commands);

    return commands;
};

const updateEnemySightings = (
    state: GameState, 
    aiFactionId: FactionId, 
    aiState: AIState
): void => {
    // Clear old sightings (older than 5 turns)
    aiState.enemySightings = aiState.enemySightings.filter(
        sighting => state.day - sighting.turnSeen < 5
    );

    // Add new sightings from nearby fleets
    const aiFleets = state.fleets.filter(f => f.factionId === aiFactionId);
    const enemyFleets = state.fleets.filter(f => f.factionId !== aiFactionId);

    for (const aiFleet of aiFleets) {
        for (const enemyFleet of enemyFleets) {
            const distance = distSq(aiFleet.position, enemyFleet.position);
            if (distance < AI_CONFIG.sightRange * AI_CONFIG.sightRange) {
                aiState.enemySightings.push({
                    position: enemyFleet.position,
                    factionId: enemyFleet.factionId,
                    fleetStrength: enemyFleet.ships.length,
                    turnSeen: state.day
                });
            }
        }
    }
};

const generateTasks = (
    state: GameState,
    aiFactionId: FactionId,
    aiState: AIState
): AITask[] => {
    const tasks: AITask[] = [];
    const aiSystems = state.systems.filter(s => s.ownerFactionId === aiFactionId);
    const neutralSystems = state.systems.filter(s => s.ownerFactionId === null);
    const enemySystems = state.systems.filter(s => s.ownerFactionId && s.ownerFactionId !== aiFactionId);

    // 1. DEFEND tasks for owned systems with enemy nearby
    aiSystems.forEach(system => {
        const enemyNearby = aiState.enemySightings.some(
            sighting => distSq(sighting.position, system.position) < CAPTURE_RANGE * CAPTURE_RANGE * 4
        );
        
        if (enemyNearby) {
            tasks.push({
                id: `defend_${system.id}`,
                type: 'DEFEND',
                priority: 100,
                systemId: system.id
            });
        }
    });

    // 2. INVASION tasks for weak enemy systems
    const aiHasTransportsWithArmies = state.fleets
        .filter(f => f.factionId === aiFactionId)
        .some(f => f.ships.some(s => s.type === ShipType.TROOP_TRANSPORT && !!s.carriedArmyId));

    if (aiHasTransportsWithArmies) {
        enemySystems.forEach(system => {
            const enemyDefenders = state.armies.filter(
                a => a.containerId === system.id && a.factionId === system.ownerFactionId
            );
            
            const defenderStrength = enemyDefenders.reduce((sum, a) => sum + a.strength, 0);
            
            // Only invade if lightly defended
            if (defenderStrength < 150) {
                tasks.push({
                    id: `invade_${system.id}`,
                    type: 'INVADE',
                    priority: 80 - defenderStrength / 10,
                    systemId: system.id
                });
            }
        });
    }

    // 3. EXPAND tasks for neutral systems
    neutralSystems.forEach(system => {
        // Prefer closer systems and those with resources
        const distanceToNearest = getDistanceToNearestSystem(state, system, aiFactionId);
        const resourceBonus = system.resourceType !== 'none' ? 10 : 0;
        
        tasks.push({
            id: `expand_${system.id}`,
            type: 'EXPAND',
            priority: 50 - distanceToNearest / 20 + resourceBonus,
            systemId: system.id
        });
    });

    // 4. ATTACK_FLEET tasks for nearby weak enemy fleets
    const aiFleets = state.fleets.filter(f => f.factionId === aiFactionId);
    const enemyFleets = state.fleets.filter(f => f.factionId !== aiFactionId);

    aiFleets.forEach(aiFleet => {
        enemyFleets.forEach(enemyFleet => {
            const distance = distSq(aiFleet.position, enemyFleet.position);
            
            if (distance < CAPTURE_RANGE * CAPTURE_RANGE * 2) {
                const aiStrength = aiFleet.ships.length;
                const enemyStrength = enemyFleet.ships.length;
                
                // Attack if we have advantage
                if (aiStrength > enemyStrength * 1.5) {
                    tasks.push({
                        id: `attack_${enemyFleet.id}`,
                        type: 'ATTACK_FLEET',
                        priority: 70 + (aiStrength - enemyStrength),
                        systemId: findNearestSystemId(state, enemyFleet.position),
                        targetFleetId: enemyFleet.id
                    });
                }
            }
        });
    });

    // Sort by priority descending
    return tasks.sort((a, b) => b.priority - a.priority);
};

const assignFleetsToTasks = (
    state: GameState,
    aiFactionId: FactionId,
    tasks: AITask[],
    aiState: AIState
): FleetAssignment[] => {
    const aiFleets = state.fleets
        .filter(f => f.factionId === aiFactionId)
        .filter(f => f.ships.length > 0); // Only active fleets

    const assignments: FleetAssignment[] = [];
    const assignedFleets = new Set<string>();

    // Clear outdated assignments
    Object.keys(aiState.fleetAssignments).forEach(fleetId => {
        if (!aiFleets.some(f => f.id === fleetId)) {
            delete aiState.fleetAssignments[fleetId];
        }
    });

    // Assign fleets to tasks in priority order
    tasks.forEach(task => {
        // Find best fleet for this task
        const availableFleets = aiFleets.filter(f => !assignedFleets.has(f.id));
        
        if (availableFleets.length === 0) return;

        // Score fleets based on distance and suitability
        const scoredFleets = availableFleets.map(fleet => {
            const targetSystem = state.systems.find(s => s.id === task.systemId);
            const distance = targetSystem ? distSq(fleet.position, targetSystem.position) : Infinity;
            
            let suitability = 1;
            
            // Invasion tasks need troop transports with armies
            if (task.type === 'INVADE') {
                const embarkedCount = fleet.ships.filter(s => s.type === ShipType.TROOP_TRANSPORT && !!s.carriedArmyId).length;
                suitability = embarkedCount > 0 ? 2 : 0;
            }
            
            // Defense tasks prefer closer fleets
            if (task.type === 'DEFEND') {
                suitability = 2 - distance / 1000;
            }
            
            // Attack tasks need combat strength
            if (task.type === 'ATTACK_FLEET') {
                suitability = fleet.ships.length / 10;
            }

            return {
                fleet,
                score: suitability / (1 + distance / 100)
            };
        });

        // Pick best fleet
        scoredFleets.sort((a, b) => b.score - a.score);
        const best = scoredFleets[0];
        
        if (best.score > 0) {
            assignments.push({
                fleet: best.fleet,
                task
            });
            assignedFleets.add(best.fleet.id);
            aiState.fleetAssignments[best.fleet.id] = task.id;
        }
    });

    return assignments;
};

const generateCommands = (
    state: GameState,
    aiFactionId: FactionId,
    assignments: FleetAssignment[],
    rng?: RNG
): AICommand[] => {
    const commands: AICommand[] = [];

    assignments.forEach(assignment => {
        const { fleet, task } = assignment;

        // Skip fleets that should not receive orders
        if (fleet.retreating) return;
        if (fleet.state === FleetState.COMBAT) return;

        // INVASION: must use ORDER_INVASION_MOVE to trigger auto-deploy in movement phase.
        if (task.type === 'INVADE') {
            // Avoid spamming identical orders if already committed to this invasion.
            if (
                fleet.state === FleetState.MOVING &&
                fleet.targetSystemId === task.systemId &&
                fleet.invasionTargetSystemId === task.systemId
            ) {
                return;
            }

            commands.push({
                type: 'ORDER_INVASION_MOVE',
                fleetId: fleet.id,
                targetSystemId: task.systemId
            });
            return;
        }

        // Hold position if already at target system (just skip command generation)
        const systemNow = state.systems.find(s => dist(s.position, fleet.position) < 5);
        if (fleet.state === FleetState.ORBIT && systemNow?.id === task.systemId) {
            return; // Already at target, no command needed
        }

        // If already moving to the target, do nothing
        if (fleet.state === FleetState.MOVING && fleet.targetSystemId === task.systemId) {
            return;
        }

        // Default move
        commands.push({
            type: 'MOVE_FLEET',
            fleetId: fleet.id,
            targetSystemId: task.systemId
        });
    });

    return commands;
};

const getDistanceToNearestSystem = (
    state: GameState,
    targetSystem: StarSystem,
    aiFactionId: FactionId
): number => {
    const aiSystems = state.systems.filter(s => s.ownerFactionId === aiFactionId);
    
    if (aiSystems.length === 0) return Infinity;
    
    return Math.min(...aiSystems.map(s => distSq(s.position, targetSystem.position)));
};

const findNearestSystemId = (state: GameState, position: Vec3): string => {
    const nearest = state.systems.reduce((best, system) => {
        const d = distSq(system.position, position);
        const bestD = best ? distSq(best.position, position) : Infinity;
        return d < bestD ? system : best;
    }, null as StarSystem | null);
    
    return nearest?.id || state.systems[0]?.id || '';
};
