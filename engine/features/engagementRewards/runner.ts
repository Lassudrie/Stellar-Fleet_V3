import { GameState, LogEntry } from '../../../types';
import { computeTurnMetrics } from './metrics';
import { sanitizeEngagementState } from './state';
import { EngagementAfterTurnContext, EngagementAfterTurnResult, EngagementPlugin } from './types';

// --- Plugin loading ---

// Any file exporting a default EngagementPlugin under `./plugins/*.ts` will be loaded.
// This enables parallel development: plugins are isolated in new files only.
const pluginModules = import.meta.glob('./plugins/*.ts', { eager: true }) as Record<
  string,
  { default?: EngagementPlugin }
>;

let cachedPlugins: EngagementPlugin[] | null = null;

const getPlugins = (): EngagementPlugin[] => {
  if (cachedPlugins) return cachedPlugins;

  const plugins: EngagementPlugin[] = [];
  for (const mod of Object.values(pluginModules)) {
    if (!mod || !mod.default) continue;
    const p = mod.default;
    if (!p || typeof p.id !== 'string' || typeof p.afterTurn !== 'function') continue;
    plugins.push(p);
  }

  // deterministic order
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  cachedPlugins = plugins;
  return plugins;
};

// --- Runner ---

export const applyEngagementRewardsAfterTurn = (prev: GameState, next: GameState): GameState => {
  // Never write engagement logs after a win is declared (avoid post-victory noise)
  if (next.winnerFactionId) return next;

  const engagement = sanitizeEngagementState(next.engagement);
  if (!engagement.enabled) return { ...next, engagement };

  const metrics = computeTurnMetrics(prev, next);
  const playerFactionId = metrics.playerFactionId;

  // Deterministic, non-RNG log ids. Unique within the turn.
  const dayPrefix = `elog_${next.day}_`;
  let seq = next.logs.reduce((acc, l) => (typeof l.id === 'string' && l.id.startsWith(dayPrefix) ? acc + 1 : acc), 0);

  const makeLog = (text: string, type: LogEntry['type'] = 'info'): LogEntry => {
    seq += 1;
    return {
      id: `${dayPrefix}${seq}`,
      day: next.day,
      type,
      text,
    };
  };

  const plugins = getPlugins();
  if (plugins.length === 0) {
    // Framework installed but no plugins; still persist engagement state.
    return { ...next, engagement };
  }

  let currentEngagement = engagement;
  const appendedLogs: LogEntry[] = [];

  for (const plugin of plugins) {
    try {
      const ctx: EngagementAfterTurnContext = {
        prev,
        next,
        playerFactionId,
        metrics,
        engagement: currentEngagement,
        makeLog,
      };

      const res: EngagementAfterTurnResult = plugin.afterTurn(ctx);
      if (!res || typeof res !== 'object') continue;

      currentEngagement = sanitizeEngagementState(res.engagement);

      if (Array.isArray(res.logs) && res.logs.length > 0) {
        for (const l of res.logs) {
          if (!l || typeof l.text !== 'string') continue;

          const type: LogEntry['type'] = l.type === 'warning' || l.type === 'error' ? l.type : 'info';
          if (typeof l.id === 'string' && l.id.length > 0) {
            appendedLogs.push({ ...l, day: next.day, type });
          } else {
            // Ensure unique id without consuming RNG
            appendedLogs.push(makeLog(l.text, type));
          }
        }
      }
    } catch (err) {
      // Defensive: never break the turn pipeline.
      appendedLogs.push(
        makeLog(`[REWARD] Plugin "${plugin.id}" failed safely (${String((err as Error)?.message || err)}).`, 'warning')
      );
    }
  }

  if (appendedLogs.length === 0 && currentEngagement === engagement) {
    // Nothing changed
    return next;
  }

  return {
    ...next,
    engagement: currentEngagement,
    logs: [...next.logs, ...appendedLogs],
  };
};
