import * as THREE from 'three';
import { sorted, type GameState, type StarSystem, type PlanetBody, type PlanetData, type Fleet, type Vec3 } from '../shared/shared';
import { getOrbitingSystem } from '../engine/orbit';
import type { GameScenario, ScenarioViewConfig, ScenarioViewFocusMode, ScenarioViewStartScale } from '../content/scenarios';

const AU_METERS = 149_597_870_700;
const LY_METERS = 9_460_730_472_580_800;
const EARTH_RADIUS_METERS = 6_371_000;
const SUN_RADIUS_METERS = 695_700_000;
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
const quat = (x = 0, y = 0, z = 0, w = 1): Quaternion => ({ x, y, z, w });

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

const lengthVec3 = (v: Vec3): number => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

const distVec3 = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

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
const axisX = new THREE.Vector3(1, 0, 0);
const axisY = new THREE.Vector3(0, 1, 0);

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

export interface PlanetViewData {
  id: string;
  name: string;
  radiusMeters: number;
  orbitRadiusMeters: number;
  orbitInclinationRad: number;
  orbitAscendingNodeRad: number;
  orbitPhaseRad: number;
  orbitPeriodDays: number;
  color: string;
}

export interface SystemViewData {
  id: string;
  name: string;
  positionMeters: Vec3;
  color: string;
  starRadiusMeters: number;
  extentMeters: number;
  planets: PlanetViewData[];
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

const orbitPeriodDaysFromAu = (semiMajorAxisAu: number): number => {
  const clamped = Math.max(0.05, semiMajorAxisAu);
  return Math.pow(clamped, 1.5) * 365.25;
};

const buildPlanetViewData = (
  body: PlanetBody,
  astro: PlanetData | undefined,
  systemSeed: number,
  index: number
): PlanetViewData => {
  const planetSeed = deriveSeed(systemSeed, `planet:${body.id}`);
  const rng = new Rng32(planetSeed);

  const radiusMeters = Math.max(0.25, body.size ?? 1) * EARTH_RADIUS_METERS;
  const orbitRadiusAu = astro?.semiMajorAxisAu ?? (index + 1) * 0.4;
  const orbitRadiusMeters = orbitRadiusAu * AU_METERS;

  return {
    id: body.id,
    name: body.name,
    radiusMeters,
    orbitRadiusMeters,
    orbitInclinationRad: degToRad(astro?.orbitInclinationDeg ?? 0),
    orbitAscendingNodeRad: degToRad(astro?.orbitAscendingNodeDeg ?? 0),
    orbitPhaseRad: rng.range(0, TWO_PI),
    orbitPeriodDays: orbitPeriodDaysFromAu(orbitRadiusAu),
    color: colorFromSeed(planetSeed)
  };
};

const buildSystemViewData = (system: StarSystem, galaxySeed: number): SystemViewData => {
  const systemSeed = deriveSeed(galaxySeed, `system:${system.id}`);
  const planetsAstro = system.astro?.planets ?? [];
  const planets: PlanetViewData[] = [];
  let maxOrbitMeters = 0;
  let maxPlanetRadius = 0;

  system.planets.forEach((body, index) => {
    const planet = buildPlanetViewData(body, planetsAstro[index], systemSeed, index);
    planets.push(planet);
    maxOrbitMeters = Math.max(maxOrbitMeters, planet.orbitRadiusMeters);
    maxPlanetRadius = Math.max(maxPlanetRadius, planet.radiusMeters);
  });

  const starRadiusMeters = Math.max(0.4, system.size ?? 1) * SUN_RADIUS_METERS;
  const extentMeters = Math.max(starRadiusMeters * 2, maxOrbitMeters + maxPlanetRadius);

  return {
    id: system.id,
    name: system.name,
    positionMeters: scaleVec3(vec3(), system.position, LY_METERS),
    color: system.color || colorFromSeed(systemSeed),
    starRadiusMeters,
    extentMeters,
    planets
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
  const solid = sortedBodies.find(body => body.isSolid);
  return solid?.id ?? sortedBodies[0]?.id ?? null;
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
  const planetData = focusPlanetId ? focusSystemData?.planets.find(planet => planet.id === focusPlanetId) : undefined;

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
}

type SystemAssets = {
  group: THREE.Group;
  starMesh: THREE.Mesh;
  starMaterial: THREE.MeshBasicMaterial;
  orbitLines: THREE.Line[];
  orbitMaterials: THREE.LineBasicMaterial[];
  planetMeshes: THREE.Mesh[];
  planetMaterials: THREE.MeshStandardMaterial[];
  planetData: PlanetViewData[];
  maxOrbitMeters: number;
};

type PlanetAssets = {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  bodyMaterial: THREE.MeshStandardMaterial;
  overlayMesh: THREE.Mesh;
  overlayMaterial: THREE.MeshBasicMaterial;
  planetData: PlanetViewData;
};

const getSphereGeometry = (() => {
  const cache = new Map<string, THREE.SphereGeometry>();
  return (segments: number, rings: number): THREE.SphereGeometry => {
    const key = `${segments}:${rings}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const geometry = new THREE.SphereGeometry(1, segments, rings);
    cache.set(key, geometry);
    return geometry;
  };
})();

const getOrbitGeometry = (() => {
  const cache = new Map<number, THREE.BufferGeometry>();
  return (radiusUnits: number, segments = 128): THREE.BufferGeometry => {
    const key = Math.round(radiusUnits * 1000 + segments * 1000000);
    const cached = cache.get(key);
    if (cached) return cached;

    const positions = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i += 1) {
      const t = (i / segments) * TWO_PI;
      positions[i * 3] = Math.cos(t) * radiusUnits;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = Math.sin(t) * radiusUnits;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    cache.set(key, geometry);
    return geometry;
  };
})();

const screenSpaceRadiusPx = (radiusMeters: number, distanceMeters: number, fovRad: number, heightPx: number): number => {
  if (distanceMeters <= 0) return heightPx;
  const projectionFactor = heightPx / (2 * Math.tan(fovRad / 2));
  return (radiusMeters * projectionFactor) / distanceMeters;
};

const computeOrbitPositionMeters = (planet: PlanetViewData, timeDays: number): Vec3 => {
  const angle = planet.orbitPhaseRad + (timeDays / planet.orbitPeriodDays) * TWO_PI;
  const radius = planet.orbitRadiusMeters;
  const position = scratchVec3A.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  position.applyAxisAngle(axisY, planet.orbitAscendingNodeRad);
  position.applyAxisAngle(axisX, planet.orbitInclinationRad);
  return fromThreeVec3(position);
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

  private floatingOrigin: FloatingOriginManager;
  private zoom: ZoomController;
  private cameraRig: CameraRig;
  private timeDays = 0;
  private timeScaleDaysPerSecond: number;

  private galaxyRadiusMeters = 1;
  private focusSystemId: string | null = null;

  private sizePx = { width: 1, height: 1 };
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private lastOriginMeters: Vec3 = vec3();
  private lastCameraMeters: Vec3 = vec3();

  constructor(options: SpaceViewOptions) {
    this.data = options.data;
    this.thresholds = {
      systemEnterPx: 200,
      systemExitPx: 150,
      systemPreloadPx: 160,
      planetEnterPx: 240,
      planetExitPx: 180,
      planetPreloadPx: 200,
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

    const initialWidth = options.canvas.clientWidth || options.canvas.width || 800;
    const initialHeight = options.canvas.clientHeight || options.canvas.height || 600;
    this.resize(initialWidth, initialHeight, options.pixelRatio);
  }

  setData(data: GalaxyViewData): void {
    this.data = data;
    this.systemById.clear();

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
    if (!systemId) return;
    const system = this.systemById.get(systemId);
    if (system) {
      this.cameraRig.setTargetMeters(system.positionMeters);
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
        this.cameraRig.setTargetMeters(planetPick.targetMeters);
        return true;
      }
    }

    if (activeSystem && this.systemFade.value > 0.2) {
      const planetPick = this.pickPlanetAtScreen(activeSystem, screenX, screenY, originMeters, cameraMeters, fovRad);
      if (planetPick) {
        this.focusSystemId = activeSystem.id;
        this.cameraRig.setTargetMeters(planetPick.targetMeters);
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
        this.cameraRig.setTargetMeters(systemPick.system.positionMeters);
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
      this.cameraRig.setTargetMeters(galaxyPick.system.positionMeters);
      return true;
    }

    return false;
  }

  resize(width: number, height: number, pixelRatio?: number): void {
    const ratio = pixelRatio ?? Math.min(2, Number(globalThis.devicePixelRatio) || 1);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.sizePx = { width, height };
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

    this.camera.quaternion.copy(cameraState.quaternion);
    this.render(originMeters, cameraState.positionMeters);
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
    this.systemAssets.clear();
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
      return;
    }

    this.activeSystemImpostor.visible = true;
    if (system.id !== this.activeSystemId) {
      this.activeSystemId = system.id;
      this.rebuildGalaxyPoints(system.id);
      this.activeSystemMaterial.color = new THREE.Color(system.color);
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
      return;
    }

    let bestPlanet: PlanetViewData | null = null;
    let bestPlanetWorld: Vec3 | null = null;
    let bestScore = 0;

    for (const planet of system.planets) {
      const orbitPosition = computeOrbitPositionMeters(planet, this.timeDays);
      const planetWorld = addVec3(vec3(), system.positionMeters, orbitPosition);
      const distance = distVec3(cameraMeters, planetWorld);
      const screenPx = screenSpaceRadiusPx(planet.radiusMeters, distance, this.camera.fov * (Math.PI / 180), this.sizePx.height);

      if (screenPx > bestScore) {
        bestScore = screenPx;
        bestPlanet = planet;
        bestPlanetWorld = planetWorld;
      }
    }

    if (!bestPlanet) {
      this.planetFade.update(dtSeconds, false);
      this.activePlanetId = null;
      this.activePlanetWorldMeters = null;
      this.planetRoot.visible = false;
      return;
    }

    const detailed = this.planetGate.update(bestScore);
    const fade = this.planetFade.update(dtSeconds, detailed);

    if (bestScore >= this.thresholds.planetPreloadPx) {
      this.ensurePlanetAssets(bestPlanet);
    }

    this.activePlanetId = bestPlanet.id;
    this.activePlanetWorldMeters = bestPlanetWorld;
    this.planetRoot.visible = true;
  }

  private updateSystemAssets(system: SystemViewData | null, originMeters: Vec3): void {
    if (!system) return;

    const assets = this.systemAssets.get(system.id);
    const systemOpacity = this.systemFade.value;
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

      assets.starMaterial.opacity = systemOpacity;
      assets.orbitMaterials.forEach(material => {
        material.opacity = systemOpacity * 0.6;
      });

      for (let i = 0; i < assets.planetMeshes.length; i += 1) {
        const planet = assets.planetData[i];
        const mesh = assets.planetMeshes[i];
        const material = assets.planetMaterials[i];
        const orbitPosition = computeOrbitPositionMeters(planet, this.timeDays);
        mesh.position.set(
          orbitPosition.x / this.scales.metersPerSystemUnit,
          orbitPosition.y / this.scales.metersPerSystemUnit,
          orbitPosition.z / this.scales.metersPerSystemUnit
        );

        const isActive = planet.id === this.activePlanetId;
        const planetOpacity = systemOpacity * (isActive ? 1 - this.planetFade.value : 1);
        material.opacity = planetOpacity;
      }
    }

    if (this.systemFleetPoints) {
      this.systemFleetPoints.position.set(
        (system.positionMeters.x - originMeters.x) / this.scales.metersPerSystemUnit,
        (system.positionMeters.y - originMeters.y) / this.scales.metersPerSystemUnit,
        (system.positionMeters.z - originMeters.z) / this.scales.metersPerSystemUnit
      );
      (this.systemFleetPoints.material as THREE.PointsMaterial).opacity = systemOpacity;
    }

    const minDistance = Math.max(5_000, (system.planets.find(p => p.id === this.activePlanetId)?.radiusMeters ?? 0) * 1.2);
    this.zoom.setBounds(minDistance, this.galaxyRadiusMeters * 2.5);
  }

  private updatePlanetAssets(system: SystemViewData | null, originMeters: Vec3): void {
    if (!system || !this.activePlanetId) return;
    if (this.planetFade.value <= 0) return;

    const planet = system.planets.find(p => p.id === this.activePlanetId);
    if (!planet) return;

    const assets = this.planetAssets.get(planet.id);
    if (!assets) return;

    if (!this.planetRoot.children.includes(assets.group)) {
      this.planetRoot.clear();
      this.planetRoot.add(assets.group);
    }

    const planetWorld = this.activePlanetWorldMeters ?? addVec3(vec3(), system.positionMeters, computeOrbitPositionMeters(planet, this.timeDays));

    assets.group.position.set(
      (planetWorld.x - originMeters.x) / this.scales.metersPerPlanetUnit,
      (planetWorld.y - originMeters.y) / this.scales.metersPerPlanetUnit,
      (planetWorld.z - originMeters.z) / this.scales.metersPerPlanetUnit
    );

    assets.bodyMaterial.opacity = this.planetFade.value;
    assets.overlayMaterial.opacity = this.planetFade.value * 0.35;

    const minDistance = Math.max(planet.radiusMeters * 1.2, 5_000);
    this.zoom.setBounds(minDistance, this.galaxyRadiusMeters * 2.5);
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
          this.systemById.get(this.activeSystemId ?? '')?.planets.find(p => p.id === this.activePlanetId)?.radiusMeters ?? 1,
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

    const near = Math.max(0.05, distanceUnits * 0.02);
    const far = Math.max(near + 10, distanceUnits + extentUnits * 6);

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
  ): { planet: PlanetViewData; targetMeters: Vec3 } | null {
    if (system.planets.length === 0) return null;

    this.configureCameraForPass({
      originMeters,
      cameraMeters,
      metersPerUnit: this.scales.metersPerSystemUnit,
      passCenterMeters: system.positionMeters,
      passExtentMeters: system.extentMeters
    });

    let best: { planet: PlanetViewData; targetMeters: Vec3; screenDist: number } | null = null;

    for (const planet of system.planets) {
      const orbitPosition = computeOrbitPositionMeters(planet, this.timeDays);
      const planetWorld = addVec3(vec3(), system.positionMeters, orbitPosition);
      const screenPos = this.projectMetersToScreen(planetWorld, originMeters, this.scales.metersPerSystemUnit);
      if (!screenPos) continue;
      const distance = distVec3(cameraMeters, planetWorld);
      const screenRadius = screenSpaceRadiusPx(planet.radiusMeters, distance, fovRad, this.sizePx.height);
      const threshold = clamp(screenRadius * 1.4 + 8, 14, 120);
      const dx = screenPos.x - screenX;
      const dy = screenPos.y - screenY;
      const distPx = Math.hypot(dx, dy);
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

      const color = new THREE.Color(system.color);
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
      size: 4,
      sizeAttenuation: true,
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

  private ensurePlanetAssets(planet: PlanetViewData): void {
    if (this.planetAssets.has(planet.id)) return;

    this.streamingQueue.enqueue(`planet:${planet.id}`, () => {
      if (this.planetAssets.has(planet.id)) return;
      const assets = this.createPlanetAssets(planet);
      this.planetAssets.set(planet.id, assets);
    });
  }

  private createSystemAssets(system: SystemViewData): SystemAssets {
    const group = new THREE.Group();

    const starMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(system.color),
      transparent: true,
      opacity: 1
    });
    const starMesh = new THREE.Mesh(getSphereGeometry(32, 24), starMaterial);
    const starRadiusUnits = system.starRadiusMeters / this.scales.metersPerSystemUnit;
    starMesh.scale.setScalar(starRadiusUnits);
    group.add(starMesh);

    const orbitLines: THREE.Line[] = [];
    const orbitMaterials: THREE.LineBasicMaterial[] = [];
    const planetMeshes: THREE.Mesh[] = [];
    const planetMaterials: THREE.MeshStandardMaterial[] = [];

    system.planets.forEach(planet => {
      const orbitRadiusUnits = planet.orbitRadiusMeters / this.scales.metersPerSystemUnit;
      const orbitMaterial = new THREE.LineBasicMaterial({
        color: '#5e6a84',
        transparent: true,
        opacity: 0.4
      });
      const orbit = new THREE.Line(getOrbitGeometry(orbitRadiusUnits), orbitMaterial);
      orbitLines.push(orbit);
      orbitMaterials.push(orbitMaterial);
      group.add(orbit);

      const planetMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(planet.color),
        roughness: 0.8,
        metalness: 0.05,
        transparent: true,
        opacity: 1
      });
      const planetMesh = new THREE.Mesh(getSphereGeometry(14, 10), planetMaterial);
      planetMesh.scale.setScalar(planet.radiusMeters / this.scales.metersPerSystemUnit);
      planetMeshes.push(planetMesh);
      planetMaterials.push(planetMaterial);
      group.add(planetMesh);
    });

    const ambient = new THREE.AmbientLight(0x404040, 0.7);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1, 0.5);
    group.add(ambient, key);

    return {
      group,
      starMesh,
      starMaterial,
      orbitLines,
      orbitMaterials,
      planetMeshes,
      planetMaterials,
      planetData: system.planets,
      maxOrbitMeters: system.extentMeters
    };
  }

  private createPlanetAssets(planet: PlanetViewData): PlanetAssets {
    const group = new THREE.Group();

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(planet.color),
      roughness: 0.7,
      metalness: 0.05,
      transparent: true,
      opacity: 0
    });
    const bodyMesh = new THREE.Mesh(getSphereGeometry(64, 48), bodyMaterial);
    bodyMesh.scale.setScalar(planet.radiusMeters / this.scales.metersPerPlanetUnit);
    group.add(bodyMesh);

    const overlayMaterial = new THREE.MeshBasicMaterial({
      color: '#d8dbe6',
      wireframe: true,
      transparent: true,
      opacity: 0
    });
    const overlayMesh = new THREE.Mesh(getSphereGeometry(32, 24), overlayMaterial);
    overlayMesh.scale.setScalar((planet.radiusMeters / this.scales.metersPerPlanetUnit) * 1.002);
    group.add(overlayMesh);

    const ambient = new THREE.AmbientLight(0x404040, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 1, 0.5);
    group.add(ambient, key);

    return {
      group,
      bodyMesh,
      bodyMaterial,
      overlayMesh,
      overlayMaterial,
      planetData: planet
    };
  }
}
