
import { Vector3 } from 'three';
import { FactionId, Fleet } from '../types';

// --- TYPES ---

export interface SystemEvalLog {
  systemId: string;
  systemName: string;
  isOwned: boolean;
  distanceToEmpire: number;
  fogAge: number;
  baseValue: number;
  expansionBias: number;
  frontierScore: number;
  threatDetected: number;
  finalScore: number;
  decision: 'IGNORED' | 'TARGET_CANDIDATE';
}

export interface TaskLog {
  type: string;
  targetSystemId: string;
  priority: number;
  requiredPower: number;
  assignedPower: number;
  executed: boolean;
  assignedFleetId: string | null;
  status: 'ASSIGNED' | 'SKIPPED_NO_FLEET' | 'SKIPPED_POWER_MISMATCH';
  reason?: string; // NEW: Contextual reason (e.g., "RECENTLY_CAPTURED_HOLD")
}

export interface FleetEvalLog {
  fleetId: string;
  state: string;
  position: { x: number, y: number, z: number };
  shipCount: number;
  totalPower: number;
  distanceToTarget: number;
  suitabilityScore: number;
}

export interface CombatDecisionLog {
  type: 'ATTACK' | 'DEFEND' | 'TRAP' | 'HOLD';
  systemId: string;
  myPower: number;
  enemyPower: number;
  ratio: number;
  threshold: number;
  outcome: 'ENGAGE' | 'RETREAT/AVOID' | 'GARRISON';
}

export interface SplitMergeLog {
  type: 'SPLIT' | 'MERGE';
  fleetId: string;
  reason: string;
  details: string;
}

export interface AIDebugTurnLog {
  turn: number;
  factionId: FactionId;
  timestamp: number;
  meta: {
    totalFleets: number;
    ownedSystems: number;
    globalThreat: number;
  };
  systemEvaluations: SystemEvalLog[];
  tasksGenerated: TaskLog[];
  fleetEvaluations: Record<string, FleetEvalLog[]>; // Map TaskID -> Fleets Considered
  decisions: (CombatDecisionLog | SplitMergeLog)[];
  logs: string[];
}

// --- LOGGER CLASS ---

class AIDebugger {
  private isEnabled: boolean = false;
  private history: AIDebugTurnLog[] = [];
  private currentLog: AIDebugTurnLog | null = null;
  private readonly MAX_HISTORY = 100;

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    if (!enabled) {
      this.currentLog = null;
    }
  }

  public getEnabled(): boolean {
    return this.isEnabled;
  }

  public startTurn(turn: number, factionId: FactionId, meta: { totalFleets: number, ownedSystems: number }) {
    if (!this.isEnabled) return;

    this.currentLog = {
      turn,
      factionId,
      timestamp: Date.now(),
      meta: {
        ...meta,
        globalThreat: 0 // Will be updated during analysis via setGlobalThreat
      },
      systemEvaluations: [],
      tasksGenerated: [],
      fleetEvaluations: {},
      decisions: [],
      logs: []
    };
  }
  
  public setGlobalThreat(threat: number) {
      if (this.currentLog && this.currentLog.meta) {
          this.currentLog.meta.globalThreat = threat;
      }
  }

  public commitTurn() {
    if (!this.isEnabled || !this.currentLog) return;
    
    this.history.push(this.currentLog);
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }
    this.currentLog = null;
  }

  public clear() {
    this.history = [];
    this.currentLog = null;
  }

  public getHistory() {
    return this.history;
  }

  // --- LOGGING METHODS ---

  public logSystemEval(data: SystemEvalLog) {
    if (!this.isEnabled || !this.currentLog) return;
    this.currentLog.systemEvaluations.push(data);
  }

  public logTask(data: TaskLog) {
    if (!this.isEnabled || !this.currentLog) return;
    this.currentLog.tasksGenerated.push(data);
  }

  public logFleetEval(taskId: string, data: FleetEvalLog) {
    if (!this.isEnabled || !this.currentLog) return;
    if (!this.currentLog.fleetEvaluations[taskId]) {
        this.currentLog.fleetEvaluations[taskId] = [];
    }
    this.currentLog.fleetEvaluations[taskId].push(data);
  }

  public logDecision(data: CombatDecisionLog | SplitMergeLog) {
    if (!this.isEnabled || !this.currentLog) return;
    this.currentLog.decisions.push(data);
  }

  public logText(text: string) {
    if (!this.isEnabled || !this.currentLog) return;
    this.currentLog.logs.push(text);
  }
}

export const aiDebugger = new AIDebugger();
