import type {
  Biome,
  MoonData,
  PlanetData,
  PlanetSurfaceDescriptor,
  PlanetSurfaceMap,
  PlanetSurfaceTile,
  Settlement
} from '../../shared/types';
import { FeatureBits } from '../../shared/types';
import { RNG } from '../rng';
import { axialToIndex, indexToAxial, neighborsAxial, normalizedLatitude } from './hex';
import { domainWarp2D, fbm2D, ridgedFbm2D, valueNoise2D } from './noise';
import { deriveSurfaceParamsFromMoon, deriveSurfaceParamsFromPlanet, type SurfaceParams } from './params';

const clamp = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));

const quantile = (values: Float32Array, q: number): number => {
  const n = values.length;
  if (n === 0) return 0;
  const qq = clamp(q, 0, 1);
  const sorted = Array.from(values);
  sorted.sort((a, b) => a - b);
  const idx = Math.floor(qq * (n - 1));
  return sorted[idx];
};

const isWaterBiome = (b: Biome): boolean => b === 'ocean' || b === 'coast' || b === 'lake';

const computeOceanConnectedMask = (waterMask: Uint8Array, w: number, h: number, wrapX: boolean): Uint8Array => {
  // Flood-fill from north & south edges to mark "ocean-connected" water.
  const ocean = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const push = (idx: number) => {
    ocean[idx] = 1;
    queue[tail++] = idx;
  };

  for (let q = 0; q < w; q += 1) {
    const top = q;
    const bottom = (h - 1) * w + q;
    if (waterMask[top] && !ocean[top]) push(top);
    if (waterMask[bottom] && !ocean[bottom]) push(bottom);
  }

  while (head < tail) {
    const idx = queue[head++];
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    for (const n of ns) {
      const ni = axialToIndex(n, w);
      if (!waterMask[ni] || ocean[ni]) continue;
      push(ni);
    }
  }

  return ocean;
};

const bfsDistanceToWater = (waterMask: Uint8Array, w: number, h: number, wrapX: boolean): Uint16Array => {
  const dist = new Uint16Array(w * h);
  dist.fill(0xffff);

  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < waterMask.length; i += 1) {
    if (!waterMask[i]) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }

  while (head < tail) {
    const idx = queue[head++];
    const d = dist[idx];
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    for (const n of ns) {
      const ni = axialToIndex(n, w);
      if (dist[ni] !== 0xffff) continue;
      dist[ni] = (d + 1) as any;
      queue[tail++] = ni;
    }
  }

  return dist;
};

const computeSlope = (idx: number, elev: Float32Array, w: number, h: number, wrapX: boolean): number => {
  const c = indexToAxial(idx, w);
  const ns = neighborsAxial(c, w, h, wrapX);
  let maxDiff = 0;
  for (const n of ns) {
    const ni = axialToIndex(n, w);
    const diff = Math.abs(elev[idx] - elev[ni]);
    if (diff > maxDiff) maxDiff = diff;
  }
  return maxDiff;
};

