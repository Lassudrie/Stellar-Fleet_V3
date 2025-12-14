import { OBJECTIVES_PREFIX, REWARD_PREFIX, ERA_THRESHOLDS } from '../config';
import {
  EngagementAfterTurnContext,
  EngagementObjectiveState,
  EngagementPlugin,
  EraId,
  ObjectiveKind,
  RewardAxis,
  RewardFamily,
  RewardHorizon,
} from '../types';

type ObjectiveDef = {
  id: string;
  era: EraId;
  kind: ObjectiveKind;
  axis: RewardAxis;
  family: RewardFamily;
  horizon: RewardHorizon;
  title: string;
  description: string;
  target: number;
  prestigeReward: number;
};

const getEraForDay = (day: number): EraId => {
  const d = Number.isFinite(day) ? day : 1;
  if (d >= ERA_THRESHOLDS.LATE.startDay) return 'LATE';
  if (d >= ERA_THRESHOLDS.MID.startDay) return 'MID';
  return 'EARLY';
};

const OBJECTIVE_DEFS: ObjectiveDef[] = [
  // EARLY
  {
    id: 'early_capture_2',
    era: 'EARLY',
    kind: 'CAPTURE_SYSTEMS',
    axis: 'EXPAND',
    family: 'POWER',
    horizon: 'SHORT',
    title: 'Secure Nearby Systems',
    description: 'Capture 2 additional systems to establish a foothold.',
    target: 2,
    prestigeReward: 8,
  },
  {
    id: 'early_win_1',
    era: 'EARLY',
    kind: 'WIN_BATTLES',
    axis: 'EXTERMINATE',
    family: 'POWER',
    horizon: 'SHORT',
    title: 'Prove Your Fleet',
    description: 'Win 1 battle.',
    target: 1,
    prestigeReward: 6,
  },
  {
    id: 'early_gas_1',
    era: 'EARLY',
    kind: 'CONTROL_GAS_SYSTEMS',
    axis: 'EXPLOIT',
    family: 'CONTROL',
    horizon: 'MID',
    title: 'Secure Fuel',
    description: 'Control at least 1 gas giant.',
    target: 1,
    prestigeReward: 6,
  },

  // MID
  {
    id: 'mid_capture_4',
    era: 'MID',
    kind: 'CAPTURE_SYSTEMS',
    axis: 'EXPAND',
    family: 'POWER',
    horizon: 'MID',
    title: 'Expand the Frontier',
    description: 'Capture 4 additional systems this era.',
    target: 4,
    prestigeReward: 12,
  },
  {
    id: 'mid_win_2',
    era: 'MID',
    kind: 'WIN_BATTLES',
    axis: 'EXTERMINATE',
    family: 'POWER',
    horizon: 'MID',
    title: 'Maintain Pressure',
    description: 'Win 2 battles.',
    target: 2,
    prestigeReward: 10,
  },
  {
    id: 'mid_invasion_1',
    era: 'MID',
    kind: 'START_INVASIONS',
    axis: 'EXTERMINATE',
    family: 'OPTIONS',
    horizon: 'MID',
    title: 'Launch an Invasion',
    description: 'Deploy 1 army onto an enemy-held system.',
    target: 1,
    prestigeReward: 10,
  },

  // LATE
  {
    id: 'late_capture_7',
    era: 'LATE',
    kind: 'CAPTURE_SYSTEMS',
    axis: 'EXPAND',
    family: 'POWER',
    horizon: 'LONG',
    title: 'Dominate the Sector',
    description: 'Capture 7 additional systems this era.',
    target: 7,
    prestigeReward: 18,
  },
  {
    id: 'late_win_3',
    era: 'LATE',
    kind: 'WIN_BATTLES',
    axis: 'EXTERMINATE',
    family: 'POWER',
    horizon: 'LONG',
    title: 'Break the Resistance',
    description: 'Win 3 battles.',
    target: 3,
    prestigeReward: 16,
  },
  {
    id: 'late_gas_3',
    era: 'LATE',
    kind: 'CONTROL_GAS_SYSTEMS',
    axis: 'EXPLOIT',
    family: 'CONTROL',
    horizon: 'LONG',
    title: 'Fuel Supremacy',
    description: 'Control at least 3 gas giants.',
    target: 3,
    prestigeReward: 16,
  },
];

