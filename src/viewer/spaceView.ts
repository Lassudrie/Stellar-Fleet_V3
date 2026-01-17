import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  logger,
  sorted,
  type GameState,
  type StarSystem,
  type PlanetBody,
  type PlanetData,
  type MoonData,
  type StarData,
  type PlanetClass,
  type PlanetType,
  type MoonType,
  type Fleet,
  type PlanetSurfaceDescriptor,
  type Vec3
} from '../shared/shared';
import { getOrbitingSystem } from '../engine/orbit';
import { createPlanetSurfaceDescriptor, parseAstroRefFromBodyId } from '../engine/worldgen/planetSurfaceGenerator';
import { buildGeodesicGrid, buildGeodesicVoronoiSegments } from '../engine/worldgen/geodesicGrid';
import type { GameScenario, ScenarioViewConfig, ScenarioViewFocusMode, ScenarioViewStartScale } from '../content/scenarios';
import { createPlanetTextureFromSurface } from './planetTextureFromSurface';

const AU_METERS = 149_597_870_700;
const LY_METERS = 9_460_730_472_580_800;
const EARTH_RADIUS_METERS = 6_371_000;
const SUN_RADIUS_METERS = 695_700_000;
const EARTH_MASS_SUN = 3.003e-6;
const TWO_PI = Math.PI * 2;

export type FrameId = string;

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface FrameTransform {
  position: Vec3;
  rotation: Quaternion;
  scale: number;
}

export interface ReferenceFrame {
  id: FrameId;
  parentId?: FrameId;
  transform: FrameTransform;
}

const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const setVec3 = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

const copyVec3 = (out: Vec3, v: Vec3): Vec3 => setVec3(out, v.x, v.y, v.z);

const addVec3 = (out: Vec3, a: Vec3, b: Vec3): Vec3 => setVec3(out, a.x + b.x, a.y + b.y, a.z + b.z);

const subVec3 = (out: Vec3, a: Vec3, b: Vec3): Vec3 => setVec3(out, a.x - b.x, a.y - b.y, a.z - b.z);

const scaleVec3 = (out: Vec3, v: Vec3, s: number): Vec3 => setVec3(out, v.x * s, v.y * s, v.z * s);