const placeSettlements = (params: {
  descriptor: PlanetSurfaceDescriptor;
  tiles: PlanetSurfaceTile[];
  elev: Float32Array;
  w: number;
  h: number;
  wrapX: boolean;
  seaLevelElev: number;
  ownerFactionId?: string | null;
}): Settlement[] => {
  const { descriptor, tiles, elev, w, h, wrapX, ownerFactionId } = params;
  const n = w * h;
  const rng = new RNG(descriptor.seed ^ 0x9e3779b9);

  const isLandIndex = (i: number): boolean => !isWaterBiome(tiles[i].biome);

  const pickCandidates = (k: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let safety = 0;
    while (out.length < k && safety < k * 30) {
      safety += 1;
      const idx = rng.int(0, n - 1);
      if (!isLandIndex(idx)) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  };

  const tempC = (tC2: number): number => tC2 / 2;

  const scoreSite = (idx: number, existing: number[]): number => {
    const tile = tiles[idx];
    const slope = computeSlope(idx, elev, w, h, wrapX);
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const nearWater = ns.some(nc => isWaterBiome(tiles[axialToIndex(nc, w)].biome)) ? 1 : 0;
    const t = tempC(tile.tempC2);
    const tempComfort = 1 - clamp(Math.abs(t - 18) / 45, 0, 1);

    let minDist = Infinity;
    for (const e of existing) {
      const ec = indexToAxial(e, w);
      const dq = wrapX ? Math.min(Math.abs(ec.q - c.q), w - Math.abs(ec.q - c.q)) : Math.abs(ec.q - c.q);
      const dr = Math.abs(ec.r - c.r);
      const d = Math.sqrt(dq * dq + dr * dr);
      if (d < minDist) minDist = d;
    }
    const spacing = existing.length === 0 ? 1 : clamp(minDist / 10, 0, 1);

    // Prefer moderate moisture, low slope, near water, comfortable temps.
    const moistScore = 1 - Math.abs(tile.moist / 255 - 0.55);
    const slopePenalty = clamp(slope / 1.2, 0, 1);
    return (0.35 * tempComfort + 0.25 * moistScore + 0.2 * nearWater + 0.2 * spacing) * (1 - 0.55 * slopePenalty);
  };

  const settlements: Settlement[] = [];

  const placeOne = (kind: Settlement['kind'], k: number, existing: number[]): number | null => {
    const candidates = pickCandidates(k);
    let best: { idx: number; score: number } | null = null;
    for (const idx of candidates) {
      const s = scoreSite(idx, existing);
      if (!best || s > best.score) best = { idx, score: s };
    }
    return best ? best.idx : null;
  };

  if (!ownerFactionId) {
    // Neutral: 0..1 outpost depending on RNG.
    if (rng.next() < 0.55) return [];
    const idx = placeOne('outpost', 120, []);
    if (idx === null) return [];
    const coord = indexToAxial(idx, w);
    settlements.push({
      id: rng.id('settlement'),
      name: 'Outpost',
      coord,
      factionId: undefined,
      kind: 'outpost',
      size: 1
    });
    tiles[idx].featureBits |= FeatureBits.City;
    return settlements;
  }

  // Owned: 1 capital + N cities.
  const capitalIdx = placeOne('capital', 260, []);
  const placed: number[] = [];
  if (capitalIdx !== null) {
    placed.push(capitalIdx);
    const coord = indexToAxial(capitalIdx, w);
    settlements.push({
      id: rng.id('settlement'),
      name: 'Capital',
      coord,
      factionId: ownerFactionId,
      kind: 'capital',
      size: 3
    });
    tiles[capitalIdx].featureBits |= (FeatureBits.City | FeatureBits.Capital);
  }

  const cityCount = clamp(Math.round(1 + rng.next() * 3), 1, 4);
  for (let i = 0; i < cityCount; i += 1) {
    const idx = placeOne('city', 220, placed);
    if (idx === null) break;
    placed.push(idx);
    const coord = indexToAxial(idx, w);
    settlements.push({
      id: rng.id('settlement'),
      name: `City ${i + 1}`,
      coord,
      factionId: ownerFactionId,
      kind: 'city',
      size: 1 + (rng.next() < 0.25 ? 1 : 0)
    });
    tiles[idx].featureBits |= FeatureBits.City;
  }

  return settlements;
};

const addRivers = (params: {
  tiles: PlanetSurfaceTile[];
  elev: Float32Array;
  seaLevelElev: number;
  w: number;
  h: number;
  wrapX: boolean;
}): void => {
  const { tiles, elev, seaLevelElev, w, h, wrapX } = params;
  const n = w * h;

  const downhill = new Int32Array(n);
  downhill.fill(-1);

  for (let i = 0; i < n; i += 1) {
    if (tiles[i].elev <= seaLevelElev) continue;
    const c = indexToAxial(i, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    let best = -1;
    let bestE = elev[i];
    for (const nCoord of ns) {
      const ni = axialToIndex(nCoord, w);
      const e = elev[ni];
      if (e < bestE) {
        bestE = e;
        best = ni;
      }
    }
    downhill[i] = best;
  }

  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => elev[b] - elev[a]); // high->low

  const acc = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) acc[i] = tiles[i].elev > seaLevelElev ? 1 : 0;

  for (const i of order) {
    const to = downhill[i];
    if (to >= 0) acc[to] += acc[i];
  }

  const threshold = Math.max(25, Math.floor(n / 320));
  for (let i = 0; i < n; i += 1) {
    if (tiles[i].elev <= seaLevelElev) continue;
    if (tiles[i].tempC2 <= 0) continue; // <= 0°C
    if (acc[i] >= threshold) {
      tiles[i].featureBits |= FeatureBits.River;
    }
  }
};