const createObjectiveState = (def: ObjectiveDef): EngagementObjectiveState => ({
  id: def.id,
  era: def.era,
  title: def.title,
  description: def.description,
  axis: def.axis,
  family: def.family,
  horizon: def.horizon,
  kind: def.kind,
  target: def.target,
  progress: 0,
  completed: false,
  prestigeReward: def.prestigeReward,
});

const describeObjectives = (objs: EngagementObjectiveState[]): string => {
  if (!objs || objs.length === 0) return 'No objectives.';
  return objs
    .map((o) => `${o.title}: ${o.progress}/${o.target} (+${o.prestigeReward})`)
    .join(' | ');
};

const countNewInvasions = (ctx: EngagementAfterTurnContext): number => {
  const player = ctx.playerFactionId;
  const prevById = new Map<string, any>();
  for (const a of ctx.prev.armies || []) prevById.set(a.id, a);

  let count = 0;
  for (const a of ctx.next.armies || []) {
    if (!a || a.factionId !== player) continue;

    const prev = prevById.get(a.id);
    const prevState = prev?.state;
    const nextState = a.state;

    if (prevState === nextState) continue;
    if (nextState !== 'DEPLOYED') continue;

    const systemId = a.containerId;
    const sys = (ctx.next.systems || []).find((s: any) => s && s.id === systemId);
    if (!sys) continue;

    // Only count as invasion if deployed onto non-player owned system
    if (sys.ownerFactionId && sys.ownerFactionId !== player) count += 1;
  }
  return count;
};

const updateObjectiveProgress = (ctx: EngagementAfterTurnContext, o: EngagementObjectiveState): EngagementObjectiveState => {
  if (o.completed) return o;

  let progress = o.progress;

  switch (o.kind) {
    case 'CAPTURE_SYSTEMS':
      progress += Math.max(0, ctx.metrics.systemsConqueredThisTurn);
      break;
    case 'WIN_BATTLES':
      progress += Math.max(0, ctx.metrics.battlesWonThisTurn);
      break;
    case 'CONTROL_GAS_SYSTEMS':
      progress = Math.max(0, ctx.metrics.gasSystemsOwnedNext);
      break;
    case 'START_INVASIONS':
      progress += Math.max(0, countNewInvasions(ctx));
      break;
    default:
      break;
  }

  if (!Number.isFinite(progress)) progress = o.progress;
  if (progress < 0) progress = 0;

  const completed = progress >= o.target;

  return {
    ...o,
    progress,
    completed,
    completedOnDay: completed ? ctx.next.day : o.completedOnDay,
  };
};

export default {
  id: 'engagement.20_eraObjectives',
  afterTurn: (ctx) => {
    const era = getEraForDay(ctx.next.day);
    let nextObjectives = ctx.engagement.objectives;

    const logs = [];
    let prestigeBonus = 0;

    // Era change => reset objectives
    if (ctx.engagement.era !== era) {
      nextObjectives = OBJECTIVE_DEFS.filter((d) => d.era === era).map(createObjectiveState);
      logs.push(
        ctx.makeLog(`${OBJECTIVES_PREFIX} Entering ${era} era. Objectives: ${describeObjectives(nextObjectives)}`, 'info')
      );
    }

    // Progress update
    const progressed = nextObjectives.map((o) => updateObjectiveProgress(ctx, o));

    // Completion rewards (only once)
    for (const o of progressed) {
      if (!o.completed) continue;
      const prev = nextObjectives.find((x) => x.id === o.id);
      if (prev && prev.completed) continue;

      prestigeBonus += o.prestigeReward;
      logs.push(
        ctx.makeLog(
          `${OBJECTIVES_PREFIX} Completed: ${o.title}. ${REWARD_PREFIX} +${o.prestigeReward} Prestige.`,
          'info'
        )
      );
    }

    const nextEngagement = {
      ...ctx.engagement,
      era,
      objectives: progressed,
      prestige: ctx.engagement.prestige + prestigeBonus,
    };

    return {
      engagement: nextEngagement,
      logs,
    };
  },
} satisfies EngagementPlugin;
