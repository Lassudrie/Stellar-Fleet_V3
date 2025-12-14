import { ENGAGEMENT_DEFAULT_ENABLED } from './config';
import {
  EngagementState,
  EngagementObjectiveState,
  EngagementMomentUnlock,
  EngagementStats,
  EraId,
  ObjectiveKind,
  RewardAxis,
  RewardFamily,
  RewardHorizon,
} from './types';

const defaultStats = (): EngagementStats => ({
  battlesWon: 0,
  battlesLost: 0,
  systemsConquered: 0,
});

export const createDefaultEngagementState = (): EngagementState => ({
  enabled: ENGAGEMENT_DEFAULT_ENABLED,
  prestige: 0,
  era: 'EARLY',
  moments: {},
  objectives: [],
  stats: defaultStats(),
});

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const sanitizeEra = (v: unknown): EraId => {
  if (v === 'EARLY' || v === 'MID' || v === 'LATE') return v;
  return 'EARLY';
};

const sanitizeObjectiveKind = (v: unknown): ObjectiveKind => {
  if (
    v === 'CAPTURE_SYSTEMS' ||
    v === 'WIN_BATTLES' ||
    v === 'CONTROL_GAS_SYSTEMS' ||
    v === 'START_INVASIONS'
  ) {
    return v;
  }
  return 'CAPTURE_SYSTEMS';
};

const sanitizeAxis = (v: unknown): RewardAxis => {
  if (v === 'EXPLORE' || v === 'EXPAND' || v === 'EXPLOIT' || v === 'EXTERMINATE') return v;
  return 'EXPAND';
};

const sanitizeFamily = (v: unknown): RewardFamily => {
  if (
    v === 'POWER' ||
    v === 'OPTIONS' ||
    v === 'INFORMATION' ||
    v === 'CONTROL' ||
    v === 'IDENTITY' ||
    v === 'STORY'
  ) {
    return v;
  }
  return 'STORY';
};

const sanitizeHorizon = (v: unknown): RewardHorizon => {
  if (v === 'IMMEDIATE' || v === 'SHORT' || v === 'MID' || v === 'LONG') return v;
  return 'SHORT';
};

const sanitizeMomentUnlock = (raw: unknown): EngagementMomentUnlock | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id : null;
  const unlockedOnDay = isFiniteNumber(r.unlockedOnDay) ? r.unlockedOnDay : null;
  const prestigeAwarded = isFiniteNumber(r.prestigeAwarded) ? r.prestigeAwarded : null;

  if (!id || unlockedOnDay === null || prestigeAwarded === null) return null;

  return {
    id,
    unlockedOnDay,
    prestigeAwarded,
  };
};

const sanitizeObjective = (raw: unknown): EngagementObjectiveState | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id : null;
  const era = sanitizeEra(r.era);
  const title = typeof r.title === 'string' ? r.title : '';
  const description = typeof r.description === 'string' ? r.description : '';

  const axis = sanitizeAxis(r.axis);
  const family = sanitizeFamily(r.family);
  const horizon = sanitizeHorizon(r.horizon);

  const kind = sanitizeObjectiveKind(r.kind);
  const target = isFiniteNumber(r.target) ? r.target : 0;
  const progress = isFiniteNumber(r.progress) ? r.progress : 0;
  const completed = typeof r.completed === 'boolean' ? r.completed : false;
  const prestigeReward = isFiniteNumber(r.prestigeReward) ? r.prestigeReward : 0;
  const completedOnDay = isFiniteNumber(r.completedOnDay) ? r.completedOnDay : undefined;

  if (!id) return null;

  return {
    id,
    era,
    title,
    description,
    axis,
    family,
    horizon,
    kind,
    target,
    progress,
    completed,
    prestigeReward,
    completedOnDay,
  };
};

export const sanitizeEngagementState = (input: unknown): EngagementState => {
  const base = createDefaultEngagementState();
  if (!input || typeof input !== 'object') return base;

  const r = input as Record<string, unknown>;

  const enabled = typeof r.enabled === 'boolean' ? r.enabled : base.enabled;
  const prestige = isFiniteNumber(r.prestige) ? r.prestige : base.prestige;
  const era = sanitizeEra(r.era);

  const momentsRaw = r.moments;
  const moments: Record<string, EngagementMomentUnlock> = {};
  if (momentsRaw && typeof momentsRaw === 'object') {
    for (const [key, value] of Object.entries(momentsRaw as Record<string, unknown>)) {
      const m = sanitizeMomentUnlock(value);
      if (m) moments[key] = m;
    }
  }

  const objectivesRaw = Array.isArray(r.objectives) ? r.objectives : [];
  const objectives: EngagementObjectiveState[] = [];
  for (const o of objectivesRaw) {
    const so = sanitizeObjective(o);
    if (so) objectives.push(so);
  }

  const statsRaw = r.stats;
  const stats: EngagementStats = defaultStats();
  if (statsRaw && typeof statsRaw === 'object') {
    const s = statsRaw as Record<string, unknown>;
    stats.battlesWon = isFiniteNumber(s.battlesWon) ? s.battlesWon : 0;
    stats.battlesLost = isFiniteNumber(s.battlesLost) ? s.battlesLost : 0;
    stats.systemsConquered = isFiniteNumber(s.systemsConquered) ? s.systemsConquered : 0;
  }

  return {
    enabled,
    prestige,
    era,
    moments,
    objectives,
    stats,
  };
};