export const generateSurfaceMap = (params: {
  systemId: string;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  planetData?: PlanetData;
  moonData?: MoonData;
  ownerFactionId?: string | null;
}): PlanetSurfaceMap => {
  const { descriptor } = params;
  const { w, h, wrapX } = descriptor.config;
  const n = w * h;

  const env: SurfaceParams = params.planetData
    ? deriveSurfaceParamsFromPlanet(params.planetData)
    : params.moonData
      ? deriveSurfaceParamsFromMoon(params.moonData)
      : // Fallback: treat as airless small body.
        {
          surfaceClass: 'airless',
          waterFraction: 0.02,
          reliefScale: 1,
          humidityFactor: 0.05,
          latGradientK: 65,
          lapseRateK: 0,
          craterIntensity: 0.9,
          volcanismIndex: 0.1,
          riversEnabled: false
        };

  // --- Elevation field ---
  const elev = new Float32Array(n);
  const baseSeed = descriptor.seed;

  for (let r = 0; r < h; r += 1) {
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      // cylindrical: wrapX naturally supported by using q normalized
      const x = q / w;
      const y = r / h;

      const warped = domainWarp2D(baseSeed ^ 0x1b873593, x * 3.2, y * 2.4, 0.25);
      const continents = fbm2D(baseSeed ^ 0xa2b3c4d5, warped.x * 1.1, warped.y * 1.1, 5);
      const mountains = ridgedFbm2D(baseSeed ^ 0x7f4a7c15, warped.x * 2.8, warped.y * 2.8, 4);

      // crater term (airless)
      const craterNoise = (valueNoise2D(baseSeed ^ 0x165667b1, x * 6.0, y * 6.0) * 2 - 1);
      const crater = env.surfaceClass === 'airless' ? craterNoise * env.craterIntensity * 0.45 : 0;

      const raw = continents * 0.85 + mountains * 0.55 + crater;
      elev[i] = raw * env.reliefScale;
    }
  }

  const seaLevelElev = quantile(elev, env.waterFraction);

  // --- Water mask & water types (ocean vs lake) ---
  const waterMask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) waterMask[i] = elev[i] <= seaLevelElev ? 1 : 0;
  const oceanConnected = computeOceanConnectedMask(waterMask, w, h, wrapX);

  // --- Temperature field ---
  const tempC2 = new Int16Array(n);
  const baseT0K =
    (params.planetData?.temperatureK ?? params.moonData?.temperatureK ?? 220);

  for (let r = 0; r < h; r += 1) {
    const lat = normalizedLatitude(r, h);
    const latTerm = -env.latGradientK * Math.pow(Math.abs(lat), 1.45);
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const aboveSea = Math.max(0, elev[i] - seaLevelElev);
      const altTerm = -env.lapseRateK * aboveSea;
      const albedoTerm =
        params.planetData
          ? -18 * clamp((params.planetData.albedo - 0.25) / 0.6, 0, 1)
          : params.moonData
            ? -18 * clamp((params.moonData.albedo - 0.25) / 0.6, 0, 1)
            : 0;

      const localK = baseT0K + latTerm + altTerm + albedoTerm;
      const c = (localK - 273.15);
      tempC2[i] = Math.round(c * 2);
    }
  }

  // --- Moisture field (distance-to-water BFS) ---
  const dist = bfsDistanceToWater(waterMask, w, h, wrapX);
  const moistU8 = new Uint8Array(n);
  const d0 = clamp(Math.round(Math.min(w, h) / 4), 6, 12);
  for (let i = 0; i < n; i += 1) {
    if (waterMask[i]) {
      moistU8[i] = 255;
      continue;
    }
    const d = dist[i] === 0xffff ? 999 : dist[i];
    const m = 255 * Math.exp(-d / d0) * env.humidityFactor;
    moistU8[i] = Math.round(clamp(m, 0, 255));
  }

  // --- Biomes + features base ---
  const tiles: PlanetSurfaceTile[] = Array.from({ length: n }, (_, i): PlanetSurfaceTile => {
    const isWater = waterMask[i] === 1;
    let biome: Biome = 'rocky';
    if (isWater) biome = oceanConnected[i] ? 'ocean' : 'lake';

    return {
      elev: Math.round(elev[i] * 1000), // stable encoding (int-ish)
      tempC2: tempC2[i],
      moist: moistU8[i],
      biome,
      featureBits: 0
    };
  });

  // Coast refinement: water adjacent to land => coast.
  for (let i = 0; i < n; i += 1) {
    if (!isWaterBiome(tiles[i].biome)) continue;
    const c = indexToAxial(i, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const adjacentLand = ns.some(nc => !isWaterBiome(tiles[axialToIndex(nc, w)].biome));
    if (adjacentLand) tiles[i].biome = 'coast';
  }

  // Land classification
  for (let i = 0; i < n; i += 1) {
    if (isWaterBiome(tiles[i].biome)) continue;
    const elevRel = (elev[i] - seaLevelElev);
    const t = tiles[i].tempC2 / 2;
    const m = tiles[i].moist;

    if (env.surfaceClass === 'airless') {
      tiles[i].biome = elevRel > 0.6 ? 'rocky' : 'cratered';
      continue;
    }

    if (t < -18) {
      tiles[i].biome = 'ice';
      continue;
    }
    if (t < -6) {
      tiles[i].biome = m > 110 ? 'taiga' : 'tundra';
      continue;
    }
    if (elevRel > 0.85) {
      tiles[i].biome = 'mountain';
      continue;
    }

    if (t > 28 && m < 70) {
      tiles[i].biome = 'desert';
      continue;
    }
    if (t > 22 && m > 200) {
      tiles[i].biome = 'rainforest';
      continue;
    }
    if (m > 150) {
      tiles[i].biome = 'forest';
      continue;
    }
    tiles[i].biome = 'grassland';
  }

  // Volcanic hotspots (optional)
  if (env.volcanismIndex > 0.55) {
    for (let r = 0; r < h; r += 1) {
      for (let q = 0; q < w; q += 1) {
        const i = r * w + q;
        if (isWaterBiome(tiles[i].biome)) continue;
        const x = q / w;
        const y = r / h;
        const hot = fbm2D(baseSeed ^ 0xdeadbeef, x * 4.0, y * 4.0, 4);
        if (hot > 0.72 + (1 - env.volcanismIndex) * 0.25) {
          tiles[i].biome = 'volcanic';
        }
      }
    }
  }

  // Rivers
  if (env.riversEnabled) {
    addRivers({ tiles, elev, seaLevelElev, w, h, wrapX });
  }

  // Settlements (also stamps city/capital bits onto tiles)
  const settlements = placeSettlements({
    descriptor,
    tiles,
    elev,
    w,
    h,
    wrapX,
    seaLevelElev,
    ownerFactionId: params.ownerFactionId
  });

  return {
    systemId: params.systemId,
    bodyId: params.bodyId,
    descriptor,
    seaLevelElev: Math.round(seaLevelElev * 1000),
    tiles,
    settlements
  };
};