const lerpVec3 = (out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 =>
  setVec3(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

const lengthVec3 = (v: Vec3): number => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

const normalizeVec3 = (out: Vec3, v: Vec3): Vec3 => {
  const len = lengthVec3(v);
  if (len <= 0) return setVec3(out, 0, 0, 1);
  return setVec3(out, v.x / len, v.y / len, v.z / len);
};

const distVec3 = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const degToRad = (deg: number): number => (deg * Math.PI) / 180;

const toThreeVec3 = (v: Vec3, out: THREE.Vector3): THREE.Vector3 => out.set(v.x, v.y, v.z);

const toThreeQuat = (q: Quaternion, out: THREE.Quaternion): THREE.Quaternion => out.set(q.x, q.y, q.z, q.w);

const fromThreeVec3 = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

const fromThreeQuat = (q: THREE.Quaternion): Quaternion => ({ x: q.x, y: q.y, z: q.z, w: q.w });

const scratchVec3A = new THREE.Vector3();
const scratchVec3B = new THREE.Vector3();
const scratchVec3C = new THREE.Vector3();
const scratchQuatA = new THREE.Quaternion();
const scratchQuatB = new THREE.Quaternion();
const scratchMatrixA = new THREE.Matrix4();
const axisX = new THREE.Vector3(1, 0, 0);
const axisY = new THREE.Vector3(0, 1, 0);
const axisZ = new THREE.Vector3(0, 0, 1);

export const composeTransform = (parent: FrameTransform, local: FrameTransform): FrameTransform => {
  const parentRotation = toThreeQuat(parent.rotation, scratchQuatA);
  const worldRotation = toThreeQuat(local.rotation, scratchQuatB).premultiply(parentRotation);

  const scaledLocalPos = toThreeVec3(local.position, scratchVec3A).multiplyScalar(parent.scale);
  scaledLocalPos.applyQuaternion(parentRotation);

  const worldPos = toThreeVec3(parent.position, scratchVec3B).add(scaledLocalPos);

  return {
    position: fromThreeVec3(worldPos),
    rotation: fromThreeQuat(worldRotation),
    scale: parent.scale * local.scale
  };
};

export const invertTransform = (transform: FrameTransform): FrameTransform => {
  const invScale = transform.scale === 0 ? 1 : 1 / transform.scale;
  const rotation = toThreeQuat(transform.rotation, scratchQuatA).invert();
  const position = toThreeVec3(transform.position, scratchVec3A).multiplyScalar(-invScale).applyQuaternion(rotation);

  return {
    position: fromThreeVec3(position),
    rotation: fromThreeQuat(rotation),
    scale: invScale
  };
};

export const frameToWorld = (transform: FrameTransform, local: Vec3): Vec3 => {
  const rotation = toThreeQuat(transform.rotation, scratchQuatA);
  const position = toThreeVec3(local, scratchVec3A).multiplyScalar(transform.scale).applyQuaternion(rotation);
  position.add(toThreeVec3(transform.position, scratchVec3B));
  return fromThreeVec3(position);
};

export const worldToFrame = (transform: FrameTransform, world: Vec3): Vec3 => {
  const invRotation = toThreeQuat(transform.rotation, scratchQuatA).invert();
  const offset = toThreeVec3(world, scratchVec3A).sub(toThreeVec3(transform.position, scratchVec3B));
  offset.applyQuaternion(invRotation);
  const invScale = transform.scale === 0 ? 1 : 1 / transform.scale;
  offset.multiplyScalar(invScale);
  return fromThreeVec3(offset);
};

export class ReferenceFrameRegistry {
  private frames = new Map<FrameId, ReferenceFrame>();
  private worldCache = new Map<FrameId, FrameTransform>();
  private revision = 0;
  private cacheRevision = new Map<FrameId, number>();

  setFrame(frame: ReferenceFrame): void {
    this.frames.set(frame.id, frame);
    this.revision += 1;
  }

  getFrame(id: FrameId): ReferenceFrame | undefined {
    return this.frames.get(id);
  }

  clear(): void {
    this.frames.clear();
    this.worldCache.clear();
    this.cacheRevision.clear();
    this.revision += 1;
  }

  getWorldTransform(id: FrameId): FrameTransform {
    const cached = this.worldCache.get(id);
    const cachedRevision = this.cacheRevision.get(id);
    if (cached && cachedRevision === this.revision) return cached;

    const frame = this.frames.get(id);
    if (!frame) {
      throw new Error(`Missing reference frame '${id}'.`);
    }

    const worldTransform = frame.parentId
      ? composeTransform(this.getWorldTransform(frame.parentId), frame.transform)
      : frame.transform;

    this.worldCache.set(id, worldTransform);
    this.cacheRevision.set(id, this.revision);
    return worldTransform;
  }

  frameToWorld(id: FrameId, local: Vec3): Vec3 {
    return frameToWorld(this.getWorldTransform(id), local);
  }

  worldToFrame(id: FrameId, world: Vec3): Vec3 {
    return worldToFrame(this.getWorldTransform(id), world);
  }
}

class Rng32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextU32(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  next(): number {
    return this.nextU32() / 0x100000000;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

const hashString = (input: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const deriveSeed = (baseSeed: number, salt: string): number => hashString(`${baseSeed}:${salt}`);

const colorFromSeed = (seed: number): string => {
  const rng = new Rng32(seed);
  const color = new THREE.Color();
  color.setHSL(rng.next(), 0.45 + rng.next() * 0.35, 0.4 + rng.next() * 0.3);
  return `#${color.getHexString()}`;
};

export type BodyKind = 'star' | 'planet' | 'moon';

export type AstroRef = {
  starIndex?: number;
  planetIndex?: number;
  moonIndex?: number;
};

export interface OrbitElements {
  semiMajorAxisMeters: number;
  eccentricity: number;
  inclinationRad: number;
  ascendingNodeRad: number;
  argPeriapsisRad: number;
  meanAnomalyAtEpochRad: number;
  periodDays: number;
  epochDays: number;
}

export interface BodyViewData {
  id: string;
  name: string;
  kind: BodyKind;
  parentId: string | null;
  radiusMeters: number;
  baseColor: string;
  markerColor?: string;
  orbit?: OrbitElements;
  axialTiltRad?: number;
  rotationPeriodDays?: number;
  massSun?: number;
  luminositySun?: number;
  teffK?: number;
  planetClass?: PlanetClass;
  planetType?: PlanetType;
  moonType?: MoonType;
  surfaceDescriptor?: PlanetSurfaceDescriptor;
  surfaceData?: {
    planetData?: PlanetData;
    moonData?: MoonData;
  };
  systemId?: string;
  astroRef?: AstroRef;
}

export interface SystemViewData {
  id: string;
  name: string;
  positionMeters: Vec3;
  markerColor: string;
  extentMeters: number;
  bodies: BodyViewData[];
  orbitingBodies: BodyViewData[];
  orbitingParentIndex: Array<number | null>;
  orbitingParentStarIndex: Array<number | null>;
  stars: BodyViewData[];
  primaryStarId: string | null;
}

export interface FleetViewData {
  id: string;
  positionMeters: Vec3;
  color: string;
  strength: number;
  systemId?: string | null;
}

export interface GalaxyViewData {
  seed: number;
  systems: SystemViewData[];
  fleets?: FleetViewData[];
}

export interface ScenarioViewSettings {
  focusSystemId: string | null;
  focusPlanetId: string | null;
  targetMeters: Vec3;
  distanceMeters: number;
  yawRad: number;
  pitchRad: number;
}

const orbitPeriodDaysFromAuMass = (semiMajorAxisAu: number, massSun: number): number => {
  const clamped = Math.max(0.01, semiMajorAxisAu);
  const safeMass = Math.max(0.1, massSun);
  return Math.max(Math.sqrt((clamped * clamped * clamped) / safeMass) * 365.25, 1);
};

const orbitPeriodDaysFromMetersMass = (semiMajorAxisMeters: number, massSun: number): number =>
  orbitPeriodDaysFromAuMass(semiMajorAxisMeters / AU_METERS, massSun);

const starColorFromTeffK = (teffK: number | undefined): string => {
  if (!Number.isFinite(teffK)) return '#ffffff';
  const anchors: Array<{ t: number; color: string }> = [
    { t: 3000, color: '#ffb36a' },
    { t: 4500, color: '#ffd2a1' },
    { t: 5800, color: '#fff4e8' },
    { t: 7500, color: '#d9f1ff' },
    { t: 10000, color: '#b9d7ff' },
    { t: 20000, color: '#93b2ff' },
    { t: 30000, color: '#8aa5ff' }
  ];
  const clamped = clamp(teffK ?? 5800, anchors[0].t, anchors[anchors.length - 1].t);
  const nextIndex = anchors.findIndex(anchor => clamped <= anchor.t);
  if (nextIndex <= 0) return anchors[0].color;
  const prev = anchors[nextIndex - 1];
  const next = anchors[nextIndex];
  const t = (clamped - prev.t) / Math.max(1e-6, next.t - prev.t);
  const prevColor = new THREE.Color(prev.color);
  const nextColor = new THREE.Color(next.color);
  prevColor.lerp(nextColor, t);
  return `#${prevColor.getHexString()}`;
};

const resolvePlanetRadiusMeters = (body: PlanetBody, planet: PlanetData | undefined): number => {
  if (planet && Number.isFinite(planet.radiusEarth)) {
    return planet.radiusEarth * EARTH_RADIUS_METERS;
  }
  return Math.max(0.25, body.size ?? 1) * EARTH_RADIUS_METERS;
};

const resolveMoonRadiusMeters = (body: PlanetBody, moon: MoonData | undefined): number => {
  if (moon && Number.isFinite(moon.radiusEarth)) {
    return moon.radiusEarth * EARTH_RADIUS_METERS;
  }
  return Math.max(0.15, body.size ?? 0.5) * EARTH_RADIUS_METERS;
};

const resolvePlanetOrbit = (planet: PlanetData, starMassSun: number, epochDays: number): OrbitElements => {
  const semiMajorAxisMeters = planet.semiMajorAxisAu * AU_METERS;
  return {
    semiMajorAxisMeters,
    eccentricity: planet.eccentricity,
    inclinationRad: degToRad(planet.orbitInclinationDeg ?? 0),
    ascendingNodeRad: degToRad(planet.orbitAscendingNodeDeg ?? 0),
    argPeriapsisRad: degToRad(planet.argPeriapsisDeg ?? 0),
    meanAnomalyAtEpochRad: degToRad(planet.meanAnomalyAtEpochDeg ?? 0),
    periodDays: orbitPeriodDaysFromAuMass(planet.semiMajorAxisAu, starMassSun),
    epochDays
  };
};

const resolveStarOrbit = (orbit: StarData['orbit'], totalMassSun: number, epochDays: number): OrbitElements | undefined => {
  if (!orbit) return undefined;
  return {
    semiMajorAxisMeters: orbit.semiMajorAxisAu * AU_METERS,
    eccentricity: orbit.eccentricity ?? 0,
    inclinationRad: degToRad(orbit.inclinationDeg ?? 0),
    ascendingNodeRad: degToRad(orbit.ascendingNodeDeg ?? 0),
    argPeriapsisRad: degToRad(orbit.argPeriapsisDeg ?? 0),
    meanAnomalyAtEpochRad: degToRad(orbit.meanAnomalyAtEpochDeg ?? orbit.phaseDeg ?? 0),
    periodDays: orbit.periodDays || orbitPeriodDaysFromAuMass(orbit.semiMajorAxisAu, totalMassSun),
    epochDays
  };
};

const resolveMoonOrbit = (
  moon: MoonData,
  hostPlanet: PlanetData | undefined,
  planetRadiusMeters: number,
  epochDays: number
): OrbitElements => {
  const semiMajorAxisMeters = moon.orbitDistanceRp * planetRadiusMeters;
  const planetMassSun = (hostPlanet?.massEarth ?? 1) * EARTH_MASS_SUN;
  return {
    semiMajorAxisMeters,
    eccentricity: moon.orbitEccentricity,
    inclinationRad: degToRad(moon.orbitInclinationDeg ?? 0),
    ascendingNodeRad: degToRad(moon.orbitAscendingNodeDeg ?? 0),
    argPeriapsisRad: degToRad(moon.argPeriapsisDeg ?? 0),
    meanAnomalyAtEpochRad: degToRad(moon.meanAnomalyAtEpochDeg ?? 0),
    periodDays: orbitPeriodDaysFromMetersMass(semiMajorAxisMeters, planetMassSun),
    epochDays
  };
};

const resolvePlanetRotationDays = (seed: number, planetType?: PlanetType): number => {
  const rng = new Rng32(seed);
  const base = planetType === 'GasGiant' || planetType === 'IceGiant' ? rng.range(0.3, 1.2) : rng.range(0.6, 2.4);
  return base;
};

const resolveMoonRotationDays = (seed: number): number => {
  const rng = new Rng32(seed);
  return rng.range(0.4, 1.8);
};

const buildBodyViewData = (params: {
  body: PlanetBody;
  gameSeed: number;
  systemId: string;
  systemSeed: number;
  planetAstro: PlanetData | undefined;
  moonAstro: MoonData | undefined;
  planetBody?: PlanetBody;
  starMassSun: number;
  parentId: string | null;
  astroRef?: AstroRef;
}): BodyViewData => {
  const { body, gameSeed, systemId, systemSeed, planetAstro, moonAstro, planetBody, starMassSun, parentId, astroRef } = params;
  const bodySeed = deriveSeed(systemSeed, `body:${body.id}`);
  const kind: BodyKind = body.bodyType === 'moon' ? 'moon' : 'planet';
  const baseColor = colorFromSeed(bodySeed);
  const surfaceDescriptor = createPlanetSurfaceDescriptor({
    gameSeed,
    systemId,
    body
  });

  if (kind === 'moon') {
    const radiusMeters = resolveMoonRadiusMeters(body, moonAstro);
    const planetRadiusMeters = resolvePlanetRadiusMeters(planetBody ?? body, planetAstro);
    const orbit = moonAstro
      ? resolveMoonOrbit(moonAstro, planetAstro, planetRadiusMeters, 0)
      : resolveMoonOrbit(
          {
            type: moonAstro?.type ?? 'Regular',
            orbitDistanceRp: 12,
            orbitEccentricity: 0.02,
            orbitInclinationDeg: 2,
            orbitAscendingNodeDeg: 0,
            argPeriapsisDeg: 0,
            meanAnomalyAtEpochDeg: 0,
            massEarth: 0.01,
            radiusEarth: 0.25,
            gravityG: 0.5,
            albedo: 0.2,
            teqK: 150,
            atmosphere: 'None',
            greenhouseK: 0,
            climateK: 150,
            airMassIndex: 0,
            temperatureK: 150,
            seasonalDeltaK: 0
          },
          planetAstro,
          planetRadiusMeters,
          0
        );

    return {
      id: body.id,
      name: body.name,
      kind,
      parentId,
      radiusMeters,
      baseColor,
      orbit,
      rotationPeriodDays: resolveMoonRotationDays(bodySeed),
      moonType: moonAstro?.type,
      surfaceDescriptor,
      surfaceData: {
        planetData: planetAstro,
        moonData: moonAstro
      },
      systemId,
      astroRef
    };
  }

  const radiusMeters = resolvePlanetRadiusMeters(body, planetAstro);
  const orbit = planetAstro
    ? resolvePlanetOrbit(planetAstro, starMassSun, 0)
    : resolvePlanetOrbit(
        {
          type: planetAstro?.type ?? 'Terrestrial',
          semiMajorAxisAu: 0.4,
          eccentricity: 0,
          orbitInclinationDeg: 0,
          orbitAscendingNodeDeg: 0,
          argPeriapsisDeg: 0,
          meanAnomalyAtEpochDeg: 0,
          axialTiltDeg: 0,
          massEarth: 1,
          radiusEarth: 1,
          gravityG: 1,
          albedo: 0.3,
          teqK: 280,
          atmosphere: 'None',
          greenhouseK: 0,
          climateK: 280,
          airMassIndex: 0,
          temperatureK: 280,
          seasonalDeltaK: 0,
          moons: []
        },
        starMassSun,
        0
      );

  return {
    id: body.id,
    name: body.name,
    kind,
    parentId,
    radiusMeters,
    baseColor,
    orbit,
    axialTiltRad: degToRad(planetAstro?.axialTiltDeg ?? 0),
    rotationPeriodDays: resolvePlanetRotationDays(bodySeed, planetAstro?.type),
    planetClass: body.class,
    planetType: planetAstro?.type,
    surfaceDescriptor,
    surfaceData: {
      planetData: planetAstro,
      moonData: moonAstro
    },
    systemId,
    astroRef
  };
};

const buildSystemViewData = (system: StarSystem, galaxySeed: number): SystemViewData => {
  const systemSeed = deriveSeed(galaxySeed, `system:${system.id}`);
  const astro = system.astro;
  const bodies: BodyViewData[] = [];
  const stars: BodyViewData[] = [];
  const orbitingBodies: BodyViewData[] = [];
  const planetIdsByIndex = new Map<number, string>();
  const planetBodiesByIndex = new Map<number, PlanetBody>();
  const primaryStar = astro?.stars?.[0];
  const starMassSun = primaryStar?.massSun ?? 1;

  let maxOrbitMeters = 0;
  let maxBodyRadius = 0;

  if (astro?.stars?.length) {
    astro.stars.forEach((star, index) => {
      const starId = `star-${system.id}-${index + 1}`;
      const orbit = resolveStarOrbit(star.orbit, starMassSun + star.massSun, 0);
      const radiusMeters = star.radiusSun * SUN_RADIUS_METERS;
      maxBodyRadius = Math.max(maxBodyRadius, radiusMeters);
      if (orbit) {
        maxOrbitMeters = Math.max(maxOrbitMeters, orbit.semiMajorAxisMeters * (1 + orbit.eccentricity));
      }
      bodies.push({
        id: starId,
        name: star.role === 'primary' ? `${system.name} A` : `${system.name} ${String.fromCharCode(66 + index - 1)}`,
        kind: 'star',
        parentId: null,
        radiusMeters,
        baseColor: starColorFromTeffK(star.teffK),
        massSun: star.massSun,
        luminositySun: star.luminositySun,
        teffK: star.teffK,
        orbit,
        astroRef: { starIndex: index }
      });
      stars.push(bodies[bodies.length - 1]);
    });
  } else {
    const fallbackStarId = `star-${system.id}-1`;
    const radiusMeters = Math.max(0.4, system.size ?? 1) * SUN_RADIUS_METERS;
    maxBodyRadius = Math.max(maxBodyRadius, radiusMeters);
    bodies.push({
      id: fallbackStarId,
      name: system.name,
      kind: 'star',
      parentId: null,
      radiusMeters,
      baseColor: '#ffffff',
      massSun: 1,
      luminositySun: 1,
      teffK: 5800,
      astroRef: { starIndex: 0 }
    });
    stars.push(bodies[bodies.length - 1]);
  }

  system.planets.forEach(body => {
    if (body.bodyType !== 'planet') return;
    const astroRef = parseAstroRefFromBodyId(system.id, body.id);
    if (!astroRef || astroRef.planetIndex === undefined) {
      logger.warn(`[ViewData] Missing astroRef for planet body '${body.id}' in system '${system.id}'.`);
      return;
    }
    planetIdsByIndex.set(astroRef.planetIndex, body.id);
    planetBodiesByIndex.set(astroRef.planetIndex, body);
  });

  system.planets.forEach(body => {
    if (body.bodyType !== 'planet') return;
    const astroRef = parseAstroRefFromBodyId(system.id, body.id);
    const planetIndex = astroRef?.planetIndex;
    const planetAstro = planetIndex !== undefined ? astro?.planets?.[planetIndex] : undefined;
    if (planetIndex !== undefined && !planetAstro) {
      logger.warn(`[ViewData] Missing astro planet data for '${body.id}' (planetIndex=${planetIndex}) in '${system.id}'.`);
    }
    const bodyData = buildBodyViewData({
      body,
      gameSeed: galaxySeed,
      systemId: system.id,
      systemSeed,
      planetAstro,
      moonAstro: undefined,
      starMassSun,
      parentId: bodies.find(candidate => candidate.kind === 'star')?.id ?? null,
      astroRef
    });
    bodies.push(bodyData);
    orbitingBodies.push(bodyData);
    maxOrbitMeters = Math.max(maxOrbitMeters, bodyData.orbit?.semiMajorAxisMeters ?? 0);
    maxBodyRadius = Math.max(maxBodyRadius, bodyData.radiusMeters);
  });

  system.planets.forEach(body => {
    if (body.bodyType !== 'moon') return;
    const astroRef = parseAstroRefFromBodyId(system.id, body.id);
    const planetIndex = astroRef?.planetIndex;
    const moonIndex = astroRef?.moonIndex;
    const planetAstro = planetIndex !== undefined ? astro?.planets?.[planetIndex] : undefined;
    const moonAstro = planetIndex !== undefined && moonIndex !== undefined ? planetAstro?.moons?.[moonIndex] : undefined;
    const parentId = planetIndex !== undefined ? planetIdsByIndex.get(planetIndex) ?? null : null;
    const planetBody = planetIndex !== undefined ? planetBodiesByIndex.get(planetIndex) : undefined;
    if (planetIndex === undefined || moonIndex === undefined) {
      logger.warn(`[ViewData] Missing astroRef for moon body '${body.id}' in system '${system.id}'.`);
    } else if (!moonAstro) {
      logger.warn(`[ViewData] Missing astro moon data for '${body.id}' (planetIndex=${planetIndex}, moonIndex=${moonIndex}) in '${system.id}'.`);
    }
    const bodyData = buildBodyViewData({
      body,
      gameSeed: galaxySeed,
      systemId: system.id,
      systemSeed,
      planetAstro,
      moonAstro,
      planetBody,
      starMassSun,
      parentId,
      astroRef
    });
    bodies.push(bodyData);
    orbitingBodies.push(bodyData);
    maxOrbitMeters = Math.max(maxOrbitMeters, bodyData.orbit?.semiMajorAxisMeters ?? 0);
    maxBodyRadius = Math.max(maxBodyRadius, bodyData.radiusMeters);
  });

  const extentMeters = Math.max(maxBodyRadius * 2, maxOrbitMeters + maxBodyRadius);
  const primaryStarId = bodies.find(body => body.kind === 'star' && body.astroRef?.starIndex === 0)?.id ?? null;
  const orbitingIndexById = new Map(orbitingBodies.map((body, index) => [body.id, index]));
  const starIndexById = new Map(stars.map((star, index) => [star.id, index]));
  const orbitingParentIndex = orbitingBodies.map(body => (body.parentId ? orbitingIndexById.get(body.parentId) ?? null : null));
  const orbitingParentStarIndex = orbitingBodies.map(body =>
    body.parentId ? starIndexById.get(body.parentId) ?? null : null
  );

  return {
    id: system.id,
    name: system.name,
    positionMeters: scaleVec3(vec3(), system.position, LY_METERS),
    markerColor: system.color || colorFromSeed(systemSeed),
    extentMeters,
    bodies,
    orbitingBodies,
    orbitingParentIndex,
    orbitingParentStarIndex,
    stars,
    primaryStarId
  };
};

const buildFleetViewData = (fleet: Fleet, systems: StarSystem[], factionColors: Map<string, string>): FleetViewData => {
  const orbitingSystem = getOrbitingSystem(fleet, systems);
  return {
    id: fleet.id,
    positionMeters: scaleVec3(vec3(), fleet.position, LY_METERS),
    color: factionColors.get(fleet.factionId) ?? '#ffffff',
    strength: fleet.ships.length,
    systemId: orbitingSystem?.id ?? null
  };
};

export const buildGalaxyViewDataFromState = (state: GameState): GalaxyViewData => {
  const factionColors = new Map(state.factions.map(faction => [faction.id, faction.color]));
  const systems = state.systems;
  return {
    seed: state.seed,
    systems: systems.map(system => buildSystemViewData(system, state.seed)),
    fleets: state.fleets.map(fleet => buildFleetViewData(fleet, systems, factionColors))
  };
};

const getGalaxyRadiusMeters = (data: GalaxyViewData): number => {
  let maxDistance = 1;
  for (const system of data.systems) {
    const distance = lengthVec3(system.positionMeters) + system.extentMeters;
    if (distance > maxDistance) maxDistance = distance;
  }
  return maxDistance;
};

const resolveFocusSystemId = (state: GameState, view?: ScenarioViewConfig): string | null => {
  const focusMode: ScenarioViewFocusMode = view?.focus?.mode ?? 'player_homeworld';
  const sortedSystems = sorted(state.systems, (a, b) => a.id.localeCompare(b.id));
  const homeworld = sortedSystems.find(
    system => system.isHomeworld && system.ownerFactionId === state.playerFactionId
  );
  const firstSystemId = sortedSystems[0]?.id ?? null;

  if (focusMode === 'system_id') {
    return view?.focus?.systemId ?? homeworld?.id ?? firstSystemId;
  }
  if (focusMode === 'first_system') {
    return firstSystemId ?? homeworld?.id ?? null;
  }
  return homeworld?.id ?? firstSystemId;
};

const resolveFocusPlanetId = (
  stateSystem: StarSystem | undefined,
  view?: ScenarioViewConfig,
  startScale?: ScenarioViewStartScale
): string | null => {
  const explicitPlanetId = view?.focus?.planetId;
  if (explicitPlanetId) return explicitPlanetId;
  if (!stateSystem || startScale !== 'planet') return null;

  const sortedBodies = sorted(stateSystem.planets, (a, b) => a.id.localeCompare(b.id));
  const solid = sortedBodies.find(body => body.isSolid && body.bodyType === 'planet');
  return solid?.id ?? sortedBodies.find(body => body.bodyType === 'planet')?.id ?? null;
};

export const resolveScenarioViewSettings = (
  state: GameState,
  data: GalaxyViewData,
  scenario?: GameScenario
): ScenarioViewSettings => {
  const view = scenario?.view;
  const focusSystemId = resolveFocusSystemId(state, view);
  const dataSystems = sorted(data.systems, (a, b) => a.id.localeCompare(b.id));
  const focusSystemData =
    (focusSystemId ? data.systems.find(system => system.id === focusSystemId) : null) ?? dataSystems[0] ?? null;
  const resolvedSystemId = focusSystemData?.id ?? null;
  const stateSystem = resolvedSystemId ? state.systems.find(system => system.id === resolvedSystemId) : undefined;

  const startScale: ScenarioViewStartScale = view?.camera?.startScale ?? (view?.focus?.planetId ? 'planet' : 'galaxy');
  const focusPlanetId = resolveFocusPlanetId(stateSystem, view, startScale);
  const planetData = focusPlanetId ? focusSystemData?.orbitingBodies.find(planet => planet.id === focusPlanetId) : undefined;

  const targetMeters =
    focusSystemData && planetData
      ? addVec3(vec3(), focusSystemData.positionMeters, computeOrbitPositionMeters(planetData, state.day))
      : focusSystemData?.positionMeters ?? vec3();

  let distanceMeters = view?.camera?.distanceMeters;
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) {
    const galaxyRadius = data.systems.length > 0 ? getGalaxyRadiusMeters(data) : 1;
    if (startScale === 'planet' && planetData) {
      distanceMeters = planetData.radiusMeters * 6;
    } else if (startScale === 'system' && focusSystemData) {
      distanceMeters = focusSystemData.extentMeters * 4;
    } else {
      distanceMeters = galaxyRadius * 1.6;
    }
  }

  const yawCandidate = view?.camera?.yawRad;
  const pitchCandidate = view?.camera?.pitchRad;
  const yawRad = typeof yawCandidate === 'number' && Number.isFinite(yawCandidate) ? yawCandidate : 0;
  const pitchDefault = typeof pitchCandidate === 'number' && Number.isFinite(pitchCandidate) ? pitchCandidate : 0.25;
  const pitchRad = clamp(pitchDefault, -1.4, 1.4);

  return {
    focusSystemId: resolvedSystemId,
    focusPlanetId: planetData?.id ?? null,
    targetMeters,
    distanceMeters: Math.max(1, distanceMeters),
    yawRad,
    pitchRad
  };
};

export const syncSpaceViewWithState = (view: SpaceView, state: GameState): GalaxyViewData => {
  const data = buildGalaxyViewDataFromState(state);
  view.setData(data);
  return data;
};

export interface CreateScenarioViewOptions {
  canvas: HTMLCanvasElement;
  state: GameState;
  scenario?: GameScenario;
  viewOptions?: Omit<SpaceViewOptions, 'canvas' | 'data'>;
}

export interface ScenarioViewHandle {
  view: SpaceView;
  data: GalaxyViewData;
  settings: ScenarioViewSettings;
}

export const createScenarioView = (options: CreateScenarioViewOptions): ScenarioViewHandle => {
  const data = buildGalaxyViewDataFromState(options.state);
  const view = new SpaceView({ canvas: options.canvas, data, ...(options.viewOptions ?? {}) });
  const settings = resolveScenarioViewSettings(options.state, data, options.scenario);
  view.setCameraPose({
    targetMeters: settings.targetMeters,
    yawRad: settings.yawRad,
    pitchRad: settings.pitchRad,
    distanceMeters: settings.distanceMeters
  });
  view.update(0, options.state.day);
  return { view, data, settings };
};

class HysteresisGate {
  private active: boolean;
  private enter: number;
  private exit: number;

  constructor(enter: number, exit: number, initial = false) {
    this.enter = enter;
    this.exit = exit;
    this.active = initial;
  }

  update(value: number): boolean {
    if (this.active) {
      if (value <= this.exit) {
        this.active = false;
      }
    } else if (value >= this.enter) {
      this.active = true;
    }
    return this.active;
  }
}

class CrossFade {
  value = 0;
  private speed: number;

  constructor(durationSeconds: number) {
    this.speed = durationSeconds > 0 ? 1 / durationSeconds : 1;
  }

  update(dt: number, targetOn: boolean): number {
    const target = targetOn ? 1 : 0;
    if (this.value === target) return this.value;

    const step = this.speed * dt;
    if (this.value < target) {
      this.value = Math.min(target, this.value + step);
    } else {
      this.value = Math.max(target, this.value - step);
    }
    return this.value;
  }
}

class FloatingOriginManager {
  private snapMeters: number;
  originMeters: Vec3 = vec3();

  constructor(snapMeters: number) {
    this.snapMeters = snapMeters;
  }

  update(cameraWorldMeters: Vec3): Vec3 {
    if (this.snapMeters <= 0) {
      return copyVec3(this.originMeters, cameraWorldMeters);
    }

    return setVec3(
      this.originMeters,
      Math.round(cameraWorldMeters.x / this.snapMeters) * this.snapMeters,
      Math.round(cameraWorldMeters.y / this.snapMeters) * this.snapMeters,
      Math.round(cameraWorldMeters.z / this.snapMeters) * this.snapMeters
    );
  }
}

class StreamingQueue {
  private pending = new Set<string>();
  private queue: Array<{ key: string; run: () => void }> = [];

  enqueue(key: string, run: () => void): void {
    if (this.pending.has(key)) return;
    this.pending.add(key);

    const insertIndex = this.queue.findIndex(entry => entry.key.localeCompare(key) > 0);
    if (insertIndex === -1) {
      this.queue.push({ key, run });
    } else {
      this.queue.splice(insertIndex, 0, { key, run });
    }
  }

  process(maxTasks: number): void {
    const limit = Math.max(0, maxTasks);
    for (let i = 0; i < limit && this.queue.length > 0; i += 1) {
      const task = this.queue.shift();
      if (!task) break;
      task.run();
      this.pending.delete(task.key);
    }
  }
}

class ZoomController {
  logDistance = 0;
  targetLogDistance = 0;
  minLogDistance = 0;
  maxLogDistance = 0;
  zoomSpeed = 0.12;
  smoothing = 8;

  constructor(initialDistanceMeters: number, minDistanceMeters: number, maxDistanceMeters: number) {
    this.setBounds(minDistanceMeters, maxDistanceMeters);
    this.logDistance = Math.log2(clamp(initialDistanceMeters, minDistanceMeters, maxDistanceMeters));
    this.targetLogDistance = this.logDistance;
  }

  setBounds(minDistanceMeters: number, maxDistanceMeters: number): void {
    this.minLogDistance = Math.log2(Math.max(1, minDistanceMeters));
    this.maxLogDistance = Math.log2(Math.max(minDistanceMeters + 1, maxDistanceMeters));
    this.targetLogDistance = clamp(this.targetLogDistance, this.minLogDistance, this.maxLogDistance);
  }

  setDistanceMeters(distanceMeters: number): void {
    const minDistance = Math.pow(2, this.minLogDistance);
    const maxDistance = Math.pow(2, this.maxLogDistance);
    const clamped = clamp(distanceMeters, minDistance, maxDistance);
    const logValue = Math.log2(clamped);
    this.logDistance = logValue;
    this.targetLogDistance = logValue;
  }

  applyZoomDelta(delta: number): void {
    const distanceFactor = clamp(1 + (this.logDistance - this.minLogDistance) * 0.12, 1, 4);
    this.targetLogDistance = clamp(
      this.targetLogDistance + delta * this.zoomSpeed * distanceFactor,
      this.minLogDistance,
      this.maxLogDistance
    );
  }

  update(dt: number): void {
    const diff = this.targetLogDistance - this.logDistance;
    const step = clamp(diff * this.smoothing * dt, -Math.abs(diff), Math.abs(diff));
    this.logDistance += step;
  }

  get distanceMeters(): number {
    return Math.pow(2, this.logDistance);
  }
}

class CameraRig {
  targetMeters: Vec3 = vec3();
  yaw = 0;
  pitch = 0.25;
  panSpeed = 0.002;
  orbitSpeed = 0.003;

  private zoom: ZoomController;
  private worldPositionMeters: Vec3 = vec3();
  private worldQuaternion = new THREE.Quaternion();
  private lookMatrix = new THREE.Matrix4();

  constructor(zoom: ZoomController) {
    this.zoom = zoom;
  }

  setTargetMeters(position: Vec3): void {
    copyVec3(this.targetMeters, position);
  }

  applyOrbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw * this.orbitSpeed;
    this.pitch = clamp(this.pitch + deltaPitch * this.orbitSpeed, -1.4, 1.4);
  }

  applyPan(deltaX: number, deltaY: number): void {
    const distance = this.zoom.distanceMeters;
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);

    const forward = scratchVec3A.set(cosPitch * cosYaw, sinPitch, cosPitch * sinYaw).normalize();
    const right = scratchVec3B.crossVectors(forward, axisY).normalize();
    const up = scratchVec3C.crossVectors(right, forward).normalize();

    const scale = distance * this.panSpeed;
    this.targetMeters.x += (-deltaX * right.x + deltaY * up.x) * scale;
    this.targetMeters.y += (-deltaX * right.y + deltaY * up.y) * scale;
    this.targetMeters.z += (-deltaX * right.z + deltaY * up.z) * scale;
  }

  update(dt: number): { positionMeters: Vec3; quaternion: THREE.Quaternion } {
    this.zoom.update(dt);

    const distance = this.zoom.distanceMeters;
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const cosYaw = Math.cos(this.yaw);
    const sinYaw = Math.sin(this.yaw);

    const dir = scratchVec3A.set(cosPitch * cosYaw, sinPitch, cosPitch * sinYaw);
    const position = scratchVec3B.copy(dir).multiplyScalar(distance).add(toThreeVec3(this.targetMeters, scratchVec3A));

    copyVec3(this.worldPositionMeters, fromThreeVec3(position));

    this.lookMatrix.lookAt(position, toThreeVec3(this.targetMeters, scratchVec3A), axisY);
    this.worldQuaternion.setFromRotationMatrix(this.lookMatrix);

    return { positionMeters: this.worldPositionMeters, quaternion: this.worldQuaternion };
  }
}

export interface SpaceViewThresholds {
  systemEnterPx: number;
  systemExitPx: number;
  systemPreloadPx: number;
  planetEnterPx: number;
  planetExitPx: number;
  planetPreloadPx: number;
  planetMeshEnterPx: number;
  planetMeshExitPx: number;
  crossFadeSeconds: number;
}

export interface SpaceViewScales {
  metersPerGalaxyUnit: number;
  metersPerSystemUnit: number;
  metersPerPlanetUnit: number;
}

export interface SpaceViewOptions {
  canvas: HTMLCanvasElement;
  data: GalaxyViewData;
  pixelRatio?: number;
  fovDeg?: number;
  thresholds?: Partial<SpaceViewThresholds>;
  scales?: Partial<SpaceViewScales>;
  backgroundColor?: string;
  maxDistanceMeters?: number;
  minDistanceMeters?: number;
  maxTasksPerFrame?: number;
  floatingOriginSnapMeters?: number;
  timeScaleDaysPerSecond?: number;
  debugOverlayMode?: 'voronoi' | 'triangulated' | 'both';
  debugSurfaceMode?: 'albedo' | 'biome';
  orbitLineMode?: 'line2' | 'basic';
}

type SystemAssets = {
  group: THREE.Group;
  orbitGroup: THREE.Group;
  starMeshes: THREE.Mesh[];
  starMaterials: THREE.MeshBasicMaterial[];
  starLights: THREE.PointLight[];
  starHalos: THREE.Sprite[];
  starData: BodyViewData[];
  starPositions: Vec3[];
  orbitLines: Array<THREE.Line | Line2>;
  orbitMaterials: Array<THREE.LineBasicMaterial | LineMaterial>;
  orbitGeometries: Array<THREE.BufferGeometry | LineGeometry>;
  bodyMesh: THREE.InstancedMesh;
  bodyMaterial: THREE.MeshStandardMaterial;
  bodyPointGeometry: THREE.BufferGeometry;
  bodyPointMaterial: THREE.PointsMaterial;
  bodyPoints: THREE.Points;
  bodyData: BodyViewData[];
  bodyPositions: Vec3[];
  bodyParentIndex: Array<number | null>;
  bodyParentStarIndex: Array<number | null>;
  orbitParents: Array<number | null>;
  orbitParentStars: Array<number | null>;
  maxOrbitMeters: number;
};

type PlanetAssets = {
  group: THREE.Group;
  tiltGroup: THREE.Group;
  spinGroup: THREE.Group;
  bodyMesh: THREE.Mesh;
  bodyMaterial: THREE.MeshStandardMaterial;
  atmosphereMesh: THREE.Mesh;
  atmosphereMaterial: THREE.MeshPhysicalMaterial;
  cloudMesh: THREE.Mesh;
  cloudMaterial: THREE.MeshPhysicalMaterial;
  ringMesh: THREE.Mesh | null;
  overlayMesh: THREE.LineSegments;
  overlayMaterial: THREE.LineBasicMaterial;
  triOverlayMesh: THREE.LineSegments | null;
  triOverlayMaterial: THREE.LineBasicMaterial | null;
  planetData: BodyViewData;
  textureState: {
    seed: number;
    resolution: number;
    targetResolution: number;
  };
  rotationSpeedRadPerDay: number;
  axialTiltRad: number;
  starLights: THREE.DirectionalLight[];
  starLightTargets: THREE.Object3D[];
};

const getSphereGeometry = (() => {
  const cache = new Map<string, THREE.SphereGeometry>();
  return (segments: number, rings: number): THREE.SphereGeometry => {
    const key = `${segments}:${rings}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const geometry = new THREE.SphereGeometry(1, segments, rings);
    geometry.userData.shared = true;
    cache.set(key, geometry);
    return geometry;
  };
})();

const getVoronoiOverlayGeometry = (() => {
  const cache = new Map<number, THREE.BufferGeometry>();
  return (frequency: number): THREE.BufferGeometry => {
    const freq = Math.max(1, Math.floor(frequency));
    const cached = cache.get(freq);
    if (cached) return cached;
    const grid = buildGeodesicGrid(freq);
    const segments = buildGeodesicVoronoiSegments(grid);
    const positions = new Float32Array(segments.length * 3);
    segments.forEach((segment, index) => {
      const baseIndex = index * 3;
      positions[baseIndex] = segment.x;
      positions[baseIndex + 1] = segment.y;
      positions[baseIndex + 2] = segment.z;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.userData.shared = true;
    cache.set(freq, geometry);
    return geometry;
  };
})();

const isSharedGeometry = (geometry: { userData?: Record<string, unknown> } | null | undefined): boolean =>
  Boolean(geometry && geometry.userData && geometry.userData.shared);

const disposeMaterial = (material: THREE.Material | THREE.Material[] | null | undefined): void => {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach(entry => entry.dispose());
    return;
  }
  material.dispose();
};

const disposeObject3D = (root: THREE.Object3D): void => {
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    const geometry = (mesh as any).geometry as THREE.BufferGeometry | LineGeometry | undefined;
    if (geometry && !isSharedGeometry(geometry)) {
      geometry.dispose();
    }
    const material = (mesh as any).material as THREE.Material | THREE.Material[] | undefined;
    if (material) {
      disposeMaterial(material);
    }
  });
};

const solveKeplerEccentricAnomaly = (meanAnomalyRad: number, eccentricity: number): number => {
  const e = clamp(eccentricity, 0, 0.999);
  let E = meanAnomalyRad;
  if (e < 1e-4) return meanAnomalyRad;
  for (let i = 0; i < 8; i += 1) {
    const f = E - e * Math.sin(E) - meanAnomalyRad;
    const fPrime = 1 - e * Math.cos(E);
    E -= f / Math.max(1e-6, fPrime);
  }
  return E;
};

const computeOrbitPositionFromMeanAnomaly = (
  orbit: OrbitElements,
  meanAnomalyRad: number,
  out: THREE.Vector3
): THREE.Vector3 => {
  const E = solveKeplerEccentricAnomaly(meanAnomalyRad, orbit.eccentricity);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = orbit.semiMajorAxisMeters * (1 - orbit.eccentricity * cosE);
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - orbit.eccentricity * orbit.eccentricity) * sinE,
    cosE - orbit.eccentricity
  );

  out.set(Math.cos(trueAnomaly) * r, 0, Math.sin(trueAnomaly) * r);
  out.applyAxisAngle(axisZ, orbit.argPeriapsisRad);
  out.applyAxisAngle(axisX, orbit.inclinationRad);
  out.applyAxisAngle(axisZ, orbit.ascendingNodeRad);
  return out;
};

const getOrbitPositions = (() => {
  const cache = new Map<string, Float32Array>();
  return (orbit: OrbitElements, unitsScale: number, segments = 192): Float32Array => {
    const key = [
      Math.round(orbit.semiMajorAxisMeters / 1000),
      Math.round(orbit.eccentricity * 10000),
      Math.round(orbit.inclinationRad * 10000),
      Math.round(orbit.ascendingNodeRad * 10000),
      Math.round(orbit.argPeriapsisRad * 10000),
      Math.round(unitsScale * 1000),
      segments
    ].join('|');
    const cached = cache.get(key);
    if (cached) return cached;

    const positions = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i += 1) {
      const meanAnomaly = (i / segments) * TWO_PI;
      const position = computeOrbitPositionFromMeanAnomaly(orbit, meanAnomaly, scratchVec3A);
      const baseIndex = i * 3;
      positions[baseIndex] = position.x / unitsScale;
      positions[baseIndex + 1] = position.y / unitsScale;
      positions[baseIndex + 2] = position.z / unitsScale;
    }
    cache.set(key, positions);
    return positions;
  };
})();

const getOrbitGeometry = (() => {
  const cache = new Map<string, THREE.BufferGeometry>();
  return (orbit: OrbitElements, unitsScale: number, segments = 192): THREE.BufferGeometry => {
    const key = [
      Math.round(orbit.semiMajorAxisMeters / 1000),
      Math.round(orbit.eccentricity * 10000),
      Math.round(orbit.inclinationRad * 10000),
      Math.round(orbit.ascendingNodeRad * 10000),
      Math.round(orbit.argPeriapsisRad * 10000),
      Math.round(unitsScale * 1000),
      segments
    ].join('|');
    const cached = cache.get(key);
    if (cached) return cached;

    const positions = getOrbitPositions(orbit, unitsScale, segments);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.userData.shared = true;
    cache.set(key, geometry);
    return geometry;
  };
})();

const getOrbitLineGeometry = (() => {
  const cache = new Map<string, LineGeometry>();
  return (orbit: OrbitElements, unitsScale: number, segments = 192): LineGeometry => {
    const key = [
      Math.round(orbit.semiMajorAxisMeters / 1000),
      Math.round(orbit.eccentricity * 10000),
      Math.round(orbit.inclinationRad * 10000),
      Math.round(orbit.ascendingNodeRad * 10000),
      Math.round(orbit.argPeriapsisRad * 10000),
      Math.round(unitsScale * 1000),
      segments
    ].join('|');
    const cached = cache.get(key);
    if (cached) return cached;
    const geometry = new LineGeometry();
    geometry.setPositions(getOrbitPositions(orbit, unitsScale, segments));
    geometry.userData.shared = true;
    cache.set(key, geometry);
    return geometry;
  };
})();

const screenSpaceRadiusPx = (radiusMeters: number, distanceMeters: number, fovRad: number, heightPx: number): number => {
  if (distanceMeters <= 0) return heightPx;
  const projectionFactor = heightPx / (2 * Math.tan(fovRad / 2));
  return (radiusMeters * projectionFactor) / distanceMeters;
};

const computeOrbitPositionMeters = (body: BodyViewData, timeDays: number, out?: Vec3): Vec3 => {
  if (!body.orbit) return out ? setVec3(out, 0, 0, 0) : vec3();
  const meanMotion = TWO_PI / Math.max(1e-6, body.orbit.periodDays);
  const meanAnomaly = body.orbit.meanAnomalyAtEpochRad + meanMotion * (timeDays - body.orbit.epochDays);
  const position = computeOrbitPositionFromMeanAnomaly(body.orbit, meanAnomaly, scratchVec3A);
  const result = out ?? vec3();
  return setVec3(result, position.x, position.y, position.z);
};

const computeOrbitPositionFromTime = (orbit: OrbitElements, timeDays: number, out: Vec3): Vec3 => {
  const meanMotion = TWO_PI / Math.max(1e-6, orbit.periodDays);
  const meanAnomaly = orbit.meanAnomalyAtEpochRad + meanMotion * (timeDays - orbit.epochDays);
  const position = computeOrbitPositionFromMeanAnomaly(orbit, meanAnomaly, scratchVec3A);
  return setVec3(out, position.x, position.y, position.z);
};

const resolveOverlayFrequency = (surfaceFrequency: number | null, screenPx: number): number => {
  if (!surfaceFrequency) {
    if (screenPx < 120) return 8;
    if (screenPx < 220) return 10;
    if (screenPx < 360) return 12;
    return 16;
  }
  const lodShift = screenPx < 160 ? -2 : screenPx < 260 ? -1 : screenPx < 420 ? 0 : 1;
  return clamp(surfaceFrequency + lodShift, 2, 32);
};

const resolveTextureResolution = (screenPx: number): number => {
  if (screenPx < 140) return 128;
  if (screenPx < 260) return 256;
  if (screenPx < 420) return 384;
  if (screenPx < 620) return 512;
  return 1024;
};

const createPlanetTexture = (
  seed: number,
  resolution: number,
  baseColor: string,
  planetType?: PlanetType,
  planetClass?: PlanetClass
): THREE.Texture | null => {
  if (resolution <= 0) return null;
  const width = resolution * 2;
  const height = resolution;
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : typeof document !== 'undefined'
        ? document.createElement('canvas')
        : null;
  if (!canvas) return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;

  const rng = new Rng32(seed);
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, width, height);

  if (planetClass === 'gas_giant' || planetClass === 'ice_giant') {
    const bandCount = 6 + Math.floor(rng.range(0, 6));
    for (let i = 0; i < bandCount; i += 1) {
      const hueShift = rng.range(-0.06, 0.06);
      const color = new THREE.Color(baseColor);
      color.offsetHSL(hueShift, rng.range(-0.1, 0.1), rng.range(-0.15, 0.12));
      ctx.fillStyle = `#${color.getHexString()}`;
      const y = Math.floor((i / bandCount) * height);
      const bandHeight = Math.floor(height / bandCount) + 2;
      ctx.fillRect(0, y, width, bandHeight);
    }
  } else {
    for (let i = 0; i < width * height * 0.02; i += 1) {
      const x = Math.floor(rng.range(0, width));
      const y = Math.floor(rng.range(0, height));
      const color = new THREE.Color(baseColor);
      color.offsetHSL(rng.range(-0.08, 0.08), rng.range(-0.1, 0.1), rng.range(-0.2, 0.2));
      ctx.fillStyle = `#${color.getHexString()}`;
      ctx.fillRect(x, y, 2, 2);
    }
  }

  if (planetType === 'Terrestrial' || planetType === 'Dwarf') {
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 12; i += 1) {
      const x = rng.range(0, width);
      const y = rng.range(0, height);
      const r = rng.range(10, 40);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 2;
  texture.needsUpdate = true;
  return texture;
};

export class SpaceView {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private galaxyScene = new THREE.Scene();
  private systemScene = new THREE.Scene();
  private planetScene = new THREE.Scene();

  private galaxyRoot = new THREE.Group();
  private systemRoot = new THREE.Group();
  private planetRoot = new THREE.Group();

  private galaxyPoints: THREE.Points | null = null;
  private fleetPoints: THREE.Points | null = null;
  private systemFleetPoints: THREE.Points | null = null;
  private activeSystemImpostor: THREE.Points;
  private activeSystemMaterial: THREE.PointsMaterial;

  private systemAssets = new Map<string, SystemAssets>();
  private planetAssets = new Map<string, PlanetAssets>();

  private data: GalaxyViewData;
  private systemById = new Map<string, SystemViewData>();
  private activeSystemId: string | null = null;
  private activePlanetId: string | null = null;
  private activePlanetWorldMeters: Vec3 | null = null;

  private thresholds: SpaceViewThresholds;
  private scales: SpaceViewScales;

  private systemGate: HysteresisGate;
  private planetGate: HysteresisGate;
  private systemFade: CrossFade;
  private planetFade: CrossFade;

  private streamingQueue = new StreamingQueue();
  private maxTasksPerFrame: number;
  private debugSurfaceMode: 'albedo' | 'biome';
  private orbitLineMode: 'line2' | 'basic';

  private floatingOrigin: FloatingOriginManager;
  private zoom: ZoomController;
  private cameraRig: CameraRig;
  private timeDays = 0;
  private timeScaleDaysPerSecond: number;
  private overlayMode: 'voronoi' | 'triangulated' | 'both';

  private galaxyRadiusMeters = 1;
  private focusSystemId: string | null = null;
  private focusPlanetId: string | null = null;
  private focusTargetMeters: Vec3 = vec3();

  private sizePx = { width: 1, height: 1 };
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private lastOriginMeters: Vec3 = vec3();
  private lastCameraMeters: Vec3 = vec3();
  private lastSystemScreenPx = 0;
  private lastPlanetScreenPx = 0;
  private orbitingPositionScratch: Vec3[] = [];
  private starPositionScratch: Vec3[] = [];
  private planetLightScratch: Vec3 = vec3();
  private planetLightDirectionScratch: Vec3 = vec3();
  private textureCache = new Map<string, { texture: THREE.Texture; resolution: number; lastUsed: number }>();
  private textureCacheMax = 24;
  private fpsSmoothed = 60;
  private qualityScale = 1;

  constructor(options: SpaceViewOptions) {
    this.data = options.data;
    this.thresholds = {
      systemEnterPx: 200,
      systemExitPx: 150,
      systemPreloadPx: 160,
      planetEnterPx: 240,
      planetExitPx: 180,
      planetPreloadPx: 200,
      planetMeshEnterPx: 18,
      planetMeshExitPx: 10,
      crossFadeSeconds: 0.6,
      ...options.thresholds
    };
    this.scales = {
      metersPerGalaxyUnit: LY_METERS,
      metersPerSystemUnit: 1e7,
      metersPerPlanetUnit: 1,
      ...options.scales
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(new THREE.Color(options.backgroundColor ?? '#05070c'));

    const fovDeg = options.fovDeg ?? 55;
    this.camera = new THREE.PerspectiveCamera(fovDeg, 1, 0.1, 10000);

    this.galaxyScene.add(this.galaxyRoot);
    this.systemScene.add(this.systemRoot);
    this.planetScene.add(this.planetRoot);

    this.activeSystemMaterial = new THREE.PointsMaterial({
      size: 8,
      sizeAttenuation: false,
      transparent: true,
      opacity: 1,
      color: '#ffffff'
    });
    const impostorGeometry = new THREE.BufferGeometry();
    impostorGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.activeSystemImpostor = new THREE.Points(impostorGeometry, this.activeSystemMaterial);
    this.galaxyRoot.add(this.activeSystemImpostor);

    this.systemGate = new HysteresisGate(this.thresholds.systemEnterPx, this.thresholds.systemExitPx, false);
    this.planetGate = new HysteresisGate(this.thresholds.planetEnterPx, this.thresholds.planetExitPx, false);
    this.systemFade = new CrossFade(this.thresholds.crossFadeSeconds);
    this.planetFade = new CrossFade(this.thresholds.crossFadeSeconds);

    this.maxTasksPerFrame = options.maxTasksPerFrame ?? 2;
    this.floatingOrigin = new FloatingOriginManager(options.floatingOriginSnapMeters ?? 1e9);

    this.setData(this.data);

    const minDistance = options.minDistanceMeters ?? 5_000;
    const maxDistance = options.maxDistanceMeters ?? this.galaxyRadiusMeters * 2.5;
    const initialDistance = clamp(maxDistance * 0.6, minDistance, maxDistance);
    this.zoom = new ZoomController(initialDistance, minDistance, maxDistance);
    this.cameraRig = new CameraRig(this.zoom);

    this.timeScaleDaysPerSecond = options.timeScaleDaysPerSecond ?? 0;
    this.overlayMode = options.debugOverlayMode ?? 'voronoi';
    this.debugSurfaceMode = options.debugSurfaceMode ?? 'albedo';
    this.orbitLineMode = options.orbitLineMode ?? 'line2';

    const initialWidth = options.canvas.clientWidth || options.canvas.width || 800;
    const initialHeight = options.canvas.clientHeight || options.canvas.height || 600;
    this.resize(initialWidth, initialHeight, options.pixelRatio);
  }

  setData(data: GalaxyViewData): void {
    this.data = data;
    this.systemById.clear();
    this.systemAssets.forEach(assets => disposeObject3D(assets.group));
    this.systemAssets.clear();
    this.planetAssets.forEach(assets => disposeObject3D(assets.group));
    this.planetAssets.clear();

    let maxDistance = 0;
    data.systems.forEach(system => {
      this.systemById.set(system.id, system);
      maxDistance = Math.max(maxDistance, lengthVec3(system.positionMeters) + system.extentMeters);
    });
    this.galaxyRadiusMeters = Math.max(1, maxDistance);

    this.rebuildGalaxyPoints();
    this.rebuildFleetPoints();
    if (this.activeSystemId) {
      const activeSystem = this.systemById.get(this.activeSystemId);
      if (activeSystem) {
        this.rebuildSystemFleetPoints(activeSystem);
      }
    }
  }

  setFocusSystem(systemId: string | null): void {
    this.focusSystemId = systemId;
    this.focusPlanetId = null;
    if (!systemId) return;
    const system = this.systemById.get(systemId);
    if (system) {
      copyVec3(this.focusTargetMeters, system.positionMeters);
    }
  }

  setCameraPose(pose: { targetMeters?: Vec3; yawRad?: number; pitchRad?: number; distanceMeters?: number }): void {
    if (pose.targetMeters) {
      this.cameraRig.setTargetMeters(pose.targetMeters);
    }
    if (pose.yawRad !== undefined) {
      this.cameraRig.yaw = pose.yawRad;
    }
    if (pose.pitchRad !== undefined) {
      this.cameraRig.pitch = clamp(pose.pitchRad, -1.4, 1.4);
    }
    if (pose.distanceMeters !== undefined) {
      this.zoom.setDistanceMeters(pose.distanceMeters);
    }
  }

  setTimeScaleDaysPerSecond(value: number): void {
    this.timeScaleDaysPerSecond = value;
  }

  applyZoomDelta(delta: number): void {
    this.zoom.applyZoomDelta(delta);
  }

  applyOrbit(deltaYaw: number, deltaPitch: number): void {
    this.cameraRig.applyOrbit(deltaYaw, deltaPitch);
  }

  applyPan(deltaX: number, deltaY: number): void {
    this.cameraRig.applyPan(deltaX, deltaY);
  }

  focusAtScreen(screenX: number, screenY: number): boolean {
    if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return false;
    if (this.sizePx.width <= 1 || this.sizePx.height <= 1) return false;
    const originMeters = this.lastOriginMeters;
    const cameraMeters = this.lastCameraMeters;
    if (!Number.isFinite(cameraMeters.x) || !Number.isFinite(cameraMeters.y) || !Number.isFinite(cameraMeters.z)) return false;

    const activeSystem = this.activeSystemId ? this.systemById.get(this.activeSystemId) ?? null : null;
    const fovRad = this.camera.fov * (Math.PI / 180);

    if (activeSystem && this.planetFade.value > 0.2) {
      const planetPick = this.pickPlanetAtScreen(activeSystem, screenX, screenY, originMeters, cameraMeters, fovRad);
      if (planetPick) {
        this.focusSystemId = activeSystem.id;
        this.focusPlanetId = planetPick.planet.id;
        return true;
      }
    }

    if (activeSystem && this.systemFade.value > 0.2) {
      const planetPick = this.pickPlanetAtScreen(activeSystem, screenX, screenY, originMeters, cameraMeters, fovRad);
      if (planetPick) {
        this.focusSystemId = activeSystem.id;
        this.focusPlanetId = planetPick.planet.id;
        return true;
      }

      const systemPick = this.pickSystemAtScreen(
        [activeSystem],
        screenX,
        screenY,
        originMeters,
        cameraMeters,
        fovRad,
        this.scales.metersPerSystemUnit,
        activeSystem.positionMeters,
        activeSystem.extentMeters
      );
      if (systemPick) {
        this.focusSystemId = systemPick.system.id;
        this.focusPlanetId = null;
        return true;
      }
    }

    const galaxyPick = this.pickSystemAtScreen(
      this.data.systems,
      screenX,
      screenY,
      originMeters,
      cameraMeters,
      fovRad,
      this.scales.metersPerGalaxyUnit,
      vec3(),
      this.galaxyRadiusMeters
    );
    if (galaxyPick) {
      this.focusSystemId = galaxyPick.system.id;
      this.focusPlanetId = null;
      return true;
    }

    return false;
  }

  getDebugInfo(): {
    stage: 'galaxy' | 'system' | 'planet';
    zoomDistanceMeters: number;
    systemScreenPx: number;
    planetScreenPx: number;
    systemFade: number;
    planetFade: number;
    activeSystemId: string | null;
    activePlanetId: string | null;
    focusSystemId: string | null;
    focusPlanetId: string | null;
    seed: number;
    loadedSystems: number;
    loadedPlanets: number;
    memory: THREE.WebGLInfo['memory'];
    drawCalls: number;
    triangles: number;
    targetMeters: Vec3;
    cameraMeters: Vec3;
    activeBodyInfo: {
      id: string;
      kind: BodyKind;
      parentId: string | null;
      radiusMeters: number;
      systemId?: string;
      surfaceFrequency?: number | null;
      astroRef?: AstroRef;
      orbit?: {
        aMeters: number;
        e: number;
        iDeg: number;
        omegaDeg: number;
        argPeriapsisDeg: number;
        meanAnomalyDeg: number;
        periodDays: number;
      };
    } | null;
  } {
    const stage: 'galaxy' | 'system' | 'planet' =
      this.planetFade.value > 0.5 ? 'planet' : this.systemFade.value > 0.1 ? 'system' : 'galaxy';
    const activeSystem = this.activeSystemId ? this.systemById.get(this.activeSystemId) ?? null : null;
    const activeBody = this.activePlanetId && activeSystem
      ? activeSystem.orbitingBodies.find(body => body.id === this.activePlanetId) ?? null
      : null;
    const activeBodyInfo = activeBody
      ? {
          id: activeBody.id,
          kind: activeBody.kind,
          parentId: activeBody.parentId,
          radiusMeters: activeBody.radiusMeters,
          astroRef: activeBody.astroRef,
          systemId: activeBody.systemId,
          surfaceFrequency:
            activeBody.surfaceDescriptor?.config.gridKind === 'geodesic'
              ? activeBody.surfaceDescriptor.config.frequency
              : null,
          orbit: activeBody.orbit
            ? {
                aMeters: activeBody.orbit.semiMajorAxisMeters,
                e: activeBody.orbit.eccentricity,
                iDeg: activeBody.orbit.inclinationRad * (180 / Math.PI),
                omegaDeg: activeBody.orbit.ascendingNodeRad * (180 / Math.PI),
                argPeriapsisDeg: activeBody.orbit.argPeriapsisRad * (180 / Math.PI),
                meanAnomalyDeg: activeBody.orbit.meanAnomalyAtEpochRad * (180 / Math.PI),
                periodDays: activeBody.orbit.periodDays
              }
            : undefined
        }
      : null;

    return {
      stage,
      zoomDistanceMeters: this.zoom.distanceMeters,
      systemScreenPx: this.lastSystemScreenPx,
      planetScreenPx: this.lastPlanetScreenPx,
      systemFade: this.systemFade.value,
      planetFade: this.planetFade.value,
      activeSystemId: this.activeSystemId,
      activePlanetId: this.activePlanetId,
      seed: this.data.seed,
      focusSystemId: this.focusSystemId,
      focusPlanetId: this.focusPlanetId,
      loadedSystems: this.systemAssets.size,
      loadedPlanets: this.planetAssets.size,
      memory: this.renderer.info.memory,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      targetMeters: this.cameraRig.targetMeters,
      cameraMeters: this.lastCameraMeters,
      activeBodyInfo
    };
  }

  resize(width: number, height: number, pixelRatio?: number): void {
    const ratio = pixelRatio ?? Math.min(2, Number(globalThis.devicePixelRatio) || 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.sizePx = { width, height };
    this.systemAssets.forEach(assets => {
      assets.orbitMaterials.forEach(material => {
        if (material instanceof LineMaterial) {
          material.resolution.set(width, height);
        }
      });
    });
  }

  start(): void {
    if (this.rafId !== null || typeof globalThis.requestAnimationFrame !== 'function') return;
    const loop = (time: number) => {
      if (this.rafId === null) return;
      const dt = this.lastFrameMs ? (time - this.lastFrameMs) / 1000 : 0;
      this.lastFrameMs = time;
      this.update(dt);
      this.rafId = globalThis.requestAnimationFrame(loop);
    };
    this.rafId = globalThis.requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId === null || typeof globalThis.cancelAnimationFrame !== 'function') return;
    globalThis.cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastFrameMs = 0;
  }

  update(dtSeconds: number, timeDaysOverride?: number): void {
    if (Number.isFinite(timeDaysOverride)) {
      this.timeDays = Number(timeDaysOverride);
    } else if (this.timeScaleDaysPerSecond !== 0) {
      this.timeDays += dtSeconds * this.timeScaleDaysPerSecond;
    }

    this.updateQuality(dtSeconds);
    this.streamingQueue.process(this.maxTasksPerFrame);

    const cameraState = this.cameraRig.update(dtSeconds);
    const originMeters = this.floatingOrigin.update(cameraState.positionMeters);
    copyVec3(this.lastOriginMeters, originMeters);
    copyVec3(this.lastCameraMeters, cameraState.positionMeters);
    this.updateRootOffsets(originMeters);

    const activeSystem = this.resolveActiveSystem(cameraState.positionMeters);
    this.updateSystemTransition(activeSystem, cameraState.positionMeters, dtSeconds);
    this.updatePlanetTransition(activeSystem, cameraState.positionMeters, dtSeconds);

    this.updateSystemAssets(activeSystem, originMeters);
    this.updatePlanetAssets(activeSystem, originMeters);
    this.updateFocusTarget(activeSystem, dtSeconds);

    this.camera.quaternion.copy(cameraState.quaternion);
    this.render(originMeters, cameraState.positionMeters);
  }

  private updateQuality(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    const fps = 1 / dtSeconds;
    this.fpsSmoothed = this.fpsSmoothed * 0.9 + fps * 0.1;
    const targetScale = this.fpsSmoothed < 45 ? 0.75 : this.fpsSmoothed > 55 ? 1 : this.qualityScale;
    this.qualityScale = this.qualityScale * 0.9 + targetScale * 0.1;
  }

  private releaseSystemAssets(systemId: string): void {
    const assets = this.systemAssets.get(systemId);
    if (!assets) return;
    disposeObject3D(assets.group);
    this.systemAssets.delete(systemId);
  }

  private releasePlanetAssetsForSystem(system: SystemViewData): void {
    system.orbitingBodies.forEach(body => {
      const assets = this.planetAssets.get(body.id);
      if (!assets) return;
      disposeObject3D(assets.group);
      this.planetAssets.delete(body.id);
    });
  }

  dispose(): void {
    this.stop();
    this.renderer.dispose();
    if (this.galaxyPoints) {
      this.galaxyPoints.geometry.dispose();
      (this.galaxyPoints.material as THREE.PointsMaterial).dispose();
    }
    if (this.fleetPoints) {
      this.fleetPoints.geometry.dispose();
      (this.fleetPoints.material as THREE.PointsMaterial).dispose();
    }
    if (this.systemFleetPoints) {
      this.systemFleetPoints.geometry.dispose();
      (this.systemFleetPoints.material as THREE.PointsMaterial).dispose();
    }
    this.activeSystemImpostor.geometry.dispose();
    this.activeSystemMaterial.dispose();
    this.textureCache.forEach(entry => entry.texture.dispose());
    this.textureCache.clear();
    Array.from(this.systemAssets.keys()).forEach(systemId => this.releaseSystemAssets(systemId));
    this.planetAssets.forEach(assets => {
      disposeObject3D(assets.group);
    });
    this.planetAssets.clear();
  }

  private resolveActiveSystem(cameraMeters: Vec3): SystemViewData | null {
    if (this.focusSystemId) {
      return this.systemById.get(this.focusSystemId) ?? null;
    }

    let closest: SystemViewData | null = null;
    let closestDist = Number.POSITIVE_INFINITY;
    for (const system of this.systemById.values()) {
      const d = distVec3(cameraMeters, system.positionMeters);
      if (d < closestDist) {
        closestDist = d;
        closest = system;
      }
    }
    return closest;
  }

  private updateSystemTransition(system: SystemViewData | null, cameraMeters: Vec3, dtSeconds: number): void {
    if (!system) {
      this.systemFade.update(dtSeconds, false);
      this.activeSystemId = null;
      this.activeSystemMaterial.opacity = 1;
      this.activeSystemImpostor.visible = false;
      this.lastSystemScreenPx = 0;
      return;
    }

    this.activeSystemImpostor.visible = true;
    if (system.id !== this.activeSystemId) {
      const previousSystemId = this.activeSystemId;
      if (previousSystemId) {
        const previousSystem = this.systemById.get(previousSystemId);
        if (previousSystem) {
          this.releaseSystemAssets(previousSystemId);
          this.releasePlanetAssetsForSystem(previousSystem);
        }
      }
      this.activeSystemId = system.id;
      this.rebuildGalaxyPoints(system.id);
      this.activeSystemMaterial.color = new THREE.Color(system.markerColor);
      this.systemRoot.clear();
      this.planetRoot.clear();
      this.rebuildSystemFleetPoints(system);
    }

    const impostorAttribute = this.activeSystemImpostor.geometry.getAttribute('position') as THREE.BufferAttribute;
    impostorAttribute.setXYZ(
      0,
      system.positionMeters.x / this.scales.metersPerGalaxyUnit,
      system.positionMeters.y / this.scales.metersPerGalaxyUnit,
      system.positionMeters.z / this.scales.metersPerGalaxyUnit
    );
    impostorAttribute.needsUpdate = true;

    const distance = distVec3(cameraMeters, system.positionMeters);
    const screenPx = screenSpaceRadiusPx(system.extentMeters, distance, this.camera.fov * (Math.PI / 180), this.sizePx.height);
    this.lastSystemScreenPx = screenPx;
    const detailed = this.systemGate.update(screenPx);
    const fade = this.systemFade.update(dtSeconds, detailed);

    if (screenPx >= this.thresholds.systemPreloadPx) {
      this.ensureSystemAssets(system);
    }

    this.activeSystemMaterial.opacity = 1 - fade;
  }

  private updatePlanetTransition(system: SystemViewData | null, cameraMeters: Vec3, dtSeconds: number): void {
    if (!system || this.systemFade.value <= 0) {
      this.planetFade.update(dtSeconds, false);
      this.activePlanetId = null;
      this.activePlanetWorldMeters = null;
      this.planetRoot.visible = false;
      this.lastPlanetScreenPx = 0;
      return;
    }

    let bestPlanet: BodyViewData | null = null;
    const bestPlanetWorld = vec3();
    let hasBest = false;
    let bestScore = 0;

    const focusedPlanet = this.focusPlanetId
      ? system.orbitingBodies.find(planet => planet.id === this.focusPlanetId) ?? null
      : null;
    if (this.focusPlanetId && !focusedPlanet) {
      this.focusPlanetId = null;
    }

    const positions = this.computeOrbitingPositions(system);
    if (focusedPlanet) {
      const focusedIndex = system.orbitingBodies.findIndex(body => body.id === focusedPlanet.id);
      const orbitPosition = focusedIndex >= 0 ? positions[focusedIndex] : computeOrbitPositionMeters(focusedPlanet, this.timeDays);
      const planetWorldX = system.positionMeters.x + orbitPosition.x;
      const planetWorldY = system.positionMeters.y + orbitPosition.y;
      const planetWorldZ = system.positionMeters.z + orbitPosition.z;
      const dx = cameraMeters.x - planetWorldX;
      const dy = cameraMeters.y - planetWorldY;
      const dz = cameraMeters.z - planetWorldZ;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const screenPx = screenSpaceRadiusPx(
        focusedPlanet.radiusMeters,
        distance,
        this.camera.fov * (Math.PI / 180),
        this.sizePx.height
      );
      bestPlanet = focusedPlanet;
      setVec3(bestPlanetWorld, planetWorldX, planetWorldY, planetWorldZ);
      hasBest = true;
      bestScore = screenPx;
    } else {
      for (let i = 0; i < system.orbitingBodies.length; i += 1) {
        const planet = system.orbitingBodies[i];
        const orbitPosition = positions[i];
        const planetWorldX = system.positionMeters.x + orbitPosition.x;
        const planetWorldY = system.positionMeters.y + orbitPosition.y;
        const planetWorldZ = system.positionMeters.z + orbitPosition.z;
        const dx = cameraMeters.x - planetWorldX;
        const dy = cameraMeters.y - planetWorldY;
        const dz = cameraMeters.z - planetWorldZ;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const screenPx = screenSpaceRadiusPx(
          planet.radiusMeters,
          distance,
          this.camera.fov * (Math.PI / 180),
          this.sizePx.height
        );

        if (screenPx > bestScore) {
          bestScore = screenPx;
          bestPlanet = planet;
          setVec3(bestPlanetWorld, planetWorldX, planetWorldY, planetWorldZ);
          hasBest = true;
        }
      }
    }

    if (!bestPlanet || !hasBest) {
      this.planetFade.update(dtSeconds, false);
      this.activePlanetId = null;
      this.activePlanetWorldMeters = null;
      this.planetRoot.visible = false;
      this.lastPlanetScreenPx = 0;
      return;
    }

    this.lastPlanetScreenPx = bestScore;
    const detailed = this.planetGate.update(bestScore);
    this.planetFade.update(dtSeconds, detailed);

    if (bestScore >= this.thresholds.planetPreloadPx) {
      this.ensurePlanetAssets(bestPlanet);
    }

    this.activePlanetId = bestPlanet.id;
    if (!this.activePlanetWorldMeters) {
      this.activePlanetWorldMeters = vec3();
    }
    copyVec3(this.activePlanetWorldMeters, bestPlanetWorld);
    this.planetRoot.visible = true;
  }

  private computeStarPositions(system: SystemViewData, out: Vec3[]): Vec3[] {
    for (let i = 0; i < system.stars.length; i += 1) {
      if (!out[i]) out[i] = vec3();
      setVec3(out[i], 0, 0, 0);
    }

    if (system.stars.length === 2) {
      const primary = system.stars[0];
      const companion = system.stars[1];
      if (companion.orbit) {
        const relative = computeOrbitPositionFromTime(companion.orbit, this.timeDays, scratchVec3C);
        const totalMass = (primary.massSun ?? 1) + (companion.massSun ?? 1);
        const primaryOffsetScale = -(companion.massSun ?? 1) / totalMass;
        const companionOffsetScale = (primary.massSun ?? 1) / totalMass;
        scaleVec3(out[0], relative, primaryOffsetScale);
        scaleVec3(out[1], relative, companionOffsetScale);
        return out;
      }
    }

    for (let i = 0; i < system.stars.length; i += 1) {
      const star = system.stars[i];
      if (star.orbit) {
        computeOrbitPositionMeters(star, this.timeDays, out[i]);
      } else {
        setVec3(out[i], 0, 0, 0);
      }
    }

    return out;
  }

  private computeOrbitingPositions(system: SystemViewData): Vec3[] {
    const starPositions = this.computeStarPositions(system, this.starPositionScratch);

    const positions = this.orbitingPositionScratch;
    for (let i = 0; i < system.orbitingBodies.length; i += 1) {
      if (!positions[i]) positions[i] = vec3();
      const body = system.orbitingBodies[i];
      computeOrbitPositionMeters(body, this.timeDays, positions[i]);

      const parentIndex = system.orbitingParentIndex[i];
      const parentStarIndex = system.orbitingParentStarIndex[i];
      if (parentIndex !== null) {
        addVec3(positions[i], positions[i], positions[parentIndex]);
      } else if (parentStarIndex !== null) {
        addVec3(positions[i], positions[i], starPositions[parentStarIndex]);
      }
    }

    return positions;
  }

  private requestPlanetTexture(assets: PlanetAssets, systemId: string, screenPx: number): void {
    const desiredResolution = resolveTextureResolution(screenPx);
    if (assets.textureState.resolution >= desiredResolution) return;
    assets.textureState.targetResolution = desiredResolution;

    const planet = assets.planetData;
    const surfaceDescriptor = planet.surfaceDescriptor;
    const configKey = surfaceDescriptor
      ? surfaceDescriptor.config.gridKind === 'geodesic'
        ? `geo:${surfaceDescriptor.config.frequency}`
        : `rect:${surfaceDescriptor.config.w}x${surfaceDescriptor.config.h}`
      : 'surface:none';
    const cacheKey = `${planet.id}:${configKey}:v${surfaceDescriptor?.config.generatorVersion ?? 0}:r${desiredResolution}:mode:${this.debugSurfaceMode}`;
    const cached = this.textureCache.get(cacheKey);
    if (cached) {
      assets.bodyMaterial.map = cached.texture;
      assets.bodyMaterial.needsUpdate = true;
      assets.textureState.resolution = desiredResolution;
      cached.lastUsed = performance.now();
      return;
    }

    this.streamingQueue.enqueue(`texture:${cacheKey}`, () => {
      const existing = this.textureCache.get(cacheKey);
      if (existing) {
        assets.bodyMaterial.map = existing.texture;
        assets.bodyMaterial.needsUpdate = true;
        assets.textureState.resolution = desiredResolution;
        existing.lastUsed = performance.now();
        return;
      }

      const useSurfaceTexture = surfaceDescriptor && planet.planetClass !== 'gas_giant' && planet.planetClass !== 'ice_giant';
      const texture = useSurfaceTexture
        ? createPlanetTextureFromSurface({
            systemId,
            bodyId: planet.id,
            descriptor: surfaceDescriptor,
            resolution: desiredResolution,
            planetData: planet.surfaceData?.planetData,
            moonData: planet.surfaceData?.moonData,
            mode: this.debugSurfaceMode
          })
        : createPlanetTexture(
            assets.textureState.seed,
            desiredResolution,
            planet.baseColor,
            planet.planetType,
            planet.planetClass
          );
      if (!texture) return;
      this.textureCache.set(cacheKey, { texture, resolution: desiredResolution, lastUsed: performance.now() });
      this.pruneTextureCache();
      assets.bodyMaterial.map = texture;
      assets.bodyMaterial.needsUpdate = true;
      assets.textureState.resolution = desiredResolution;
    });
  }

  private pruneTextureCache(): void {
    if (this.textureCache.size <= this.textureCacheMax) return;
    const entries = sorted(Array.from(this.textureCache.entries()), (a, b) => a[1].lastUsed - b[1].lastUsed);
    const excess = entries.length - this.textureCacheMax;
    for (let i = 0; i < excess; i += 1) {
      const [key, entry] = entries[i];
      entry.texture.dispose();
      this.textureCache.delete(key);
    }
  }

  private updateSystemAssets(system: SystemViewData | null, originMeters: Vec3): void {
    if (!system) return;

    const assets = this.systemAssets.get(system.id);
    const systemOpacity = this.systemFade.value;
    const clutterFade = clamp(1 - this.planetFade.value * 0.85, 0, 1);
    if (assets) {
      if (!this.systemRoot.children.includes(assets.group)) {
        this.systemRoot.clear();
        this.systemRoot.add(assets.group);
        if (this.systemFleetPoints) {
          this.systemRoot.add(this.systemFleetPoints);
        }
      }

      assets.group.position.set(
        (system.positionMeters.x - originMeters.x) / this.scales.metersPerSystemUnit,
        (system.positionMeters.y - originMeters.y) / this.scales.metersPerSystemUnit,
        (system.positionMeters.z - originMeters.z) / this.scales.metersPerSystemUnit
      );

      const fovRad = this.camera.fov * (Math.PI / 180);
      const meshRange = Math.max(1, this.thresholds.planetMeshEnterPx - this.thresholds.planetMeshExitPx);
      let maxMeshBlend = 0;

      assets.starMaterials.forEach(material => {
        material.opacity = systemOpacity;
      });

      const starPositions = this.computeStarPositions(system, assets.starPositions);

      assets.starData.forEach((star, index) => {
        const starPos = starPositions[index];
        const unitX = starPos.x / this.scales.metersPerSystemUnit;
        const unitY = starPos.y / this.scales.metersPerSystemUnit;
        const unitZ = starPos.z / this.scales.metersPerSystemUnit;
        assets.starMeshes[index]?.position.set(unitX, unitY, unitZ);
        const halo = assets.starHalos[index];
        if (halo) {
          halo.position.set(unitX, unitY, unitZ);
          const haloMaterial = halo.material as THREE.SpriteMaterial;
          haloMaterial.opacity = 0.35 * systemOpacity;
        }
        const light = assets.starLights[index];
        if (light) {
          light.position.set(unitX, unitY, unitZ);
          light.intensity = (light.userData.baseIntensity as number | undefined ?? light.intensity) * systemOpacity;
        }
      });

      assets.orbitMaterials.forEach(material => {
        material.opacity = systemOpacity * clutterFade * 0.6;
      });

      const pointPositions = assets.bodyPointGeometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < assets.bodyData.length; i += 1) {
        const body = assets.bodyData[i];
        const position = assets.bodyPositions[i];
        computeOrbitPositionMeters(body, this.timeDays, position);

        const parentIndex = assets.bodyParentIndex[i];
        const parentStarIndex = assets.bodyParentStarIndex[i];
        if (parentIndex !== null) {
          addVec3(position, position, assets.bodyPositions[parentIndex]);
        } else if (parentStarIndex !== null) {
          addVec3(position, position, assets.starPositions[parentStarIndex]);
        }

        const worldX = system.positionMeters.x + position.x;
        const worldY = system.positionMeters.y + position.y;
        const worldZ = system.positionMeters.z + position.z;
        const dx = this.lastCameraMeters.x - worldX;
        const dy = this.lastCameraMeters.y - worldY;
        const dz = this.lastCameraMeters.z - worldZ;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const screenPx = screenSpaceRadiusPx(body.radiusMeters, distance, fovRad, this.sizePx.height);
        const meshBlend = clamp((screenPx - this.thresholds.planetMeshExitPx) / meshRange, 0, 1);
        maxMeshBlend = Math.max(maxMeshBlend, meshBlend);

        scratchMatrixA.compose(
          scratchVec3A.set(
            position.x / this.scales.metersPerSystemUnit,
            position.y / this.scales.metersPerSystemUnit,
            position.z / this.scales.metersPerSystemUnit
          ),
          scratchQuatA.identity(),
          scratchVec3B.set(
            body.radiusMeters / this.scales.metersPerSystemUnit,
            body.radiusMeters / this.scales.metersPerSystemUnit,
            body.radiusMeters / this.scales.metersPerSystemUnit
          )
        );
        assets.bodyMesh.setMatrixAt(i, scratchMatrixA);

        pointPositions.setXYZ(
          i,
          position.x / this.scales.metersPerSystemUnit,
          position.y / this.scales.metersPerSystemUnit,
          position.z / this.scales.metersPerSystemUnit
        );
      }

      assets.bodyMesh.instanceMatrix.needsUpdate = true;
      pointPositions.needsUpdate = true;
      const pointOpacity = systemOpacity * clutterFade * (1 - maxMeshBlend);
      assets.bodyPointMaterial.opacity = pointOpacity;
      assets.bodyPoints.visible = pointOpacity > 0.01;
      assets.bodyMaterial.opacity = systemOpacity * clutterFade * maxMeshBlend;

      assets.orbitLines.forEach((line, index) => {
        const parentIndex = assets.orbitParents[index];
        const parentStarIndex = assets.orbitParentStars[index];
        if (parentIndex !== null) {
          const parentPos = assets.bodyPositions[parentIndex];
          line.position.set(
            parentPos.x / this.scales.metersPerSystemUnit,
            parentPos.y / this.scales.metersPerSystemUnit,
            parentPos.z / this.scales.metersPerSystemUnit
          );
        } else if (parentStarIndex !== null) {
          const starPos = assets.starPositions[parentStarIndex];
          line.position.set(
            starPos.x / this.scales.metersPerSystemUnit,
            starPos.y / this.scales.metersPerSystemUnit,
            starPos.z / this.scales.metersPerSystemUnit
          );
        } else {
          line.position.set(0, 0, 0);
        }
      });
    }

    if (this.systemFleetPoints) {
      this.systemFleetPoints.position.set(
        (system.positionMeters.x - originMeters.x) / this.scales.metersPerSystemUnit,
        (system.positionMeters.y - originMeters.y) / this.scales.metersPerSystemUnit,
        (system.positionMeters.z - originMeters.z) / this.scales.metersPerSystemUnit
      );
      (this.systemFleetPoints.material as THREE.PointsMaterial).opacity = systemOpacity * clutterFade;
    }

    const minDistance = Math.max(
      5_000,
      (system.orbitingBodies.find(p => p.id === this.activePlanetId)?.radiusMeters ?? 0) * 1.2
    );
    this.zoom.setBounds(minDistance, this.galaxyRadiusMeters * 2.5);
  }

  private updatePlanetAssets(system: SystemViewData | null, originMeters: Vec3): void {
    if (!system || !this.activePlanetId) return;
    if (this.planetFade.value <= 0) return;

    const planet = system.orbitingBodies.find(p => p.id === this.activePlanetId);
    if (!planet) return;

    const assets = this.planetAssets.get(planet.id);
    if (!assets) return;

    if (!this.planetRoot.children.includes(assets.group)) {
      this.planetRoot.clear();
      this.planetRoot.add(assets.group);
    }

    const positions = this.computeOrbitingPositions(system);
    const planetIndex = system.orbitingBodies.findIndex(body => body.id === planet.id);
    const planetSystemPos = planetIndex >= 0 ? positions[planetIndex] : computeOrbitPositionMeters(planet, this.timeDays);
    const planetWorld = this.activePlanetWorldMeters ?? addVec3(vec3(), system.positionMeters, planetSystemPos);

    assets.group.position.set(
      (planetWorld.x - originMeters.x) / this.scales.metersPerPlanetUnit,
      (planetWorld.y - originMeters.y) / this.scales.metersPerPlanetUnit,
      (planetWorld.z - originMeters.z) / this.scales.metersPerPlanetUnit
    );

    assets.bodyMaterial.opacity = this.planetFade.value;
    assets.atmosphereMaterial.opacity = this.planetFade.value * (planet.planetType === 'Terrestrial' ? 0.2 : 0.12);
    assets.cloudMaterial.opacity = this.planetFade.value * (planet.planetType === 'Terrestrial' ? 0.28 : 0.18);
    assets.tiltGroup.rotation.x = assets.axialTiltRad;

    const showVoronoi = this.overlayMode === 'voronoi' || this.overlayMode === 'both';
    const showTriangulated = this.overlayMode === 'triangulated' || this.overlayMode === 'both';
    assets.overlayMesh.visible = showVoronoi;
    assets.overlayMaterial.opacity = showVoronoi ? this.planetFade.value * 0.35 : 0;
    if (assets.triOverlayMesh && assets.triOverlayMaterial) {
      assets.triOverlayMesh.visible = showTriangulated;
      assets.triOverlayMaterial.opacity = showTriangulated ? this.planetFade.value * 0.25 : 0;
    }

    const rotation = this.timeDays * assets.rotationSpeedRadPerDay;
    assets.spinGroup.rotation.y = rotation;
    assets.cloudMesh.rotation.y = rotation * 0.15;
    assets.atmosphereMesh.rotation.y = rotation * 0.6;

    const qualityScreenPx = this.lastPlanetScreenPx * this.qualityScale;
    if (showVoronoi) {
      const surfaceFrequency =
        planet.surfaceDescriptor?.config.gridKind === 'geodesic' ? planet.surfaceDescriptor.config.frequency : null;
      const overlayFrequency = resolveOverlayFrequency(surfaceFrequency, qualityScreenPx);
      const desiredOverlay = getVoronoiOverlayGeometry(overlayFrequency);
      if (assets.overlayMesh.geometry !== desiredOverlay) {
        assets.overlayMesh.geometry = desiredOverlay;
      }
    }

    this.requestPlanetTexture(assets, system.id, qualityScreenPx);

    const starPositions = this.computeStarPositions(system, this.starPositionScratch);
    const maxLights = Math.min(assets.starLights.length, system.stars.length);
    for (let i = 0; i < assets.starLights.length; i += 1) {
      const light = assets.starLights[i];
      const target = assets.starLightTargets[i];
      if (i >= maxLights) {
        light.visible = false;
        continue;
      }
      const star = system.stars[i];
      const starPosition = starPositions[i] ?? vec3();
      const relativeStar = subVec3(this.planetLightScratch, starPosition, planetSystemPos);
      const distanceAu = Math.max(0.05, lengthVec3(relativeStar) / AU_METERS);
      const relativeUnit = normalizeVec3(this.planetLightDirectionScratch, relativeStar);
      light.position.set(
        (relativeUnit.x * 10),
        (relativeUnit.y * 10),
        (relativeUnit.z * 10)
      );
      light.color.set(star.baseColor);
      const intensity = clamp((star.luminositySun ?? 1) / (distanceAu * distanceAu), 0.2, 2.2);
      light.intensity = intensity;
      light.visible = true;
      target.position.set(0, 0, 0);
    }

    const minDistance = Math.max(planet.radiusMeters * 1.2, 5_000);
    this.zoom.setBounds(minDistance, this.galaxyRadiusMeters * 2.5);
  }

  private updateFocusTarget(system: SystemViewData | null, dtSeconds: number): void {
    if (!system) return;

    const systemFadeBlend = smoothstep(0.05, 0.6, this.systemFade.value);
    const systemBlend = this.focusSystemId ? 1 : systemFadeBlend;
    const planetBlend = this.activePlanetWorldMeters ? smoothstep(0.2, 0.9, this.planetFade.value) : 0;
    const focusPlanetBlend = this.activePlanetWorldMeters
      ? (this.focusPlanetId ? Math.max(planetBlend, systemFadeBlend) : planetBlend)
      : 0;

    copyVec3(this.focusTargetMeters, this.cameraRig.targetMeters);
    if (systemBlend > 0) {
      lerpVec3(this.focusTargetMeters, this.focusTargetMeters, system.positionMeters, systemBlend);
    }
    if (this.activePlanetWorldMeters && focusPlanetBlend > 0) {
      lerpVec3(this.focusTargetMeters, this.focusTargetMeters, this.activePlanetWorldMeters, focusPlanetBlend);
    }

    const smoothing = clamp(dtSeconds * 6, 0, 1);
    lerpVec3(this.cameraRig.targetMeters, this.cameraRig.targetMeters, this.focusTargetMeters, smoothing);
  }

  private render(originMeters: Vec3, cameraMeters: Vec3): void {
    this.renderer.clear();

    this.renderPass({
      scene: this.galaxyScene,
      originMeters,
      cameraMeters,
      metersPerUnit: this.scales.metersPerGalaxyUnit,
      passExtentMeters: this.galaxyRadiusMeters,
      passCenterMeters: vec3()
    });

    if (this.systemFade.value > 0.01) {
      this.renderer.clearDepth();
      this.renderPass({
        scene: this.systemScene,
        originMeters,
        cameraMeters,
        metersPerUnit: this.scales.metersPerSystemUnit,
        passExtentMeters: this.systemById.get(this.activeSystemId ?? '')?.extentMeters ?? 1,
        passCenterMeters: this.systemById.get(this.activeSystemId ?? '')?.positionMeters ?? vec3()
      });
    }

    if (this.planetFade.value > 0.01) {
      this.renderer.clearDepth();
      this.renderPass({
        scene: this.planetScene,
        originMeters,
        cameraMeters,
        metersPerUnit: this.scales.metersPerPlanetUnit,
        passExtentMeters:
          this.systemById.get(this.activeSystemId ?? '')?.orbitingBodies.find(p => p.id === this.activePlanetId)?.radiusMeters ?? 1,
        passCenterMeters: this.activePlanetWorldMeters ?? this.systemById.get(this.activeSystemId ?? '')?.positionMeters ?? vec3()
      });
    }
  }

  private renderPass(options: {
    scene: THREE.Scene;
    originMeters: Vec3;
    cameraMeters: Vec3;
    metersPerUnit: number;
    passExtentMeters: number;
    passCenterMeters: Vec3;
  }): void {
    this.configureCameraForPass(options);
    this.renderer.render(options.scene, this.camera);
  }

  private configureCameraForPass(options: {
    originMeters: Vec3;
    cameraMeters: Vec3;
    metersPerUnit: number;
    passExtentMeters: number;
    passCenterMeters: Vec3;
  }): void {
    const distanceMeters = distVec3(options.cameraMeters, options.passCenterMeters);
    const distanceUnits = distanceMeters / options.metersPerUnit;
    const extentUnits = Math.max(1, options.passExtentMeters / options.metersPerUnit);
    const isPlanetPass = options.metersPerUnit === this.scales.metersPerPlanetUnit;
    const nearFactor = isPlanetPass ? 0.008 : 0.02;
    const farFactor = isPlanetPass ? 4 : 6;
    const near = Math.max(isPlanetPass ? 0.002 : 0.05, distanceUnits * nearFactor);
    const far = Math.max(near + 8, distanceUnits + extentUnits * farFactor);

    this.camera.near = near;
    this.camera.far = far;
    this.camera.position.set(
      (options.cameraMeters.x - options.originMeters.x) / options.metersPerUnit,
      (options.cameraMeters.y - options.originMeters.y) / options.metersPerUnit,
      (options.cameraMeters.z - options.originMeters.z) / options.metersPerUnit
    );
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private projectMetersToScreen(
    positionMeters: Vec3,
    originMeters: Vec3,
    metersPerUnit: number
  ): { x: number; y: number; z: number } | null {
    const vector = scratchVec3A.set(
      (positionMeters.x - originMeters.x) / metersPerUnit,
      (positionMeters.y - originMeters.y) / metersPerUnit,
      (positionMeters.z - originMeters.z) / metersPerUnit
    );
    vector.project(this.camera);
    if (vector.z < -1 || vector.z > 1) return null;
    const x = (vector.x * 0.5 + 0.5) * this.sizePx.width;
    const y = (-vector.y * 0.5 + 0.5) * this.sizePx.height;
    return { x, y, z: vector.z };
  }

  private pickSystemAtScreen(
    systems: SystemViewData[],
    screenX: number,
    screenY: number,
    originMeters: Vec3,
    cameraMeters: Vec3,
    fovRad: number,
    metersPerUnit: number,
    passCenterMeters: Vec3,
    passExtentMeters: number
  ): { system: SystemViewData; screenDist: number } | null {
    if (systems.length === 0) return null;

    this.configureCameraForPass({
      originMeters,
      cameraMeters,
      metersPerUnit,
      passCenterMeters,
      passExtentMeters
    });

    let best: { system: SystemViewData; screenDist: number } | null = null;

    for (const system of systems) {
      const screenPos = this.projectMetersToScreen(system.positionMeters, originMeters, metersPerUnit);
      if (!screenPos) continue;
      const distance = distVec3(cameraMeters, system.positionMeters);
      const screenRadius = screenSpaceRadiusPx(system.extentMeters, distance, fovRad, this.sizePx.height);
      const threshold = clamp(screenRadius * 1.2 + 6, 12, 120);
      const dx = screenPos.x - screenX;
      const dy = screenPos.y - screenY;
      const distPx = Math.hypot(dx, dy);
      if (distPx > threshold) continue;
      if (!best || distPx < best.screenDist) {
        best = { system, screenDist: distPx };
      }
    }

    return best;
  }

  private pickPlanetAtScreen(
    system: SystemViewData,
    screenX: number,
    screenY: number,
    originMeters: Vec3,
    cameraMeters: Vec3,
    fovRad: number
  ): { planet: BodyViewData; targetMeters: Vec3 } | null {
    if (system.orbitingBodies.length === 0) return null;

    this.configureCameraForPass({
      originMeters,
      cameraMeters,
      metersPerUnit: this.scales.metersPerSystemUnit,
      passCenterMeters: system.positionMeters,
      passExtentMeters: system.extentMeters
    });

    let best: { planet: BodyViewData; targetMeters: Vec3; screenDist: number } | null = null;
    const positions = this.computeOrbitingPositions(system);

    const planetWorld = vec3();
    for (let i = 0; i < system.orbitingBodies.length; i += 1) {
      const planet = system.orbitingBodies[i];
      const orbitPosition = positions[i];
      const planetWorldX = system.positionMeters.x + orbitPosition.x;
      const planetWorldY = system.positionMeters.y + orbitPosition.y;
      const planetWorldZ = system.positionMeters.z + orbitPosition.z;
      setVec3(planetWorld, planetWorldX, planetWorldY, planetWorldZ);
      const screenPos = this.projectMetersToScreen(planetWorld, originMeters, this.scales.metersPerSystemUnit);
      if (!screenPos) continue;
      const dx = cameraMeters.x - planetWorldX;
      const dy = cameraMeters.y - planetWorldY;
      const dz = cameraMeters.z - planetWorldZ;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const screenRadius = screenSpaceRadiusPx(planet.radiusMeters, distance, fovRad, this.sizePx.height);
      const threshold = clamp(screenRadius * 1.4 + 8, 14, 120);
      const screenDx = screenPos.x - screenX;
      const screenDy = screenPos.y - screenY;
      const distPx = Math.hypot(screenDx, screenDy);
      if (distPx > threshold) continue;
      if (!best || distPx < best.screenDist) {
        best = { planet, targetMeters: planetWorld, screenDist: distPx };
      }
    }

    return best ? { planet: best.planet, targetMeters: best.targetMeters } : null;
  }

  private updateRootOffsets(originMeters: Vec3): void {
    this.galaxyRoot.position.set(
      -originMeters.x / this.scales.metersPerGalaxyUnit,
      -originMeters.y / this.scales.metersPerGalaxyUnit,
      -originMeters.z / this.scales.metersPerGalaxyUnit
    );
  }

  private rebuildGalaxyPoints(excludeSystemId?: string): void {
    if (this.galaxyPoints) {
      this.galaxyRoot.remove(this.galaxyPoints);
      this.galaxyPoints.geometry.dispose();
      (this.galaxyPoints.material as THREE.PointsMaterial).dispose();
    }

    const systems = this.data.systems.filter(system => system.id !== excludeSystemId);
    const positions = new Float32Array(systems.length * 3);
    const colors = new Float32Array(systems.length * 3);

    systems.forEach((system, index) => {
      const baseIndex = index * 3;
      positions[baseIndex] = system.positionMeters.x / this.scales.metersPerGalaxyUnit;
      positions[baseIndex + 1] = system.positionMeters.y / this.scales.metersPerGalaxyUnit;
      positions[baseIndex + 2] = system.positionMeters.z / this.scales.metersPerGalaxyUnit;

      const color = new THREE.Color(system.markerColor);
      colors[baseIndex] = color.r;
      colors[baseIndex + 1] = color.g;
      colors[baseIndex + 2] = color.b;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 5,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9
    });

    this.galaxyPoints = new THREE.Points(geometry, material);
    this.galaxyRoot.add(this.galaxyPoints);
  }

  private rebuildFleetPoints(): void {
    if (this.fleetPoints) {
      this.galaxyRoot.remove(this.fleetPoints);
      this.fleetPoints.geometry.dispose();
      (this.fleetPoints.material as THREE.PointsMaterial).dispose();
    }

    const fleets = this.data.fleets ?? [];
    if (fleets.length === 0) {
      this.fleetPoints = null;
      return;
    }

    const positions = new Float32Array(fleets.length * 3);
    const colors = new Float32Array(fleets.length * 3);

    fleets.forEach((fleet, index) => {
      const baseIndex = index * 3;
      positions[baseIndex] = fleet.positionMeters.x / this.scales.metersPerGalaxyUnit;
      positions[baseIndex + 1] = fleet.positionMeters.y / this.scales.metersPerGalaxyUnit;
      positions[baseIndex + 2] = fleet.positionMeters.z / this.scales.metersPerGalaxyUnit;

      const color = new THREE.Color(fleet.color);
      colors[baseIndex] = color.r;
      colors[baseIndex + 1] = color.g;
      colors[baseIndex + 2] = color.b;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 3,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.85
    });

    this.fleetPoints = new THREE.Points(geometry, material);
    this.galaxyRoot.add(this.fleetPoints);
  }

  private rebuildSystemFleetPoints(system: SystemViewData): void {
    if (this.systemFleetPoints) {
      this.systemRoot.remove(this.systemFleetPoints);
      this.systemFleetPoints.geometry.dispose();
      (this.systemFleetPoints.material as THREE.PointsMaterial).dispose();
      this.systemFleetPoints = null;
    }

    const fleets = (this.data.fleets ?? []).filter(fleet => fleet.systemId === system.id);
    if (fleets.length === 0) return;

    const positions = new Float32Array(fleets.length * 3);
    const colors = new Float32Array(fleets.length * 3);

    fleets.forEach((fleet, index) => {
      const baseIndex = index * 3;
      positions[baseIndex] = (fleet.positionMeters.x - system.positionMeters.x) / this.scales.metersPerSystemUnit;
      positions[baseIndex + 1] = (fleet.positionMeters.y - system.positionMeters.y) / this.scales.metersPerSystemUnit;
      positions[baseIndex + 2] = (fleet.positionMeters.z - system.positionMeters.z) / this.scales.metersPerSystemUnit;

      const color = new THREE.Color(fleet.color);
      colors[baseIndex] = color.r;
      colors[baseIndex + 1] = color.g;
      colors[baseIndex + 2] = color.b;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9
    });

    this.systemFleetPoints = new THREE.Points(geometry, material);
    this.systemRoot.add(this.systemFleetPoints);
  }

  private ensureSystemAssets(system: SystemViewData): void {
    if (this.systemAssets.has(system.id)) return;

    this.streamingQueue.enqueue(`system:${system.id}`, () => {
      if (this.systemAssets.has(system.id)) return;
      const assets = this.createSystemAssets(system);
      this.systemAssets.set(system.id, assets);
    });
  }

  private ensurePlanetAssets(planet: BodyViewData): void {
    if (this.planetAssets.has(planet.id)) return;

    this.streamingQueue.enqueue(`planet:${planet.id}`, () => {
      if (this.planetAssets.has(planet.id)) return;
      const assets = this.createPlanetAssets(planet);
      this.planetAssets.set(planet.id, assets);
    });
  }

  private createOrbitLine(orbit: OrbitElements): {
    line: THREE.Line | Line2;
    material: THREE.LineBasicMaterial | LineMaterial;
    geometry: THREE.BufferGeometry | LineGeometry;
  } {
    if (this.orbitLineMode === 'line2') {
      const geometry = getOrbitLineGeometry(orbit, this.scales.metersPerSystemUnit);
      const material = new LineMaterial({
        color: 0x5e6a84,
        linewidth: 1.2,
        transparent: true,
        opacity: 0.4
      });
      material.resolution.set(this.sizePx.width, this.sizePx.height);
      const line = new Line2(geometry, material);
      line.computeLineDistances();
      return { line, material, geometry };
    }

    const geometry = getOrbitGeometry(orbit, this.scales.metersPerSystemUnit);
    const material = new THREE.LineBasicMaterial({
      color: '#5e6a84',
      transparent: true,
      opacity: 0.4
    });
    const line = new THREE.Line(geometry, material);
    return { line, material, geometry };
  }

  private createSystemAssets(system: SystemViewData): SystemAssets {
    const group = new THREE.Group();
    const orbitGroup = new THREE.Group();
    group.add(orbitGroup);

    const starMeshes: THREE.Mesh[] = [];
    const starMaterials: THREE.MeshBasicMaterial[] = [];
    const starLights: THREE.PointLight[] = [];
    const starHalos: THREE.Sprite[] = [];
    const starPositions: Vec3[] = system.stars.map(() => vec3());
    const starData = system.stars;

    system.stars.forEach((star, index) => {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(star.baseColor),
        transparent: true,
        opacity: 1
      });
      const mesh = new THREE.Mesh(getSphereGeometry(32, 24), material);
      mesh.scale.setScalar(star.radiusMeters / this.scales.metersPerSystemUnit);
      group.add(mesh);

      const haloMaterial = new THREE.SpriteMaterial({
        color: new THREE.Color(star.baseColor),
        transparent: true,
        opacity: 0.35,
        depthWrite: false
      });
      const halo = new THREE.Sprite(haloMaterial);
      halo.scale.setScalar((star.radiusMeters / this.scales.metersPerSystemUnit) * 2.6);
      group.add(halo);

      const intensity = Math.min(2.5, Math.max(0.4, Math.sqrt(star.luminositySun ?? 1)));
      const light = new THREE.PointLight(star.baseColor, intensity, 0, 2);
      light.userData.baseIntensity = intensity;
      group.add(light);

      starMeshes.push(mesh);
      starMaterials.push(material);
      starHalos.push(halo);
      starLights.push(light);
      starPositions[index] = vec3();
    });

    const orbitLines: Array<THREE.Line | Line2> = [];
    const orbitMaterials: Array<THREE.LineBasicMaterial | LineMaterial> = [];
    const orbitGeometries: Array<THREE.BufferGeometry | LineGeometry> = [];
    const orbitParents: Array<number | null> = [];
    const orbitParentStars: Array<number | null> = [];

    const bodyData = system.orbitingBodies;
    const bodyPositions = bodyData.map(() => vec3());
    const bodyParentIndex = system.orbitingParentIndex;
    const bodyParentStarIndex = system.orbitingParentStarIndex;

    bodyData.forEach((body, index) => {
      if (!body.orbit) return;
      const { line, material, geometry } = this.createOrbitLine(body.orbit);
      orbitGroup.add(line);
      orbitLines.push(line);
      orbitMaterials.push(material);
      orbitGeometries.push(geometry);
      orbitParents.push(bodyParentIndex[index]);
      orbitParentStars.push(bodyParentStarIndex[index]);
    });

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.8,
      metalness: 0.05,
      transparent: true,
      opacity: 1,
      vertexColors: true
    });
    const bodyMesh = new THREE.InstancedMesh(getSphereGeometry(16, 12), bodyMaterial, Math.max(1, bodyData.length));
    bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, bodyData.length) * 3), 3);
    bodyMesh.count = bodyData.length;
    if (bodyMesh.instanceColor) {
      bodyData.forEach((body, index) => {
        const color = new THREE.Color(body.baseColor);
        bodyMesh.instanceColor?.setXYZ(index, color.r, color.g, color.b);
      });
      bodyMesh.instanceColor.needsUpdate = true;
    }
    group.add(bodyMesh);

    const pointPositions = new Float32Array(Math.max(1, bodyData.length) * 3);
    const pointColors = new Float32Array(Math.max(1, bodyData.length) * 3);
    bodyData.forEach((body, index) => {
      const baseIndex = index * 3;
      const color = new THREE.Color(body.baseColor);
      pointPositions[baseIndex] = 0;
      pointPositions[baseIndex + 1] = 0;
      pointPositions[baseIndex + 2] = 0;
      pointColors[baseIndex] = color.r;
      pointColors[baseIndex + 1] = color.g;
      pointColors[baseIndex + 2] = color.b;
    });
    const bodyPointGeometry = new THREE.BufferGeometry();
    bodyPointGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
    bodyPointGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));
    const bodyPointMaterial = new THREE.PointsMaterial({
      size: 6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.85
    });
    const bodyPoints = new THREE.Points(bodyPointGeometry, bodyPointMaterial);
    group.add(bodyPoints);

    const ambient = new THREE.AmbientLight(0x404040, 0.25);
    group.add(ambient);

    return {
      group,
      orbitGroup,
      starMeshes,
      starMaterials,
      starLights,
      starHalos,
      starData,
      starPositions,
      orbitLines,
      orbitMaterials,
      orbitGeometries,
      bodyMesh,
      bodyMaterial,
      bodyPointGeometry,
      bodyPointMaterial,
      bodyPoints,
      bodyData,
      bodyPositions,
      bodyParentIndex,
      bodyParentStarIndex,
      orbitParents,
      orbitParentStars,
      maxOrbitMeters: system.extentMeters
    };
  }

  private createPlanetAssets(planet: BodyViewData): PlanetAssets {
    const group = new THREE.Group();
    const tiltGroup = new THREE.Group();
    const spinGroup = new THREE.Group();
    tiltGroup.rotation.x = planet.axialTiltRad ?? 0;
    group.add(tiltGroup);
    tiltGroup.add(spinGroup);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(planet.baseColor),
      roughness: 0.7,
      metalness: 0.05,
      transparent: true,
      opacity: 0
    });
    const bodyMesh = new THREE.Mesh(getSphereGeometry(64, 48), bodyMaterial);
    bodyMesh.scale.setScalar(planet.radiusMeters / this.scales.metersPerPlanetUnit);
    spinGroup.add(bodyMesh);

    const atmosphereMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(planet.baseColor).lerp(new THREE.Color('#9fd3ff'), 0.35),
      transparent: true,
      opacity: 0.18,
      roughness: 0.2,
      metalness: 0,
      transmission: 0.2,
      depthWrite: false
    });
    const atmosphereMesh = new THREE.Mesh(getSphereGeometry(64, 48), atmosphereMaterial);
    atmosphereMesh.scale.setScalar((planet.radiusMeters / this.scales.metersPerPlanetUnit) * 1.02);
    spinGroup.add(atmosphereMesh);

    const cloudMaterial = new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.25,
      roughness: 0.4,
      metalness: 0,
      depthWrite: false
    });
    const cloudMesh = new THREE.Mesh(getSphereGeometry(64, 48), cloudMaterial);
    cloudMesh.scale.setScalar((planet.radiusMeters / this.scales.metersPerPlanetUnit) * 1.035);
    spinGroup.add(cloudMesh);

    let ringMesh: THREE.Mesh | null = null;
    if (planet.planetClass === 'gas_giant' || planet.planetClass === 'ice_giant') {
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: '#cfd6e6',
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide
      });
      const innerRadius = (planet.radiusMeters / this.scales.metersPerPlanetUnit) * 1.4;
      const outerRadius = innerRadius * 1.8;
      const ringGeometry = new THREE.RingGeometry(innerRadius, outerRadius, 64);
      ringMesh = new THREE.Mesh(ringGeometry, ringMaterial);
      ringMesh.rotation.x = Math.PI / 2;
      tiltGroup.add(ringMesh);
    }

    const overlayMaterial = new THREE.LineBasicMaterial({
      color: '#d8dbe6',
      transparent: true,
      opacity: 0
    });
    const overlayGeometry = new THREE.BufferGeometry();
    const overlayMesh = new THREE.LineSegments(overlayGeometry, overlayMaterial);
    overlayMesh.scale.setScalar((planet.radiusMeters / this.scales.metersPerPlanetUnit) * 1.002);
    spinGroup.add(overlayMesh);

    let triOverlayMesh: THREE.LineSegments | null = null;
    let triOverlayMaterial: THREE.LineBasicMaterial | null = null;
    if (this.overlayMode === 'triangulated' || this.overlayMode === 'both') {
      triOverlayMaterial = new THREE.LineBasicMaterial({
        color: '#91a0c1',
        transparent: true,
        opacity: 0
      });
      const triGeometry = new THREE.WireframeGeometry(getSphereGeometry(24, 18));
      triOverlayMesh = new THREE.LineSegments(triGeometry, triOverlayMaterial);
      triOverlayMesh.scale.setScalar((planet.radiusMeters / this.scales.metersPerPlanetUnit) * 1.003);
      spinGroup.add(triOverlayMesh);
    }

    const starLights: THREE.DirectionalLight[] = [];
    const starLightTargets: THREE.Object3D[] = [];
    for (let i = 0; i < 3; i += 1) {
      const light = new THREE.DirectionalLight('#ffffff', 1);
      const target = new THREE.Object3D();
      light.target = target;
      light.visible = false;
      group.add(light);
      group.add(target);
      starLights.push(light);
      starLightTargets.push(target);
    }

    const ambient = new THREE.AmbientLight(0x202020, 0.25);
    group.add(ambient);

    return {
      group,
      tiltGroup,
      spinGroup,
      bodyMesh,
      bodyMaterial,
      atmosphereMesh,
      atmosphereMaterial,
      cloudMesh,
      cloudMaterial,
      ringMesh,
      overlayMesh,
      overlayMaterial,
      triOverlayMesh,
      triOverlayMaterial,
      planetData: planet,
      textureState: {
        seed: deriveSeed(hashString(planet.id), 'texture'),
        resolution: 0,
        targetResolution: 0
      },
      rotationSpeedRadPerDay: TWO_PI / Math.max(0.1, planet.rotationPeriodDays ?? 1),
      axialTiltRad: planet.axialTiltRad ?? 0,
      starLights,
      starLightTargets
    };
  }
}
