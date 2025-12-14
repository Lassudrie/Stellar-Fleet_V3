import { FleetState, StarSystem } from '../../../../types';
import { distSq } from '../../../math/vec3';
import { getFleetSpeed } from '../../../systems/movement/fleetSpeed';
import { SITREP_PREFIX } from '../config';
import { EngagementPlugin } from '../types';

const summarizeDelta = (label: string, delta: number): string | null => {
  if (!Number.isFinite(delta) || delta === 0) return null;
  const sign = delta > 0 ? '+' : '';
  return `${label} ${sign}${delta}`;
};

const listTopSystems = (systems: StarSystem[], max: number): string => {
  const names = systems
    .slice(0, max)
    .map((s) => s.name)
    .filter((n) => typeof n === 'string' && n.length > 0);

  if (names.length === 0) return '';
  return names.join(', ');
};

const estimateSoonestArrivalTurns = (state: any, playerFactionId: string): number | null => {
  // We only use player fleets (no fog-of-war leaks).
  let best: number | null = null;
  for (const f of state.fleets || []) {
    if (!f || f.factionId !== playerFactionId) continue;
    if (f.state !== FleetState.MOVING) continue;
    if (!f.targetPosition || !f.position) continue;

    const speed = getFleetSpeed(f);
    if (!Number.isFinite(speed) || speed <= 0) continue;

    const dSq = distSq(f.position, f.targetPosition);
    if (!Number.isFinite(dSq) || dSq < 0) continue;

    // match the engine’s movement logic: turns = ceil(dist / speed)
    const dist = Math.sqrt(dSq);
    const turns = Math.ceil(dist / speed);
    if (!Number.isFinite(turns) || turns < 0) continue;

    if (best === null || turns < best) best = turns;
  }
  return best;
};

export default {
  id: 'engagement.sitrep',
  afterTurn: (ctx) => {
    const { prev, next, metrics, engagement, playerFactionId } = ctx;

    // Gain (immediate)
    const gains: string[] = [];
    const dSys = summarizeDelta('Systems', metrics.deltaSystemsOwned);
    if (dSys) gains.push(dSys);

    const dGas = summarizeDelta('Gas', metrics.deltaGasSystemsOwned);
    if (dGas) gains.push(dGas);

    if (metrics.battlesResolvedThisTurn > 0) {
      gains.push(`Battles ${metrics.battlesWonThisTurn}W/${metrics.battlesLostThisTurn}L`);
    }

    if (gains.length === 0) gains.push('No major changes');

    // Promise (2–6 turns): next imminent battle or arrival ETA
    const scheduledBattles = (next.battles || []).filter((b: any) => b && b.status === 'scheduled');
    const scheduledSystems = scheduledBattles
      .map((b: any) => (next.systems || []).find((s: any) => s && s.id === b.systemId))
      .filter(Boolean) as StarSystem[];

    const soonestArrivalTurns = estimateSoonestArrivalTurns(next as any, playerFactionId as any);
    const promises: string[] = [];

    if (scheduledSystems.length > 0) {
      const names = listTopSystems(scheduledSystems, 2);
      promises.push(names ? `Battle pending at ${names}` : 'Battle pending');
    }

    if (soonestArrivalTurns !== null && soonestArrivalTurns > 0) {
      promises.push(`Next arrival ETA ${soonestArrivalTurns} turn${soonestArrivalTurns === 1 ? '' : 's'}`);
    }

    if (promises.length === 0) promises.push('Next turn: review tech / movement / expansion');

    // Dilemma (choice pressure): losses, or pending conflict, or opportunity
    const dilemmas: string[] = [];
    if (metrics.deltaSystemsOwned < 0) dilemmas.push('Territory lost – stabilize the front');
    if (metrics.battlesLostThisTurn > 0) dilemmas.push('Rebuild fleets or reposition');
    if (scheduledBattles.length > 0) dilemmas.push('Decide: reinforce or disengage');

    if (dilemmas.length === 0) dilemmas.push('Opportunity: push an advantage or consolidate');

    // Short, readable SITREP line
    const year = next.startYear + (next.day - 1);

    const text =
      `${SITREP_PREFIX} Turn ${next.day} (Year ${year}) | ` +
      `Gain: ${gains.join(', ')} | ` +
      `Next: ${promises.join(', ')} | ` +
      `Choice: ${dilemmas.join(' / ')} | ` +
      `Prestige: ${engagement.prestige}`;

    return {
      engagement,
      logs: [ctx.makeLog(text, 'info')],
    };
  },
} satisfies EngagementPlugin;
