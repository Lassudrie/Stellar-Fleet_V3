import type { GroundUnitType } from '../../shared/types';
import { GROUND_UNIT_STATS } from '../../content/data/groundUnits';
import type { TerrainType } from './terrain';
import { K_TERRAIN_BASE } from './terrain';
import { clamp } from './utils';

export interface SituationFlags {
  spent75pctMp?: boolean;
  amphibiousOrAirborneAssault?: boolean;
}

export interface StatusFlags {
  outOfSupply?: boolean;
}

export interface KBreakdown {
  kTerrainBase: number;
  kAffinity: number;
  kTerrain: number;
  situation: Array<{ label: string; k: number }>;
  kSituationRaw: number;
  kSituationClamped: number;
  status: Array<{ label: string; k: number }>;
  kStatusRaw: number;
  kStatusClamped: number;
  kRaw: number;
  kFinal: number;
}

const affinityOrDefault = (unitType: GroundUnitType, terrain: TerrainType): number => {
  const raw = GROUND_UNIT_STATS[unitType].terrainCombatAffinity[terrain];
  return clamp(raw ?? 1, 0.7, 1.3);
};

export const computeKBreakdown = (params: {
  unitType: GroundUnitType;
  terrainType: TerrainType;
  situation?: SituationFlags;
  status?: StatusFlags;
}): KBreakdown => {
  const { unitType, terrainType } = params;
  const situationFlags = params.situation ?? {};
  const statusFlags = params.status ?? {};

  const kTerrainBase = K_TERRAIN_BASE[terrainType];
  const kAffinity = affinityOrDefault(unitType, terrainType);
  const kTerrain = kTerrainBase * kAffinity;

  const situation: Array<{ label: string; k: number }> = [];
  if (situationFlags.spent75pctMp) situation.push({ label: 'spent_75pct_mp', k: 0.9 });
  if (situationFlags.amphibiousOrAirborneAssault) situation.push({ label: 'amphibious_or_airborne', k: 0.7 });
  const kSituationRaw = situation.reduce((acc, x) => acc * x.k, 1);
  const kSituationClamped = clamp(kSituationRaw, 0.7, 1.6);

  const status: Array<{ label: string; k: number }> = [];
  // NOTE: This is the minimal operational status flag required by the movement model.
  // If you have a canonical Ki table, update this constant + tests/spec.
  if (statusFlags.outOfSupply) status.push({ label: 'out_of_supply', k: 0.85 });
  const kStatusRaw = status.reduce((acc, x) => acc * x.k, 1);
  const kStatusClamped = clamp(kStatusRaw, 0.4, 1.0);

  const kRaw = kTerrain * kSituationClamped * kStatusClamped;
  const kFinal = clamp(kRaw, 0.5, 1.8);

  return {
    kTerrainBase,
    kAffinity,
    kTerrain,
    situation,
    kSituationRaw,
    kSituationClamped,
    status,
    kStatusRaw,
    kStatusClamped,
    kRaw,
    kFinal
  };
};

