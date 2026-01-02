import type { Army, FactionId } from '../../shared/types';
import { RNG } from '../rng';
import { hashJoin32 } from '../planetSurface/hash32';
import type { TerrainType } from './terrain';
import { clamp } from './utils';
import { rollTriangularCentered } from './random';
import { computeKBreakdown, KBreakdown, SituationFlags, StatusFlags } from './k';

export interface EngagementContext {
  turn: number;
  terrainType: TerrainType; // terrain of defender hex
  attackerSituation?: SituationFlags;
  defenderSituation?: SituationFlags;
  attackerStatus?: StatusFlags;
  defenderStatus?: StatusFlags;
}

export interface EngagementResult {
  attackerId: string;
  defenderId: string;
  attackerFactionId: FactionId;
  defenderFactionId: FactionId;
  terrainType: TerrainType;

  // Core metrics
  srAtt: number;
  srDef: number;
  kAtt: KBreakdown;
  kDef: KBreakdown;
  ra: number;
  rd: number;
  attackEff: number;
  defenseEff: number;
  r: number;

  // Losses
  pDef: number;
  pAtt: number;
  lossesDef: number;
  lossesAtt: number;

  // Condition deltas
  dCDef: number;
  dCAtt: number;

  // Break
  breakScore: number;
  advantage: number;
  breakChance: number;
  breakRoll: number;
  defenderBroke: boolean;

  // Updated units
  attackerAfter: Army;
  defenderAfter: Army;
}

export type EngagementPreview = Omit<EngagementResult, 'breakRoll' | 'defenderBroke' | 'attackerAfter' | 'defenderAfter'>;

const computeSR = (army: Army): number => {
  if (army.maxMembers <= 0) return 0;
  return clamp(army.members / army.maxMembers, 0, 1);
};

const computeLosses = (members: number, p: number): number => {
  if (members <= 0) return 0;
  if (p <= 0) return 0;
  const raw = Math.floor(members * p);
  return Math.max(1, raw);
};

export const previewEngagement = (attacker: Army, defender: Army, ctx: EngagementContext): EngagementPreview => {
  const srAtt = computeSR(attacker);
  const srDef = computeSR(defender);
  const kAtt = computeKBreakdown({
    unitType: attacker.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.attackerSituation,
    status: ctx.attackerStatus
  });
  const kDef = computeKBreakdown({
    unitType: defender.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.defenderSituation,
    status: ctx.defenderStatus
  });

  const ra = 1;
  const rd = 1;
  const attackEff = attacker.attack * srAtt * attacker.condition * kAtt.kFinal * ra;
  const defenseEff = defender.defense * srDef * defender.condition * kDef.kFinal * rd;
  const r = defenseEff > 0 ? attackEff / defenseEff : Infinity;

  const pDef = clamp(0.05 * r, 0.02, 0.30);
  const pAtt = clamp(0.04 / r, 0.01, 0.25);

  const lossesDef = computeLosses(defender.members, pDef);
  const lossesAtt = computeLosses(attacker.members, pAtt);

  const defenderMembersAfter = Math.max(0, defender.members - lossesDef);

  const dCDef = clamp(0.10 * r, 0.03, 0.25);
  const dCAtt = clamp(0.08 / r, 0.02, 0.20);

  const defenderConditionAfter = clamp(defender.condition - dCDef, 0, 1);
  // Preview break evaluation uses updated defender SR/condition (mirrors resolver sans RNG).
  const srDefAfter = defender.maxMembers > 0 ? clamp(defenderMembersAfter / defender.maxMembers, 0, 1) : 0;
  const breakScore = (1 - srDefAfter) * 0.6 + (1 - defenderConditionAfter) * 0.4;
  const advantage = clamp((r >= 2.5 ? 1.0 : (r - 1.1)), 0.0, 1.0);
  const breakChance = clamp(breakScore * (0.15 + 0.55 * advantage), 0.0, 0.85);

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerFactionId: attacker.factionId,
    defenderFactionId: defender.factionId,
    terrainType: ctx.terrainType,
    srAtt,
    srDef,
    kAtt,
    kDef,
    ra,
    rd,
    attackEff,
    defenseEff,
    r,
    pDef,
    pAtt,
    lossesDef,
    lossesAtt,
    dCDef,
    dCAtt,
    breakScore,
    advantage,
    breakChance
  };
};

export const resolveEngagement = (attacker: Army, defender: Army, ctx: EngagementContext): EngagementResult => {
  const seed = hashJoin32(ctx.turn, attacker.id, defender.id, 'ground');
  const rng = new RNG(seed);

  const srAtt = computeSR(attacker);
  const srDef = computeSR(defender);

  const kAtt = computeKBreakdown({
    unitType: attacker.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.attackerSituation,
    status: ctx.attackerStatus
  });
  const kDef = computeKBreakdown({
    unitType: defender.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.defenderSituation,
    status: ctx.defenderStatus
  });

  const epsilon = 0.08;
  const ra = rollTriangularCentered(rng, epsilon);
  const rd = rollTriangularCentered(rng, epsilon);

  const attackEff = attacker.attack * srAtt * attacker.condition * kAtt.kFinal * ra;
  const defenseEff = defender.defense * srDef * defender.condition * kDef.kFinal * rd;
  const r = defenseEff > 0 ? attackEff / defenseEff : Infinity;

  const pDef = clamp(0.05 * r, 0.02, 0.30);
  const pAtt = clamp(0.04 / r, 0.01, 0.25);

  const lossesDef = computeLosses(defender.members, pDef);
  const lossesAtt = computeLosses(attacker.members, pAtt);

  const defenderMembersAfter = Math.max(0, defender.members - lossesDef);
  const attackerMembersAfter = Math.max(0, attacker.members - lossesAtt);

  const dCDef = clamp(0.10 * r, 0.03, 0.25);
  const dCAtt = clamp(0.08 / r, 0.02, 0.20);

  const defenderConditionAfter = clamp(defender.condition - dCDef, 0, 1);
  const attackerConditionAfter = clamp(attacker.condition - dCAtt, 0, 1);

  // Break evaluation uses updated defender SR/condition per spec intent.
  const srDefAfter = defender.maxMembers > 0 ? clamp(defenderMembersAfter / defender.maxMembers, 0, 1) : 0;
  const breakScore = (1 - srDefAfter) * 0.6 + (1 - defenderConditionAfter) * 0.4;
  const advantage = clamp((r >= 2.5 ? 1.0 : (r - 1.1)), 0.0, 1.0);
  const breakChance = clamp(breakScore * (0.15 + 0.55 * advantage), 0.0, 0.85);

  const forcedBreak = defenderConditionAfter <= 0.20 || srDefAfter <= 0.15;
  const breakRoll = rng.next();
  const defenderBroke = forcedBreak || (breakRoll < breakChance);

  const attackerAfter: Army = {
    ...attacker,
    members: attackerMembersAfter,
    condition: attackerConditionAfter
  };
  const defenderAfter: Army = {
    ...defender,
    members: defenderMembersAfter,
    condition: defenderConditionAfter
  };

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerFactionId: attacker.factionId,
    defenderFactionId: defender.factionId,
    terrainType: ctx.terrainType,
    srAtt,
    srDef,
    kAtt,
    kDef,
    ra,
    rd,
    attackEff,
    defenseEff,
    r,
    pDef,
    pAtt,
    lossesDef,
    lossesAtt,
    dCDef,
    dCAtt,
    breakScore,
    advantage,
    breakChance,
    breakRoll,
    defenderBroke,
    attackerAfter,
    defenderAfter
  };
};

