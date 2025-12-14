import { MOMENT_PREFIX, REWARD_PREFIX } from '../config';
import { EngagementAfterTurnContext, EngagementMomentUnlock, EngagementPlugin } from '../types';

type MomentDef = {
  id: string;
  title: string;
  description: string;
  prestigeReward: number;
  // Return true when the moment should unlock.
  when: (ctx: EngagementAfterTurnContext) => boolean;
};

const hasMoment = (moments: Record<string, EngagementMomentUnlock>, id: string): boolean =>
  Object.prototype.hasOwnProperty.call(moments, id);

const MOMENTS: MomentDef[] = [
  {
    id: 'first_conquest',
    title: 'First Conquest',
    description: 'You secured your first additional system.',
    prestigeReward: 5,
    when: (ctx) => ctx.engagement.stats.systemsConquered >= 1,
  },
  {
    id: 'first_victory',
    title: 'First Victory',
    description: 'You won your first battle.',
    prestigeReward: 4,
    when: (ctx) => ctx.engagement.stats.battlesWon >= 1,
  },
  {
    id: 'gas_secured',
    title: 'Fuel the War Machine',
    description: 'You secured your first gas giant under your control.',
    prestigeReward: 4,
    when: (ctx) => ctx.metrics.gasSystemsOwnedNext >= 1,
  },
  {
    id: 'expansion_5',
    title: 'Growing Influence',
    description: 'You reached 5 controlled systems.',
    prestigeReward: 6,
    when: (ctx) => ctx.metrics.systemsOwnedNext >= 5,
  },
  {
    id: 'war_machine_3',
    title: 'War Machine',
    description: 'You reached 3 total victories.',
    prestigeReward: 8,
    when: (ctx) => ctx.engagement.stats.battlesWon >= 3,
  },
];

export default {
  id: 'engagement.10_moments',
  afterTurn: (ctx) => {
    const unlocked: MomentDef[] = [];

    for (const def of MOMENTS) {
      if (hasMoment(ctx.engagement.moments, def.id)) continue;
      if (!def.when(ctx)) continue;
      unlocked.push(def);
    }

    if (unlocked.length === 0) return { engagement: ctx.engagement };

    let prestigeDelta = 0;
    const nextMoments: Record<string, EngagementMomentUnlock> = { ...ctx.engagement.moments };
    const logs = [];

    for (const def of unlocked) {
      prestigeDelta += def.prestigeReward;
      nextMoments[def.id] = {
        id: def.id,
        unlockedOnDay: ctx.next.day,
        prestigeAwarded: def.prestigeReward,
      };

      logs.push(
        ctx.makeLog(
          `${MOMENT_PREFIX} ${def.title} — ${def.description} ${REWARD_PREFIX} +${def.prestigeReward} Prestige.`,
          'info'
        )
      );
    }

    return {
      engagement: {
        ...ctx.engagement,
        prestige: ctx.engagement.prestige + prestigeDelta,
        moments: nextMoments,
      },
      logs,
    };
  },
} satisfies EngagementPlugin;
