import { REWARD_PREFIX } from '../config';
import { EngagementPlugin } from '../types';

const clampNonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export default {
  id: 'engagement.00_progression',
  afterTurn: (ctx) => {
    const { metrics } = ctx;

    const conquest = clampNonNegative(metrics.systemsConqueredThisTurn);
    const wins = clampNonNegative(metrics.battlesWonThisTurn);
    const gasDelta = clampNonNegative(metrics.deltaGasSystemsOwned);

    // Lightweight, deterministic prestige progression.
    const prestigeDelta = conquest * 2 + wins * 1 + gasDelta * 1;

    if (prestigeDelta <= 0) {
      // Still update cumulative stats (for moments/objectives triggers)
      const nextEngagement = {
        ...ctx.engagement,
        stats: {
          battlesWon: ctx.engagement.stats.battlesWon + wins,
          battlesLost: ctx.engagement.stats.battlesLost + clampNonNegative(metrics.battlesLostThisTurn),
          systemsConquered: ctx.engagement.stats.systemsConquered + conquest,
        },
      };

      return { engagement: nextEngagement };
    }

    const nextEngagement = {
      ...ctx.engagement,
      prestige: ctx.engagement.prestige + prestigeDelta,
      stats: {
        battlesWon: ctx.engagement.stats.battlesWon + wins,
        battlesLost: ctx.engagement.stats.battlesLost + clampNonNegative(metrics.battlesLostThisTurn),
        systemsConquered: ctx.engagement.stats.systemsConquered + conquest,
      },
    };

    const causes: string[] = [];
    if (conquest > 0) causes.push(`+${conquest} system${conquest === 1 ? '' : 's'}`);
    if (wins > 0) causes.push(`${wins} victory${wins === 1 ? '' : 'ies'}`);
    if (gasDelta > 0) causes.push(`+${gasDelta} gas`);

    const msg = `${REWARD_PREFIX} +${prestigeDelta} Prestige (${causes.join(', ')}).`;

    return {
      engagement: nextEngagement,
      logs: [ctx.makeLog(msg, 'info')],
    };
  },
} satisfies EngagementPlugin;
