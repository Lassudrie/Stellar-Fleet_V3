import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Billboard, OrbitControls, Text } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  AdditiveBlending,
  Camera,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LinearFilter,
  Material,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Mesh,
  Object3D,
  RingGeometry,
  SRGBColorSpace,
  Spherical,
  SphereGeometry,
  TorusGeometry,
  Vector3
} from 'three';
import {
  FactionState,
  Fleet,
  MoonData,
  MoonType,
  PlanetData,
  PlanetType,
  PlanetBodyType,
  PlanetBody,
  Station,
  StarSystem,
  StarSystemAstro
} from '../../../shared/shared';
import { calculateFleetPower } from '../../../engine/world';
import { shortId, sorted } from '../../../shared/shared';
import { useI18n } from '../../i18n';
import { useFleetName } from '../../context/FleetNames';
import SystemBodyInfoPanel, { SystemBodyInfo } from '../ui/SystemBodyInfoPanel';
import SystemFleetInfoPanel from '../ui/SystemFleetInfoPanel';
import SystemStationInfoPanel from '../ui/SystemStationInfoPanel';
import {
  getSystemFleets,
  hashStringToAngle,
  hashStringToUnit,
  layoutTacticalRing,
  makeObjectId,
  parseObjectId,
  type TacticalRingConfig,
  type SystemObjectId
} from './systemViewLayout';

interface SystemView3DProps {
  starSystem: StarSystem;
  astro?: StarSystemAstro;
  fleets?: Fleet[];
  stations?: Station[];
  factions?: FactionState[];
  playerFactionId?: string;
  day?: number;
  selectedFleetId?: string | null;
  onSelectFleet?: (fleetId: string | null) => void;
  onInspectFleet?: (fleetId: string) => void;
  initialCameraState?: SystemCameraState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  scaleFactor?: number;
  showBodyLabels?: boolean;
  onOpenSurfaceView?: (bodyId: string) => void;
}

const KM_PER_AU = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371;
const SOLAR_RADIUS_KM = 695_700;
const KM_TO_SCENE_SCALE = 1 / 10_000_000;
const RADIUS_VISIBILITY_BONUS = 25;
const MIN_PLANET_RADIUS = 0.12;
const MIN_STAR_RADIUS = 0.5;
const ORBIT_THICKNESS = 0.012;
const DEFAULT_ORBIT_INNER_KM = 55_000_000;
const DEFAULT_ORBIT_STEP_KM = 35_000_000;
const STAR_TEXTURE_SIZE = 256;

const PLANET_TYPE_COLORS: Record<PlanetType, string> = {
  Terrestrial: '#cbd5e1',
  SubNeptune: '#9ca3af',
  IceGiant: '#7dd3fc',
  GasGiant: '#fcd34d',
  Dwarf: '#e5e7eb'
};

const MOON_TYPE_COLORS: Record<MoonType, string> = {
  Regular: '#cbd5e1',
  Icy: '#e0f2fe',
  Volcanic: '#fb923c',
  Eden: '#86efac',
  Irregular: '#a5b4fc'
};

type OrbitingMoon = {
  id: string;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
  type: MoonType;
  isSolid?: boolean;
};

type OrbitingPlanet = {
  id: string;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
  type: PlanetType;
  moons: OrbitingMoon[];
};

type PlanetSource = (PlanetData & {
  id?: string;
  radiusKm?: number;
  semiMajorAxisKm?: number;
  planetType?: PlanetType;
  name?: string;
  habitabilityScore?: number;
  isSolid?: boolean;
}) | {
  id?: string;
  class?: string;
  size?: number;
  moons?: MoonData[];
  radiusKm?: number;
  semiMajorAxisKm?: number;
  planetType?: PlanetType;
  name?: string;
  habitabilityScore?: number;
  isSolid?: boolean;
};

type MoonSource = MoonData & {
  radiusKm?: number;
  moonType?: MoonType;
  orbitDistanceKm?: number;
  habitabilityScore?: number;
  id?: string;
  isSolid?: boolean;
};

type UseMemoDisposableDeps = React.DependencyList;

type CelestialBodyType = PlanetBodyType | 'star';

type BodyLabelTarget = {
  id: string;
  name: string;
  position: [number, number, number];
  radius: number;
  kind: 'planet' | 'moon';
  parent?: {
    position: [number, number, number];
    radius: number;
  };
};

type CameraSphericalState = {
  theta: number;
  phi: number;
  radius: number;
};

const useDisposableMemo = <T extends { dispose: () => void }>(
  factory: () => T,
  deps: UseMemoDisposableDeps
): T => {
  const resource = useMemo(factory, deps);
  useEffect(() => {
    return () => {
      resource.dispose();
    };
  }, [resource]);
  return resource;
};

const computeOrbitPosition = (radius: number, angle: number): [number, number, number] => (
  [Math.cos(angle) * radius, 0, Math.sin(angle) * radius]
);

const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const toRgbaString = (color: Color, alpha: number): string => {
  const r = Math.round(MathUtils.clamp(color.r, 0, 1) * 255);
  const g = Math.round(MathUtils.clamp(color.g, 0, 1) * 255);
  const b = Math.round(MathUtils.clamp(color.b, 0, 1) * 255);
  const a = MathUtils.clamp(alpha, 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

const createStarSurfaceTexture = (baseColor: string, seed: number): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STAR_TEXTURE_SIZE;
  canvas.height = STAR_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const base = new Color(baseColor);
  const highlight = base.clone().lerp(new Color('#ffffff'), 0.35);
  const shadow = base.clone().multiplyScalar(0.65);

  context.fillStyle = base.getStyle();
  context.fillRect(0, 0, STAR_TEXTURE_SIZE, STAR_TEXTURE_SIZE);

  const gradient = context.createRadialGradient(
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.12,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.65
  );
  gradient.addColorStop(0, highlight.getStyle());
  gradient.addColorStop(1, shadow.getStyle());
  context.globalAlpha = 0.35;
  context.fillStyle = gradient;
  context.fillRect(0, 0, STAR_TEXTURE_SIZE, STAR_TEXTURE_SIZE);
  context.globalAlpha = 1;

  const rand = createSeededRandom(seed);
  const brightBlobs = 140;
  const darkBlobs = 180;

  for (let i = 0; i < brightBlobs; i += 1) {
    const radius = STAR_TEXTURE_SIZE * (0.04 + rand() * 0.12);
    const x = rand() * STAR_TEXTURE_SIZE;
    const y = rand() * STAR_TEXTURE_SIZE;
    const tint = base.clone().lerp(new Color('#ffffff'), 0.2 + rand() * 0.5);
    context.globalAlpha = 0.08 + rand() * 0.18;
    context.fillStyle = tint.getStyle();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  for (let i = 0; i < darkBlobs; i += 1) {
    const radius = STAR_TEXTURE_SIZE * (0.02 + rand() * 0.07);
    const x = rand() * STAR_TEXTURE_SIZE;
    const y = rand() * STAR_TEXTURE_SIZE;
    const shade = base.clone().multiplyScalar(0.5 + rand() * 0.3);
    context.globalAlpha = 0.1 + rand() * 0.2;
    context.fillStyle = shade.getStyle();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.globalAlpha = 1;
  texture.needsUpdate = true;
  return texture;
};

const createStarGlowTexture = (baseColor: string): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STAR_TEXTURE_SIZE;
  canvas.height = STAR_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const base = new Color(baseColor);
  const inner = base.clone().lerp(new Color('#ffffff'), 0.5);
  const outer = base.clone().multiplyScalar(0.5);
  const gradient = context.createRadialGradient(
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.06,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5
  );
  gradient.addColorStop(0, toRgbaString(inner, 0.95));
  gradient.addColorStop(0.35, toRgbaString(base, 0.6));
  gradient.addColorStop(0.7, toRgbaString(outer, 0.25));
  gradient.addColorStop(1, toRgbaString(outer, 0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, STAR_TEXTURE_SIZE, STAR_TEXTURE_SIZE);
  texture.needsUpdate = true;
  return texture;
};

const MIN_POLAR_ANGLE = 0.15;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

const getPlanetRadiusKm = (planet: PlanetSource): number => {
  if (typeof planet.radiusKm === 'number') {
    return Math.max(planet.radiusKm, 0.1);
  }
  if ('radiusEarth' in planet && typeof planet.radiusEarth === 'number') {
    return Math.max(planet.radiusEarth, 0.1) * EARTH_RADIUS_KM;
  }
  if ('size' in planet && typeof planet.size === 'number') {
    return Math.max(planet.size, 0.1) * EARTH_RADIUS_KM;
  }
  return EARTH_RADIUS_KM;
};

const getPlanetType = (planet: PlanetSource): PlanetType => {
  if (planet.planetType) return planet.planetType;
  if ('type' in planet) return planet.type as PlanetType;
  const planetClass = 'class' in planet ? planet.class : undefined;
  if (planetClass === 'gas_giant') return 'GasGiant';
  if (planetClass === 'ice_giant') return 'IceGiant';
  return 'Terrestrial';
};

const getSemiMajorAxisKm = (planet: PlanetSource, index: number): number => {
  if (typeof planet.semiMajorAxisKm === 'number') {
    return planet.semiMajorAxisKm;
  }
  if ('semiMajorAxisAu' in planet && typeof planet.semiMajorAxisAu === 'number') {
    return planet.semiMajorAxisAu * KM_PER_AU;
  }
  return DEFAULT_ORBIT_INNER_KM + index * DEFAULT_ORBIT_STEP_KM;
};

const getMoonRadiusKm = (moon: MoonSource): number => {
  if (typeof moon.radiusKm === 'number') {
    return Math.max(moon.radiusKm, 0.01);
  }
  return Math.max(moon.radiusEarth, 0.05) * EARTH_RADIUS_KM;
};

const getMoonType = (moon: MoonSource): MoonType => moon.moonType ?? moon.type;

const getMoonOrbitKm = (moon: MoonSource, planetRadiusKm: number): number => {
  if (typeof moon.orbitDistanceKm === 'number') {
    return moon.orbitDistanceKm;
  }
  return moon.orbitDistanceRp * planetRadiusKm;
};

const clampPhi = (phi: number): number => MathUtils.clamp(phi, MIN_POLAR_ANGLE, MAX_POLAR_ANGLE);

const sphericalFromOffset = (offset: Vector3): CameraSphericalState => {
  const spherical = new Spherical().setFromVector3(offset);
  return {
    theta: spherical.theta,
    phi: clampPhi(spherical.phi),
    radius: Math.max(spherical.radius, 0.001)
  };
};

const deriveSphericalState = (
  state: SystemCameraState | undefined,
  anchoredTarget: [number, number, number],
  fallbackPosition: [number, number, number]
): CameraSphericalState => {
  if (state?.theta !== undefined && state?.phi !== undefined && state?.radius !== undefined) {
    return {
      theta: state.theta,
      phi: clampPhi(state.phi),
      radius: Math.max(state.radius, 0.001)
    };
  }

  const anchorTargetVec = new Vector3(...anchoredTarget);
  const positionVec = state?.position ? new Vector3(...state.position) : new Vector3(...fallbackPosition);
  const offset = positionVec.sub(anchorTargetVec);
  return sphericalFromOffset(offset);
};

const positionFromSpherical = (state: CameraSphericalState, target: [number, number, number]): [number, number, number] => {
  const targetVec = new Vector3(...target);
  const spherical = new Spherical(state.radius, clampPhi(state.phi), state.theta);
  const positionVec = new Vector3().setFromSpherical(spherical).add(targetVec);
  return [positionVec.x, positionVec.y, positionVec.z];
};

const buildPlanetModel = (
  planet: PlanetSource,
  index: number,
  total: number,
  sceneScale: number,
  minPlanetRadius: number,
  minMoonRadius: number
): OrbitingPlanet => {
  const radiusKm = getPlanetRadiusKm(planet);
  const semiMajorAxisKm = getSemiMajorAxisKm(planet, index);
  const orbitAngle = (index / Math.max(total, 1)) * Math.PI * 2;
  const orbitRadius = semiMajorAxisKm * sceneScale;
  const radius = Math.max(radiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minPlanetRadius);
  const planetId = planet.id ?? `planet-${index + 1}`;
  const planetType = getPlanetType(planet);

  const moons = (planet.moons ?? []).map((moon, moonIndex) => {
    const moonRadiusKm = getMoonRadiusKm(moon as MoonSource);
    const moonOrbitKm = getMoonOrbitKm(moon as MoonSource, radiusKm);
    const moonOrbitRadius = moonOrbitKm * sceneScale;
    const moonAngle = (moonIndex / Math.max(planet.moons?.length ?? 1, 1)) * Math.PI * 2 + Math.PI / 4;
    const moonId = (moon as MoonSource).id ?? `${planetId}-moon-${moonIndex + 1}`;
    return {
      id: moonId,
      radius: Math.max(moonRadiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minMoonRadius),
      orbitRadius: moonOrbitRadius,
      orbitAngle: moonAngle,
      type: getMoonType(moon as MoonSource),
      isSolid: (moon as MoonSource).isSolid
    };
  });

  return { id: planetId, radius, orbitRadius, orbitAngle, type: planetType, moons };
};

const applyPlanetOrbitSpacing = (
  planets: OrbitingPlanet[],
  starRadius: number,
  planetOrbitClearance: number
): OrbitingPlanet[] => {
  let lastOrbitRadius = starRadius;
  let lastPlanetRadius = 0;

  return planets.map((planet, index) => {
    const minimumDistanceFromStar = starRadius + planet.radius + planetOrbitClearance;
    const minimumDistanceFromPrevious = index === 0
      ? minimumDistanceFromStar
      : lastOrbitRadius + lastPlanetRadius + planet.radius + planetOrbitClearance;
    const adjustedOrbitRadius = Math.max(planet.orbitRadius, minimumDistanceFromPrevious);
    lastOrbitRadius = adjustedOrbitRadius;
    lastPlanetRadius = planet.radius;
    return { ...planet, orbitRadius: adjustedOrbitRadius };
  });
};

const applyMoonOrbitSpacing = (
  moons: OrbitingMoon[],
  planetRadius: number,
  moonOrbitClearance: number
): OrbitingMoon[] => {
  let lastOrbitRadius = planetRadius;
  let lastMoonRadius = 0;

  return moons.map((moon, index) => {
    const minimumDistanceFromPlanet = planetRadius + moon.radius + moonOrbitClearance;
    const minimumDistanceFromPrevious = index === 0
      ? minimumDistanceFromPlanet
      : lastOrbitRadius + lastMoonRadius + moon.radius + moonOrbitClearance;
    const adjustedOrbitRadius = Math.max(moon.orbitRadius, minimumDistanceFromPrevious);
    lastOrbitRadius = adjustedOrbitRadius;
    lastMoonRadius = moon.radius;
    return { ...moon, orbitRadius: adjustedOrbitRadius };
  });
};

const SystemRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <group name="SystemRoot">
    {children}
  </group>
);

type FleetRingBaseOptions = {
  starRadius: number;
  focusDistanceFloor: number;
  planets: OrbitingPlanet[];
  safetyMargin: number;
  minimumOrbitClearance: number;
};

const computeFleetRingBaseRadius = ({
  starRadius,
  focusDistanceFloor,
  planets,
  safetyMargin,
  minimumOrbitClearance
}: FleetRingBaseOptions): number => {
  const minimumRadius = Math.max(starRadius + safetyMargin, focusDistanceFloor * 1.5);

  if (!planets.length) {
    return minimumRadius;
  }

  const closestPlanet = planets.reduce(
    (currentClosest, planet) => (planet.orbitRadius < currentClosest.orbitRadius ? planet : currentClosest),
    planets[0]
  );
  const innerOrbitLimit = closestPlanet.orbitRadius - closestPlanet.radius - minimumOrbitClearance;

  if (innerOrbitLimit >= minimumRadius) {
    return innerOrbitLimit;
  }

  const outerOrbitLimit = closestPlanet.orbitRadius + closestPlanet.radius + minimumOrbitClearance;
  return Math.max(outerOrbitLimit, minimumRadius);
};

interface StarMeshProps {
  radius: number;
  color: string;
  geometry: SphereGeometry;
  seedKey: string;
  onDoubleClick?: (event: ThreeEvent<MouseEvent | PointerEvent>) => void;
  onHover?: () => void;
  onBlur?: () => void;
  onSelect?: () => void;
}

const StarMesh: React.FC<StarMeshProps> = ({
  radius,
  color,
  geometry,
  seedKey,
  onDoubleClick,
  onHover,
  onBlur,
  onSelect
}) => {
  const seed = useMemo(
    () => Math.max(1, Math.floor(hashStringToUnit(seedKey) * 0xffffffff)),
    [seedKey]
  );
  const surfaceTexture = useDisposableMemo(
    () => createStarSurfaceTexture(color, seed),
    [color, seed]
  );
  const glowTexture = useDisposableMemo(
    () => createStarGlowTexture(color),
    [color]
  );
  const coreMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: '#ffffff',
      map: surfaceTexture,
      toneMapped: false
    }),
    [surfaceTexture]
  );
  const innerGlowMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: new Color(color).lerp(new Color('#ffffff'), 0.35),
      map: glowTexture,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    }),
    [color, glowTexture]
  );
  const outerGlowMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: new Color(color).lerp(new Color('#ffffff'), 0.15),
      map: glowTexture,
      transparent: true,
      opacity: 0.25,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    }),
    [color, glowTexture]
  );
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;

  const scale = useMemo<[number, number, number]>(() => [radius, radius, radius], [radius]);
  const innerGlowScale = useMemo<[number, number, number]>(
    () => [radius * 1.15, radius * 1.15, radius * 1.15],
    [radius]
  );
  const outerGlowScale = useMemo<[number, number, number]>(
    () => [radius * 1.45, radius * 1.45, radius * 1.45],
    [radius]
  );
  const coreRef = useRef<Mesh | null>(null);

  useFrame((_, delta) => {
    if (!coreRef.current) return;
    coreRef.current.rotation.y += delta * 0.08;
    coreRef.current.rotation.z += delta * 0.02;
  });

  return (
    <group>
      <mesh
        ref={coreRef}
        geometry={geometry}
        material={coreMaterial}
        scale={scale}
        onDoubleClick={onDoubleClick}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onDoubleClick?.(event);
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover?.();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur?.();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.();
        }}
        frustumCulled
      />
      <mesh
        geometry={geometry}
        material={innerGlowMaterial}
        scale={innerGlowScale}
        raycast={() => null}
        renderOrder={2}
        frustumCulled
      />
      <mesh
        geometry={geometry}
        material={outerGlowMaterial}
        scale={outerGlowScale}
        raycast={() => null}
        renderOrder={3}
        frustumCulled
      />
    </group>
  );
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: MeshBasicMaterial;
  moonGeometry: SphereGeometry;
  moonMaterial: MeshStandardMaterial;
  orbitThickness: number;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string) => void;
}

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps & { onFocus: (bodyId: string) => void }> = ({
  moon,
  orbitMaterial,
  moonGeometry,
  moonMaterial,
  orbitThickness,
  onFocus,
  onHover,
  onBlur,
  onSelect
}) => {
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const hitboxMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    []
  );
  useEffect(() => () => hitboxMaterial.dispose(), [hitboxMaterial]);
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(moon.orbitRadius - orbitThickness, 0.0025), moon.orbitRadius + orbitThickness, 96),
    [moon.orbitRadius, orbitThickness]
  );
  const orbitRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const moonPosition = useMemo<[number, number, number]>(
    () => computeOrbitPosition(moon.orbitRadius, moon.orbitAngle),
    [moon.orbitAngle, moon.orbitRadius]
  );
  const moonHitboxScale = useMemo<[number, number, number]>(
    () => [moon.radius * 2, moon.radius * 2, moon.radius * 2],
    [moon.radius]
  );
  const moonScale = useMemo<[number, number, number]>(() => [moon.radius, moon.radius, moon.radius], [moon.radius]);

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <mesh
        geometry={moonGeometry}
        material={hitboxMaterial}
        position={moonPosition}
        scale={moonHitboxScale}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFocus(moon.id);
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onFocus(moon.id);
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(moon.id);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur(moon.id);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(moon.id);
        }}
        frustumCulled
      />
      <mesh
        geometry={moonGeometry}
        material={moonMaterial}
        position={moonPosition}
        scale={moonScale}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFocus(moon.id);
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onFocus(moon.id);
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(moon.id);
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur(moon.id);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(moon.id);
        }}
        frustumCulled
      />
    </group>
  );
};

interface PlanetOrbitGroupProps {
  planet: OrbitingPlanet;
  orbitMaterial: MeshBasicMaterial;
  planetGeometry: SphereGeometry;
  moonGeometry: SphereGeometry;
  planetMaterial: MeshStandardMaterial;
  moonMaterials: Record<MoonType, MeshStandardMaterial>;
  orbitThickness: number;
  onFocus: (bodyId: string) => void;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string) => void;
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({
  planet,
  orbitMaterial,
  planetGeometry,
  moonGeometry,
  planetMaterial,
  moonMaterials,
  orbitThickness,
  onFocus,
  onHover,
  onBlur,
  onSelect
}) => {
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const hitboxMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    []
  );
  useEffect(() => () => hitboxMaterial.dispose(), [hitboxMaterial]);
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(planet.orbitRadius - orbitThickness, 0.01), planet.orbitRadius + orbitThickness, 128),
    [orbitThickness, planet.orbitRadius]
  );
  const orbitRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const planetPosition = useMemo<[number, number, number]>(
    () => computeOrbitPosition(planet.orbitRadius, planet.orbitAngle),
    [planet.orbitAngle, planet.orbitRadius]
  );
  const planetScale = useMemo<[number, number, number]>(
    () => [planet.radius, planet.radius, planet.radius],
    [planet.radius]
  );
  const planetHitboxScale = useMemo<[number, number, number]>(
    () => [planet.radius * 1.5, planet.radius * 1.5, planet.radius * 1.5],
    [planet.radius]
  );

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <group position={planetPosition}>
        <mesh
          geometry={planetGeometry}
          material={hitboxMaterial}
          scale={planetHitboxScale}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onFocus(planet.id);
          }}
          onPointerDown={(event: ThreeEvent<PointerEvent>) => {
            if (event.pointerType !== 'touch') return;
            const now = performance.now();
            if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
              lastTouchRef.current = 0;
              event.stopPropagation();
              event.nativeEvent.preventDefault();
              onFocus(planet.id);
            } else {
              lastTouchRef.current = now;
            }
          }}
          onPointerOver={(event) => {
            event.stopPropagation();
            onHover(planet.id);
          }}
          onPointerOut={(event) => {
            event.stopPropagation();
            onBlur(planet.id);
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(planet.id);
          }}
          frustumCulled
        />
        <mesh
          geometry={planetGeometry}
          material={planetMaterial}
          scale={planetScale}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onFocus(planet.id);
          }}
          onPointerDown={(event: ThreeEvent<PointerEvent>) => {
            if (event.pointerType !== 'touch') return;
            const now = performance.now();
            if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
              lastTouchRef.current = 0;
              event.stopPropagation();
              event.nativeEvent.preventDefault();
              onFocus(planet.id);
            } else {
              lastTouchRef.current = now;
            }
          }}
          onPointerOver={(event) => {
            event.stopPropagation();
            onHover(planet.id);
          }}
          onPointerOut={(event) => {
            event.stopPropagation();
            onBlur(planet.id);
          }}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(planet.id);
          }}
          frustumCulled
        />
        {planet.moons.map(moon => (
          <MoonOrbitGroup
            key={moon.id}
            moon={moon}
            orbitMaterial={orbitMaterial}
            moonGeometry={moonGeometry}
            moonMaterial={moonMaterials[moon.type]}
            orbitThickness={orbitThickness}
            onFocus={onFocus}
            onHover={onHover}
            onBlur={onBlur}
            onSelect={onSelect}
          />
        ))}
      </group>
    </group>
  );
};

type BodyLabelEvaluation = {
  visible: boolean;
  scale: number;
  opacity: number;
};

type LabelComputationScratch = {
  worldPosition: Vector3;
  projectedPosition: Vector3;
  parentWorldPosition: Vector3;
  parentProjectedPosition: Vector3;
};

const createBodyLabelState = (
  target: BodyLabelTarget,
  camera: Camera,
  baseScale: number,
  labelOffset: number,
  scratch: LabelComputationScratch
): BodyLabelEvaluation => {
  const { worldPosition, projectedPosition, parentWorldPosition, parentProjectedPosition } = scratch;
  worldPosition.set(...target.position);
  worldPosition.y += labelOffset;
  projectedPosition.copy(worldPosition).project(camera);

  const isOnScreen = projectedPosition.z > -1 && projectedPosition.z < 1
    && Math.abs(projectedPosition.x) <= 1.02
    && Math.abs(projectedPosition.y) <= 1.02;

  if (!isOnScreen) {
    return {
      visible: false,
      scale: 1,
      opacity: 0
    };
  }

  const distance = camera.position.distanceTo(worldPosition);
  const targetMinScale = baseScale * 0.32;
  const targetMaxScale = baseScale * (target.kind === 'planet' ? 1.6 : 1.25);
  const angularScale = MathUtils.clamp((target.radius * 8) / Math.max(distance, 0.001), targetMinScale, targetMaxScale);
  const fadeStart = Math.max(target.radius * (target.kind === 'planet' ? 28 : 22), baseScale * 5);
  const fadeEnd = fadeStart * 1.9;
  const distanceFade = MathUtils.clamp(1 - (distance - fadeStart) / (fadeEnd - fadeStart), 0, 1);
  const minOpacity = target.kind === 'planet' ? 0.35 : 0.18;
  const maxOpacity = target.kind === 'planet' ? 1 : 0.88;
  let opacity = MathUtils.lerp(minOpacity, maxOpacity, distanceFade);

  if (target.parent) {
    parentWorldPosition.set(...target.parent.position);
    parentWorldPosition.y += Math.max(target.parent.radius * 1.2, baseScale * 0.2);
    parentProjectedPosition.copy(parentWorldPosition).project(camera);
    const screenDistance = projectedPosition.distanceTo(parentProjectedPosition);
    const overlapThreshold = 0.18;
    const overlapFactor = MathUtils.clamp(screenDistance / overlapThreshold, 0, 1);
    opacity *= MathUtils.lerp(0.35, 1, overlapFactor);
  }

  return {
    visible: true,
    scale: angularScale,
    opacity
  };
};

const applyMaterialOpacity = (material: Material | Material[], opacity: number) => {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((mat) => {
    mat.opacity = opacity;
    mat.transparent = opacity < 1;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.toneMapped = false;
  });
};

interface BodyLabelProps {
  target: BodyLabelTarget;
  baseScale: number;
  color?: string;
}

const BodyLabel: React.FC<BodyLabelProps> = ({ target, baseScale, color = '#e2e8f0' }) => {
  const { camera } = useThree();
  const groupRef = useRef<Group | null>(null);
  const textRef = useRef<Mesh | null>(null);
  const scratch = useMemo<LabelComputationScratch>(() => ({
    worldPosition: new Vector3(),
    projectedPosition: new Vector3(),
    parentWorldPosition: new Vector3(),
    parentProjectedPosition: new Vector3()
  }), []);
  const labelOffset = useMemo(
    () => Math.max(target.radius * 1.25, baseScale * 0.22),
    [baseScale, target.radius]
  );
  const fontSize = useMemo(
    () => MathUtils.clamp(target.radius * 0.7, baseScale * 0.32, baseScale * 1.25),
    [baseScale, target.radius]
  );

  useFrame(() => {
    const group = groupRef.current;
    const text = textRef.current;
    if (!group || !text) return;

    const { visible, scale, opacity } = createBodyLabelState(target, camera, baseScale, labelOffset, scratch);
    group.visible = visible;
    if (!visible) return;

    group.scale.setScalar(scale);
    applyMaterialOpacity(text.material, opacity);
  });

  return (
    <group ref={groupRef} position={target.position}>
      <Billboard position={[0, labelOffset, 0]} frustumCulled={false}>
        <Text
          ref={textRef}
          fontSize={fontSize}
          color={color}
          outlineWidth={fontSize * 0.16}
          outlineColor="#0f172a"
          outlineOpacity={0.85}
          maxWidth={14}
          anchorX="center"
          anchorY="bottom"
        >
          {target.name}
        </Text>
      </Billboard>
    </group>
  );
};

interface SystemBodyLabelsProps {
  labels: BodyLabelTarget[];
  baseScale: number;
}

const SystemBodyLabels: React.FC<SystemBodyLabelsProps> = ({ labels, baseScale }) => {
  if (!labels.length) return null;
  return (
    <group name="SystemBodyLabels">
      {labels.map((label) => (
        <BodyLabel key={label.id} target={label} baseScale={baseScale} />
      ))}
    </group>
  );
};

interface SystemFleetMeshProps {
  fleet: Fleet;
  color: string;
  scale: number;
  geometry: ConeGeometry;
  ringGeometry: RingGeometry;
  isSelected: boolean;
  isHovered: boolean;
  showLabel: boolean;
  onHover: () => void;
  onBlur: () => void;
  onInteract: (
    event: ThreeEvent<MouseEvent | PointerEvent>,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => void;
}

const SystemFleetMesh: React.FC<SystemFleetMeshProps> = ({
  fleet,
  color,
  scale,
  geometry,
  ringGeometry,
  isSelected,
  isHovered,
  showLabel,
  onHover,
  onBlur,
  onInteract
}) => {
  const getFleetName = useFleetName();
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const chevronRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const resolvePointerType = (event: any) => event?.pointerType || event?.nativeEvent?.pointerType || '';
  const emissiveIntensity = isSelected ? 0.75 : isHovered ? 0.55 : 0.35;
  const emphasisScale = isSelected ? 1.1 : isHovered ? 1.04 : 1;
  const verticalEmphasis = isSelected ? scale * 0.2 : isHovered ? scale * 0.08 : 0;
  const baseScale: [number, number, number] = useMemo(() => [scale, scale, scale], [scale]);
  const labelText = showLabel ? `${getFleetName(fleet.id)} [${fleet.ships.length}]` : '';

  return (
    <group position={[0, verticalEmphasis, 0]} scale={[emphasisScale, emphasisScale, emphasisScale]}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onInteract(event, { isDouble: false, pointerType: resolvePointerType(event) });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
          onBlur();
        }}
      >
        <sphereGeometry args={[1.6, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        geometry={geometry}
        rotation={chevronRotation}
        scale={baseScale}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.4}
          metalness={0.6}
        />
      </mesh>
      {isSelected && (
        <mesh
          geometry={ringGeometry}
          rotation={chevronRotation}
          scale={[scale * 1.1, scale * 1.1, scale * 1.1]}
        >
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      )}
      {showLabel && (
        <Billboard position={[0, scale * 2.5, 0]}>
          <Text
            fontSize={scale * 1.1}
            color={color}
            outlineWidth={scale * 0.1}
            outlineColor="#000000"
            fontWeight="bold"
          >
            {labelText}
          </Text>
        </Billboard>
      )}
    </group>
  );
};

interface SystemFleetShipsProps {
  fleet: Fleet;
  scale: number;
  color: string;
  visible: boolean;
}

const SystemFleetShips: React.FC<SystemFleetShipsProps> = ({ fleet, scale, color, visible }) => {
  const meshRef = useRef<InstancedMesh>(null);
  const temp = useMemo(() => new Object3D(), []);
  const shipGeometry = useDisposableMemo(() => new ConeGeometry(0.35, 0.8, 6), []);
  const shipMaterial = useDisposableMemo(
    () => new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.5, metalness: 0.4 }),
    [color]
  );

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const total = fleet.ships.length;
    if (total === 0) return;
    const formationRadius = scale * 1.6;
    const shipScale = scale * 0.35;
    const yOffset = scale * 0.18;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < total; i += 1) {
      const t = (i + 0.5) / total;
      const radius = formationRadius * Math.sqrt(t);
      const angle = i * goldenAngle;
      temp.position.set(Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius);
      temp.rotation.set(-Math.PI / 2, 0, angle);
      temp.scale.set(shipScale, shipScale, shipScale);
      temp.updateMatrix();
      meshRef.current.setMatrixAt(i, temp.matrix);
    }
    meshRef.current.count = total;
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [fleet.ships.length, scale, temp]);

  if (!visible || fleet.ships.length === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[shipGeometry, shipMaterial, fleet.ships.length]} />
  );
};

interface SystemStationMeshProps {
  station: Station;
  color: string;
  scale: number;
  geometry: TorusGeometry;
  coreGeometry: CylinderGeometry;
  ringGeometry: RingGeometry;
  isSelected: boolean;
  isHovered: boolean;
  showLabel: boolean;
  onHover: () => void;
  onBlur: () => void;
  onInteract: (
    event: ThreeEvent<MouseEvent | PointerEvent>,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => void;
}

const SystemStationMesh: React.FC<SystemStationMeshProps> = ({
  station,
  color,
  scale,
  geometry,
  coreGeometry,
  ringGeometry,
  isSelected,
  isHovered,
  showLabel,
  onHover,
  onBlur,
  onInteract
}) => {
  const { t } = useI18n();
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const emissiveIntensity = isSelected ? 0.65 : isHovered ? 0.45 : 0.25;
  const labelText = station.name ?? t('systemView.stationInfo.unnamedStation', { code: shortId(station.id) });
  const resolvePointerType = (event: any) => event?.pointerType || event?.nativeEvent?.pointerType || '';

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onInteract(event, { isDouble: false, pointerType: resolvePointerType(event) });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
          onBlur();
        }}
      >
        <sphereGeometry args={[1.3, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        geometry={geometry}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[scale, scale, scale]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.5}
          metalness={0.5}
        />
      </mesh>
      <mesh
        geometry={coreGeometry}
        scale={[scale * 0.6, scale * 0.9, scale * 0.6]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.6}
          metalness={0.3}
        />
      </mesh>
      {isSelected && (
        <mesh
          geometry={ringGeometry}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[scale * 1.15, scale * 1.15, scale * 1.15]}
        >
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      )}
      {showLabel && (
        <Billboard position={[0, scale * 2.4, 0]}>
          <Text
            fontSize={scale * 1.05}
            color={color}
            outlineWidth={scale * 0.1}
            outlineColor="#000000"
            fontWeight="bold"
          >
            {labelText}
          </Text>
        </Billboard>
      )}
    </group>
  );
};

interface SystemEntitiesLayerProps {
  starBodyId: string;
  fleets: Fleet[];
  stations: Station[];
  day: number;
  starRadius: number;
  bodyWorldPositions: Record<string, [number, number, number]>;
  bodyRadii: Record<string, number>;
  clampedScale: number;
  selectedFleetId: string | null;
  selectedObjectId: SystemObjectId | null;
  hoveredObjectId: SystemObjectId | null;
  fleetIconScale: number;
  fleetLayoutConfig: TacticalRingConfig;
  getFactionColor: (id: string) => string;
  onHoverObject: (objectId: SystemObjectId) => void;
  onBlurObject: (objectId: SystemObjectId) => void;
  onSelectObject: (objectId: SystemObjectId) => void;
  onFocusPoint: (position: [number, number, number], radius: number) => void;
}

const SystemEntitiesLayer: React.FC<SystemEntitiesLayerProps> = ({
  starBodyId,
  fleets,
  stations,
  day,
  starRadius,
  bodyWorldPositions,
  bodyRadii,
  clampedScale,
  selectedFleetId,
  selectedObjectId,
  hoveredObjectId,
  fleetIconScale,
  fleetLayoutConfig,
  getFactionColor,
  onHoverObject,
  onBlurObject,
  onSelectObject,
  onFocusPoint
}) => {
  const fleetGeometry = useDisposableMemo(() => new ConeGeometry(0.5, 1.2, 6), []);
  const stationGeometry = useDisposableMemo(() => new TorusGeometry(0.6, 0.18, 10, 24), []);
  const stationCoreGeometry = useDisposableMemo(() => new CylinderGeometry(0.35, 0.35, 0.8, 10), []);
  const selectionRingGeometry = useDisposableMemo(() => new RingGeometry(0.9, 1.15, 32), []);

  const fleetLayouts = useMemo(() => layoutTacticalRing(fleets, {
    ...fleetLayoutConfig
  }, day), [day, fleetLayoutConfig, fleets]);

  const stationLayouts = useMemo(() => {
    const orderedStations = sorted(stations, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    const slotCapacity = 8;
    const stationScale = 0.55 * clampedScale;
    const stationSpacing = Math.max(stationScale * 2.6, clampedScale * 0.9);
    const stationYOffset = stationScale * 0.3;

    return orderedStations.map((station, index) => {
      const anchorId = station.anchorBodyId ?? starBodyId;
      const anchorPosition = bodyWorldPositions[anchorId] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
      const anchorRadius = bodyRadii[anchorId] ?? starRadius;
      const baseRadius = Math.max(anchorRadius * 2.6, stationScale * 2.4);
      const slotIndex = typeof station.slotIndex === 'number' ? station.slotIndex : index;
      const ringIndex = typeof station.slotIndex === 'number'
        ? Math.floor(slotIndex / slotCapacity)
        : 0;
      const angle = typeof station.slotIndex === 'number'
        ? ((slotIndex % slotCapacity) / slotCapacity) * Math.PI * 2
        : hashStringToAngle(station.id);
      const radius = baseRadius + ringIndex * stationSpacing;
      const position: [number, number, number] = [
        anchorPosition[0] + Math.cos(angle) * radius,
        anchorPosition[1] + stationYOffset,
        anchorPosition[2] + Math.sin(angle) * radius
      ];
      return {
        station,
        position,
        scale: stationScale
      };
    });
  }, [bodyRadii, bodyWorldPositions, clampedScale, starBodyId, starRadius, stations]);

  return (
    <group name="SystemEntitiesLayer">
      {fleetLayouts.map(({ entity: fleet, position, angle }) => {
        const objectId = makeObjectId('fleet', fleet.id);
        const isHovered = hoveredObjectId === objectId;
        const isSelected = selectedFleetId === fleet.id || selectedObjectId === objectId;
        const showLabel = isHovered || isSelected;
        const color = getFactionColor(fleet.factionId);
        const shouldShowShips = isSelected;

        return (
          <group key={fleet.id} position={position} rotation={[0, angle, 0]}>
            <SystemFleetMesh
              fleet={fleet}
              color={color}
              scale={fleetIconScale}
              geometry={fleetGeometry}
              ringGeometry={selectionRingGeometry}
              isSelected={isSelected}
              isHovered={isHovered}
              showLabel={showLabel}
              onHover={() => onHoverObject(objectId)}
              onBlur={() => onBlurObject(objectId)}
              onInteract={(_, options) => {
                onSelectObject(objectId);
                if (options?.isDouble) {
                  onFocusPoint(position, fleetIconScale * 6);
                }
              }}
            />
            <SystemFleetShips
              fleet={fleet}
              scale={fleetIconScale}
              color={color}
              visible={shouldShowShips}
            />
          </group>
        );
      })}
      {stationLayouts.map(({ station, position, scale }) => {
        const objectId = makeObjectId('station', station.id);
        const isHovered = hoveredObjectId === objectId;
        const isSelected = selectedObjectId === objectId;
        const showLabel = isHovered || isSelected;
        const color = getFactionColor(station.factionId);

        return (
          <group key={station.id} position={position}>
            <SystemStationMesh
              station={station}
              color={color}
              scale={scale}
              geometry={stationGeometry}
              coreGeometry={stationCoreGeometry}
              ringGeometry={selectionRingGeometry}
              isSelected={isSelected}
              isHovered={isHovered}
              showLabel={showLabel}
              onHover={() => onHoverObject(objectId)}
              onBlur={() => onBlurObject(objectId)}
              onInteract={(_, options) => {
                onSelectObject(objectId);
                if (options?.isDouble) {
                  onFocusPoint(position, scale * 6);
                }
              }}
            />
          </group>
        );
      })}
    </group>
  );
};

export type SystemCameraState = {
  theta: number;
  phi: number;
  radius: number;
  anchoredBodyId?: string;
  position?: [number, number, number];
  target?: [number, number, number];
};

type FocusRequest = {
  target: Vector3;
  distance: number;
};

const SystemCamera: React.FC<{
  maxDistance: number;
  minDistance: number;
  focusRequest: React.MutableRefObject<FocusRequest | null>;
  initialSpherical: CameraSphericalState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  lastCameraStateRef: React.MutableRefObject<SystemCameraState>;
  anchoredTarget: [number, number, number];
  anchoredBodyId?: string;
  rotateSpeed: number;
  zoomSpeed: number;
  cameraNear: number;
  cameraFar: number;
}> = ({
  maxDistance,
  minDistance,
  focusRequest,
  initialSpherical,
  onCameraStateChange,
  lastCameraStateRef,
  anchoredTarget,
  anchoredBodyId,
  rotateSpeed,
  zoomSpeed,
  cameraNear,
  cameraFar
}) => {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();
  const initialPosition = useMemo<[number, number, number]>(() => positionFromSpherical(initialSpherical, anchoredTarget), [
    anchoredTarget,
    initialSpherical.phi,
    initialSpherical.radius,
    initialSpherical.theta
  ]);
  const targetRef = useRef<Vector3>(new Vector3(...anchoredTarget));
  const desiredTargetRef = useRef<Vector3>(targetRef.current.clone());
  const initialDistance = useMemo(() => {
    const distance = Math.max(initialSpherical.radius, minDistance);
    const fallbackDistance = maxDistance * 0.6;
    return Math.max(distance || fallbackDistance, minDistance);
  }, [initialSpherical.radius, maxDistance, minDistance]);
  const desiredDistanceRef = useRef<number>(initialDistance);
  const isUserInteractingRef = useRef(false);
  const workingVector = useMemo(() => new Vector3(), []);
  const hasInitializedRef = useRef(false);
  const syncDesiredDistanceFromControls = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const distance = controls.object.position.distanceTo(controls.target);
    desiredDistanceRef.current = MathUtils.clamp(distance, minDistance, maxDistance);
  }, [maxDistance, minDistance]);

  useEffect(() => {
    camera.near = cameraNear;
    camera.far = cameraFar;
    camera.updateProjectionMatrix();
  }, [camera, cameraFar, cameraNear]);

  useLayoutEffect(() => {
    if (hasInitializedRef.current) return;
    camera.position.set(...initialPosition);
    targetRef.current.set(...anchoredTarget);
    desiredTargetRef.current.copy(targetRef.current);
    desiredDistanceRef.current = MathUtils.clamp(initialDistance, minDistance, maxDistance);
    controlsRef.current?.target.copy(targetRef.current);
    controlsRef.current?.update();
    lastCameraStateRef.current = {
      ...sphericalFromOffset(workingVector.copy(camera.position).sub(targetRef.current)),
      anchoredBodyId
    };
    hasInitializedRef.current = true;
  }, [
    anchoredBodyId,
    anchoredTarget,
    camera,
    initialDistance,
    initialPosition,
    lastCameraStateRef,
    maxDistance,
    minDistance,
    workingVector
  ]);

  useEffect(() => {
    return () => {
      if (onCameraStateChange) {
        onCameraStateChange(lastCameraStateRef.current);
      }
    };
  }, [lastCameraStateRef, onCameraStateChange]);

  useEffect(() => {
    desiredTargetRef.current.set(...anchoredTarget);
  }, [anchoredTarget]);

  useEffect(() => {
    desiredDistanceRef.current = MathUtils.clamp(desiredDistanceRef.current, minDistance, maxDistance);
  }, [maxDistance, minDistance]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const pendingFocus = focusRequest.current;
    if (pendingFocus) {
      desiredTargetRef.current.copy(pendingFocus.target);
      desiredDistanceRef.current = MathUtils.clamp(pendingFocus.distance, minDistance, maxDistance);
      focusRequest.current = null;
    }

    const lerpAlpha = 1 - Math.exp(-6 * delta);
    targetRef.current.lerp(desiredTargetRef.current, lerpAlpha);

    const currentDirection = workingVector.copy(camera.position).sub(targetRef.current);
    const currentDistance = currentDirection.length();
    const nextDistance = MathUtils.damp(currentDistance, desiredDistanceRef.current, 8, delta);
    const clampedDistance = MathUtils.clamp(nextDistance, minDistance, maxDistance);

    const nextPosition = currentDirection.setLength(clampedDistance).add(targetRef.current);
    camera.position.copy(nextPosition);
    controls.target.copy(targetRef.current);
    controls.update();

    lastCameraStateRef.current = {
      ...sphericalFromOffset(workingVector.copy(camera.position).sub(targetRef.current)),
      anchoredBodyId
    };
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.2}
      enablePan={false}
      minDistance={minDistance}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      maxDistance={maxDistance}
      rotateSpeed={rotateSpeed}
      zoomSpeed={zoomSpeed}
      onStart={() => {
        isUserInteractingRef.current = true;
      }}
      onEnd={() => {
        isUserInteractingRef.current = false;
        syncDesiredDistanceFromControls();
      }}
      onChange={() => {
        if (isUserInteractingRef.current) {
          syncDesiredDistanceFromControls();
        }
      }}
    />
  );
};

const SystemView3D: React.FC<SystemView3DProps> = ({
  starSystem,
  astro,
  fleets = [],
  stations = [],
  factions = [],
  day = 0,
  selectedFleetId = null,
  onSelectFleet,
  onInspectFleet,
  initialCameraState,
  onCameraStateChange,
  scaleFactor = 1,
  showBodyLabels = true,
  onOpenSurfaceView
}) => {
  const { t } = useI18n();
  const getFleetName = useFleetName();
  const clampedScale = Math.max(scaleFactor, 0.1);
  const sceneScale = KM_TO_SCENE_SCALE * clampedScale;
  const orbitThickness = ORBIT_THICKNESS * clampedScale;
  const minPlanetRadius = MIN_PLANET_RADIUS * clampedScale;
  const minMoonRadius = minPlanetRadius / 3;
  const minStarRadius = MIN_STAR_RADIUS * clampedScale;
  // Visual padding to keep planets and the star clearly separated; tune to adjust orbit spacing.
  const planetOrbitClearance = Math.max(minPlanetRadius * 2, clampedScale * 0.75);
  const moonOrbitClearance = Math.max(minMoonRadius * 2, clampedScale * 0.35);
  const focusDistanceFloor = 2.5 * clampedScale;
  const baseCameraDistance = 12 * clampedScale;
  const defaultCameraPosition = useMemo<[number, number, number]>(
    () => [0, 6 * clampedScale, 12 * clampedScale],
    [clampedScale]
  );
  const starRadiusKm = (astro?.stars?.[0]?.radiusSun ?? 1) * SOLAR_RADIUS_KM;
  const starRadius = Math.max(starRadiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minStarRadius);
  const planetBodies = useMemo(
    () => starSystem.planets.filter(body => body.bodyType === 'planet'),
    [starSystem.planets]
  );
  const moonBodiesByPlanetIndex = useMemo(() => {
    const buckets: PlanetBody[][] = [];
    let planetIndex = -1;
    starSystem.planets.forEach((body) => {
      if (body.bodyType === 'planet') {
        planetIndex += 1;
        return;
      }
      if (body.bodyType === 'moon' && planetIndex >= 0) {
        buckets[planetIndex] = buckets[planetIndex] ?? [];
        buckets[planetIndex].push(body);
      }
    });
    return buckets.map(bucket => sorted(bucket, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' })));
  }, [starSystem.planets]);
  const sourcePlanets = useMemo<PlanetSource[]>(() => {
    if (astro?.planets?.length) {
      return astro.planets.map((planet, index) => {
        const linkedBody = planetBodies[index];
        const fallbackPlanetId = `planet-${starSystem.id}-${index + 1}`;
        const planetId = linkedBody?.id ?? (planet as { id?: string }).id ?? fallbackPlanetId;
        const moonBodies = moonBodiesByPlanetIndex[index] ?? [];
        const moons: MoonSource[] = (planet.moons ?? []).map((moon, moonIndex) => ({
          ...moon,
          id: moonBodies[moonIndex]?.id ?? `moon-${starSystem.id}-${index + 1}-${moonIndex + 1}`,
          isSolid: moonBodies[moonIndex]?.isSolid ?? true
        }));
        return {
          ...planet,
          id: planetId,
          name: linkedBody?.name,
          planetType: planet.type,
          habitabilityScore: (planet as { habitabilityScore?: number }).habitabilityScore,
          isSolid: linkedBody?.isSolid ?? true,
          moons
        };
      });
    }

    if (planetBodies.length) {
      return planetBodies.map((planetBody) => ({
        id: planetBody.id,
        class: planetBody.class,
        size: planetBody.size,
        name: planetBody.name,
        planetType: getPlanetType(planetBody as PlanetSource),
        habitabilityScore: (planetBody as { habitabilityScore?: number }).habitabilityScore,
        isSolid: planetBody.isSolid,
        moons: []
      }));
    }

    return Array.from({ length: 3 }, (_, idx) => ({
      id: `placeholder-${idx + 1}`,
      planetType: 'Terrestrial' as PlanetType,
      moons: []
    }));
  }, [astro?.planets, moonBodiesByPlanetIndex, planetBodies, starSystem.id]);

  const planets = useMemo<OrbitingPlanet[]>(() => {
    const rawPlanets = sourcePlanets.map((planet, index) => buildPlanetModel(
      planet,
      index,
      sourcePlanets.length,
      sceneScale,
      minPlanetRadius,
      minMoonRadius
    ));
    const planetsWithSpacedMoons = rawPlanets.map(planet => ({
      ...planet,
      moons: applyMoonOrbitSpacing(planet.moons, planet.radius, moonOrbitClearance)
    }));
    return applyPlanetOrbitSpacing(planetsWithSpacedMoons, starRadius, planetOrbitClearance);
  }, [
    minMoonRadius,
    minPlanetRadius,
    moonOrbitClearance,
    planetOrbitClearance,
    sceneScale,
    sourcePlanets,
    starRadius
  ]);

  const orbitMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({ color: '#334155', transparent: true, opacity: 0.8 }),
    []
  );

  const planetMaterialMap = useMemo<Record<PlanetType, MeshStandardMaterial>>(() => {
    const materials = Object.entries(PLANET_TYPE_COLORS).reduce((acc, [type, color]) => {
      acc[type as PlanetType] = new MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0.2
      });
      return acc;
    }, {} as Record<PlanetType, MeshStandardMaterial>);
    return materials;
  }, []);

  const moonMaterialMap = useMemo<Record<MoonType, MeshStandardMaterial>>(() => {
    const materials = Object.entries(MOON_TYPE_COLORS).reduce((acc, [type, color]) => {
      acc[type as MoonType] = new MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: 0.15
      });
      return acc;
    }, {} as Record<MoonType, MeshStandardMaterial>);
    return materials;
  }, []);

  useEffect(() => {
    return () => {
      Object.values(planetMaterialMap).forEach(material => material.dispose());
      Object.values(moonMaterialMap).forEach(material => material.dispose());
    };
  }, [moonMaterialMap, planetMaterialMap]);

  const starGeometry = useDisposableMemo(() => new SphereGeometry(1, 64, 64), []);
  const planetGeometry = useDisposableMemo(() => new SphereGeometry(1, 48, 48), []);
  const moonGeometry = useDisposableMemo(() => new SphereGeometry(1, 32, 32), []);

  const starBodyId = useMemo(() => `${starSystem.id}-star-primary`, [starSystem.id]);
  const primaryColor = starSystem.color || '#7dd3fc';
  const bodyWorldPositions = useMemo<Record<string, [number, number, number]>>(() => {
    const positions: Record<string, [number, number, number]> = {
      [starBodyId]: [0, 0, 0]
    };

    planets.forEach((planet) => {
      const planetPosition = computeOrbitPosition(planet.orbitRadius, planet.orbitAngle);
      positions[planet.id] = planetPosition;

      planet.moons.forEach((moon) => {
        const moonOffset = computeOrbitPosition(moon.orbitRadius, moon.orbitAngle);
        positions[moon.id] = [
          planetPosition[0] + moonOffset[0],
          planetPosition[1] + moonOffset[1],
          planetPosition[2] + moonOffset[2]
        ];
      });
    });

    return positions;
  }, [planets, starBodyId]);
  const bodyRadii = useMemo<Record<string, number>>(() => {
    const radii: Record<string, number> = {
      [starBodyId]: starRadius
    };

    planets.forEach((planet) => {
      radii[planet.id] = planet.radius;
      planet.moons.forEach((moon) => {
        radii[moon.id] = moon.radius;
      });
    });

    return radii;
  }, [planets, starBodyId, starRadius]);
  const resolvedAnchoredBodyId = useMemo(() => {
    if (initialCameraState?.anchoredBodyId && bodyWorldPositions[initialCameraState.anchoredBodyId]) {
      return initialCameraState.anchoredBodyId;
    }
    return starBodyId;
  }, [bodyWorldPositions, initialCameraState?.anchoredBodyId, starBodyId]);
  const [anchoredBodyId, setAnchoredBodyId] = useState<string | undefined>(resolvedAnchoredBodyId);
  const bodyInfoMap = useMemo<Record<string, SystemBodyInfo>>(() => {
    const map: Record<string, SystemBodyInfo> = {};
    map[starBodyId] = {
      id: starBodyId,
      name: t('systemView.bodyInfo.starName', { system: starSystem.name }),
      bodyType: 'star' as CelestialBodyType,
      bodySubType: astro?.primarySpectralType,
      radiusKm: starRadiusKm,
      isSolid: false
    };

    sourcePlanets.forEach((planet, index) => {
      const fallbackPlanetId = `planet-${starSystem.id}-${index + 1}`;
      const planetId = planet.id ?? fallbackPlanetId;
      const planetName = planet.name ?? t('systemView.bodyInfo.unnamedPlanet', { index: index + 1 });
      const planetType = getPlanetType(planet);
      const surfaceBodyId = planet.id ?? planetId;
      map[planetId] = {
        id: planetId,
        name: planetName,
        bodyType: 'planet',
        bodySubType: planetType,
        radiusKm: getPlanetRadiusKm(planet),
        atmosphere: (planet as PlanetData).atmosphere,
        habitabilityScore: (planet as { habitabilityScore?: number }).habitabilityScore,
        isSolid: (planet as { isSolid?: boolean }).isSolid ?? true,
        surfaceBodyId
      };

      const moons = (planet.moons ?? []) as MoonSource[];
      moons.forEach((moon, moonIndex) => {
        const moonId = moon.id ?? `moon-${starSystem.id}-${index + 1}-${moonIndex + 1}`;
        const moonName = t('systemView.bodyInfo.moonName', {
          parent: planetName,
          index: moonIndex + 1
        });
        map[moonId] = {
          id: moonId,
          name: moonName,
          bodyType: 'moon',
          bodySubType: getMoonType(moon),
          radiusKm: getMoonRadiusKm(moon),
          atmosphere: moon.atmosphere,
          habitabilityScore: (moon as { habitabilityScore?: number }).habitabilityScore,
          isSolid: moon.isSolid ?? true,
          surfaceBodyId: moon.id ?? moonId
        };
      });
    });

    return map;
  }, [astro?.primarySpectralType, sourcePlanets, starBodyId, starRadiusKm, starSystem.id, starSystem.name, t]);
  const systemFleets = useMemo(() => getSystemFleets(starSystem, fleets), [fleets, starSystem]);
  const systemStations = useMemo(
    () => stations.filter((station) => station.systemId === starSystem.id),
    [stations, starSystem.id]
  );
  const fleetById = useMemo(() => new Map(systemFleets.map((fleet) => [fleet.id, fleet])), [systemFleets]);
  const stationById = useMemo(() => new Map(systemStations.map((station) => [station.id, station])), [systemStations]);
  const factionById = useMemo(() => new Map(factions.map((faction) => [faction.id, faction])), [factions]);

  const [hoveredObjectId, setHoveredObjectId] = useState<SystemObjectId | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<SystemObjectId | null>(null);

  useEffect(() => {
    if (selectedFleetId && fleetById.has(selectedFleetId)) {
      setSelectedObjectId(makeObjectId('fleet', selectedFleetId));
    }
  }, [fleetById, selectedFleetId]);
  useEffect(() => {
    if (!selectedFleetId) {
      const parsed = parseObjectId(selectedObjectId);
      if (parsed?.kind === 'fleet') {
        setSelectedObjectId(null);
      }
    }
  }, [selectedFleetId, selectedObjectId]);

  const displayedObject = useMemo(
    () => parseObjectId(selectedObjectId ?? hoveredObjectId),
    [hoveredObjectId, selectedObjectId]
  );
  const displayedBody = displayedObject?.kind === 'body' ? bodyInfoMap[displayedObject.id] : undefined;
  const displayedFleet = displayedObject?.kind === 'fleet' ? fleetById.get(displayedObject.id) : undefined;
  const displayedStation = displayedObject?.kind === 'station' ? stationById.get(displayedObject.id) : undefined;
  const displayedFleetName = displayedFleet ? getFleetName(displayedFleet.id) : '';
  const displayedFleetFaction = displayedFleet ? factionById.get(displayedFleet.factionId) : undefined;
  const displayedStationFaction = displayedStation ? factionById.get(displayedStation.factionId) : undefined;
  const displayedFleetPower = displayedFleet ? calculateFleetPower(displayedFleet) : undefined;
  const displayedStationName = displayedStation
    ? (displayedStation.name ?? t('systemView.stationInfo.unnamedStation', { code: shortId(displayedStation.id) }))
    : '';
  const isSelectionActive = Boolean(selectedObjectId);

  const handleHoverBody = useCallback((bodyId: string) => {
    setHoveredObjectId(makeObjectId('body', bodyId));
  }, []);
  const handleBlurBody = useCallback((bodyId: string) => {
    const objectId = makeObjectId('body', bodyId);
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectBody = useCallback((bodyId: string) => {
    setSelectedObjectId(makeObjectId('body', bodyId));
    onSelectFleet?.(null);
  }, [onSelectFleet]);
  const handleHoverObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(objectId);
  }, []);
  const handleBlurObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectObject = useCallback((objectId: SystemObjectId) => {
    setSelectedObjectId(objectId);
    const parsed = parseObjectId(objectId);
    if (parsed?.kind === 'fleet') {
      onSelectFleet?.(parsed.id);
    } else {
      onSelectFleet?.(null);
    }
  }, [onSelectFleet]);
  const getFactionColor = useCallback(
    (id: string) => factionById.get(id)?.color ?? '#94a3b8',
    [factionById]
  );
  const clearSelection = useCallback(() => {
    setSelectedObjectId(null);
    onSelectFleet?.(null);
  }, [onSelectFleet]);
  useEffect(() => {
    setHoveredObjectId(null);
    setSelectedObjectId(null);
  }, [starSystem.id]);
  const fleetIconScale = 0.45 * clampedScale;
  const eclipticEpsilon = Math.max(fleetIconScale * 0.02, clampedScale * 0.01);
  const fleetRingSpacing = Math.max(fleetIconScale * 4, clampedScale * 1.1);
  const fleetSafetyMargin = Math.max(fleetIconScale * 2.6, clampedScale * 1.1);
  const fleetOrbitClearance = Math.max(fleetRingSpacing * 0.45, fleetIconScale * 2.2, clampedScale * 0.9);
  const fleetRingBase = useMemo(
    () => computeFleetRingBaseRadius({
      starRadius,
      focusDistanceFloor,
      planets,
      safetyMargin: fleetSafetyMargin,
      minimumOrbitClearance: fleetOrbitClearance
    }),
    [focusDistanceFloor, fleetOrbitClearance, fleetSafetyMargin, planets, starRadius]
  );
  const fleetLayoutConfig = useMemo<TacticalRingConfig>(() => ({
    baseRadius: fleetRingBase,
    ringSpacing: fleetRingSpacing,
    maxPerRing: 12,
    yOffset: eclipticEpsilon,
    rotationSpeed: 0.12
  }), [eclipticEpsilon, fleetRingBase, fleetRingSpacing]);
  const stationIconScale = 0.55 * clampedScale;
  const fleetLayoutsForFocus = useMemo(
    () => layoutTacticalRing(systemFleets, fleetLayoutConfig, day),
    [day, fleetLayoutConfig, systemFleets]
  );
  const fleetPositionById = useMemo(
    () => new Map(fleetLayoutsForFocus.map(layout => [layout.entity.id, layout.position])),
    [fleetLayoutsForFocus]
  );
  const stationPositionById = useMemo(() => {
    const orderedStations = sorted(systemStations, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    const slotCapacity = 8;
    const stationSpacing = Math.max(stationIconScale * 2.6, clampedScale * 0.9);
    const stationYOffset = stationIconScale * 0.3;

    return new Map(
      orderedStations.map((station, index) => {
        const anchorId = station.anchorBodyId ?? starBodyId;
        const anchorPosition = bodyWorldPositions[anchorId] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
        const anchorRadius = bodyRadii[anchorId] ?? starRadius;
        const baseRadius = Math.max(anchorRadius * 2.6, stationIconScale * 2.4);
        const slotIndex = typeof station.slotIndex === 'number' ? station.slotIndex : index;
        const ringIndex = typeof station.slotIndex === 'number'
          ? Math.floor(slotIndex / slotCapacity)
          : 0;
        const angle = typeof station.slotIndex === 'number'
          ? ((slotIndex % slotCapacity) / slotCapacity) * Math.PI * 2
          : hashStringToAngle(station.id);
        const radius = baseRadius + ringIndex * stationSpacing;
        const position: [number, number, number] = [
          anchorPosition[0] + Math.cos(angle) * radius,
          anchorPosition[1] + stationYOffset,
          anchorPosition[2] + Math.sin(angle) * radius
        ];
        return [station.id, position] as const;
      })
    );
  }, [bodyRadii, bodyWorldPositions, clampedScale, starBodyId, starRadius, stationIconScale, systemStations]);
  const maxOrbitRadius = useMemo(() => {
    return planets.reduce((max, planet) => {
      const planetExtent = planet.orbitRadius + planet.radius;
      const moonExtent = planet.moons.reduce(
        (moonMax, moon) => Math.max(moonMax, planet.orbitRadius + moon.orbitRadius + moon.radius),
        planetExtent
      );
      return Math.max(max, moonExtent);
    }, starRadius);
  }, [planets, starRadius]);
  const cameraMaxDistance = Math.max(maxOrbitRadius * 3.5, baseCameraDistance);
  const ambientLightIntensity = MathUtils.clamp(0.05 + clampedScale * 0.02, 0.04, 0.12);
  const starLightDistance = Math.max(maxOrbitRadius * 4, starRadius * 20);
  const starLightIntensity = MathUtils.clamp(1.8 + starRadius * 0.9, 1.6, 6);
  const ambientLightColor = useMemo(
    () => new Color(primaryColor).lerp(new Color('#0b1020'), 0.75).getStyle(),
    [primaryColor]
  );
  const starLightColor = useMemo(
    () => new Color(primaryColor).lerp(new Color('#ffffff'), 0.12).getStyle(),
    [primaryColor]
  );
  const cameraMinDistance = useMemo(() => {
    const anchoredRadius = bodyRadii[anchoredBodyId ?? ''];
    const effectiveRadius = typeof anchoredRadius === 'number' ? anchoredRadius : focusDistanceFloor;
    return Math.max(focusDistanceFloor, effectiveRadius * 2);
  }, [anchoredBodyId, bodyRadii, focusDistanceFloor]);
  const rotateSpeed = MathUtils.clamp(1 / clampedScale, 0.35, 2.5);
  const zoomSpeed = MathUtils.clamp(1 / clampedScale, 0.4, 3);
  const cameraNear = Math.max(cameraMaxDistance / 500, focusDistanceFloor * 0.1, 0.05);
  const cameraFar = cameraMaxDistance * 10;
  const focusRequestRef = useRef<FocusRequest | null>(null);
  const anchoredTarget = useMemo<[number, number, number]>(() => {
    return bodyWorldPositions[anchoredBodyId ?? ''] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
  }, [anchoredBodyId, bodyWorldPositions, starBodyId]);
  const cameraInitialSpherical = useMemo<CameraSphericalState>(() => (
    deriveSphericalState(initialCameraState, anchoredTarget, defaultCameraPosition)
  ), [anchoredTarget, defaultCameraPosition, initialCameraState]);
  const lastCameraStateRef = useRef<SystemCameraState>({
    ...cameraInitialSpherical,
    anchoredBodyId: anchoredBodyId ?? starBodyId
  });
  useEffect(() => {
    lastCameraStateRef.current = {
      ...cameraInitialSpherical,
      anchoredBodyId: anchoredBodyId ?? starBodyId
    };
  }, [anchoredBodyId, cameraInitialSpherical, starBodyId]);
  useEffect(() => {
    setAnchoredBodyId(resolvedAnchoredBodyId ?? starBodyId);
  }, [resolvedAnchoredBodyId, starBodyId]);
  const bodyLabels = useMemo<BodyLabelTarget[]>(() => {
    const labels: BodyLabelTarget[] = [];

    planets.forEach((planet) => {
      const planetPosition = bodyWorldPositions[planet.id];
      const planetRadius = bodyRadii[planet.id];
      if (planetPosition && planetRadius) {
        labels.push({
          id: planet.id,
          name: bodyInfoMap[planet.id]?.name ?? planet.id,
          position: planetPosition,
          radius: planetRadius,
          kind: 'planet'
        });
      }
      planet.moons.forEach((moon) => {
        const moonPosition = bodyWorldPositions[moon.id];
        const moonRadius = bodyRadii[moon.id];
        if (moonPosition && moonRadius && planetPosition && planetRadius) {
          labels.push({
            id: moon.id,
            name: bodyInfoMap[moon.id]?.name ?? moon.id,
            position: moonPosition,
            radius: moonRadius,
            kind: 'moon',
            parent: {
              position: planetPosition,
              radius: planetRadius
            }
          });
        }
      });
    });

    return labels;
  }, [bodyInfoMap, bodyRadii, bodyWorldPositions, planets]);
  const requestFocusOnPoint = useCallback((
    position: [number, number, number],
    radius: number,
    anchorId?: string
  ) => {
    const minDistanceForTarget = Math.max(focusDistanceFloor, radius * 2);
    const desiredDistance = Math.min(Math.max(radius * 8, minDistanceForTarget), cameraMaxDistance * 0.95);
    focusRequestRef.current = {
      target: new Vector3(...position),
      distance: desiredDistance
    };
    if (anchorId) {
      setAnchoredBodyId(anchorId);
    }
  }, [cameraMaxDistance, focusDistanceFloor]);
  const requestFocusOnBody = useCallback((bodyId: string) => {
    const position = bodyWorldPositions[bodyId];
    if (!position) return;
    const radius = bodyRadii[bodyId] ?? focusDistanceFloor;
    requestFocusOnPoint(position, radius, bodyId);
  }, [bodyRadii, bodyWorldPositions, focusDistanceFloor, requestFocusOnPoint]);
  const handleResetCamera = useCallback(() => {
    const anchorPosition = bodyWorldPositions[starBodyId] ?? [0, 0, 0];
    const resetDistance = Math.min(Math.max(baseCameraDistance, focusDistanceFloor * 3), cameraMaxDistance * 0.8);
    focusRequestRef.current = {
      target: new Vector3(...anchorPosition),
      distance: resetDistance
    };
    setAnchoredBodyId(starBodyId);
  }, [baseCameraDistance, bodyWorldPositions, cameraMaxDistance, focusDistanceFloor, starBodyId]);
  const handleCenterBody = useCallback((bodyId: string) => {
    requestFocusOnBody(bodyId);
  }, [requestFocusOnBody]);
  const handleCenterFleet = useCallback((fleetId: string) => {
    const position = fleetPositionById.get(fleetId);
    if (!position) return;
    requestFocusOnPoint(position, fleetIconScale * 6);
  }, [fleetIconScale, fleetPositionById, requestFocusOnPoint]);
  const handleCenterStation = useCallback((stationId: string) => {
    const position = stationPositionById.get(stationId);
    if (!position) return;
    requestFocusOnPoint(position, stationIconScale * 6);
  }, [requestFocusOnPoint, stationIconScale, stationPositionById]);
  const initialCameraPosition = useMemo<[number, number, number]>(() => (
    positionFromSpherical(cameraInitialSpherical, anchoredTarget)
  ), [
    anchoredTarget,
    cameraInitialSpherical.phi,
    cameraInitialSpherical.radius,
    cameraInitialSpherical.theta
  ]);

  return (
    <div className="relative w-full h-full bg-black">
      <Canvas camera={{ position: initialCameraPosition, fov: 55, near: cameraNear, far: cameraFar }}>
        <color attach="background" args={['#000000']} />
        <ambientLight intensity={ambientLightIntensity} color={ambientLightColor} />
        <pointLight
          position={[0, 0, 0]}
          intensity={starLightIntensity}
          distance={starLightDistance}
          decay={2}
          color={starLightColor}
        />

        <SystemCamera
          maxDistance={cameraMaxDistance}
          minDistance={cameraMinDistance}
          focusRequest={focusRequestRef}
          initialSpherical={cameraInitialSpherical}
          onCameraStateChange={onCameraStateChange}
          lastCameraStateRef={lastCameraStateRef}
          anchoredTarget={anchoredTarget}
          anchoredBodyId={anchoredBodyId}
          rotateSpeed={rotateSpeed}
          zoomSpeed={zoomSpeed}
          cameraNear={cameraNear}
          cameraFar={cameraFar}
        />

        <SystemRoot>
          <StarMesh
            radius={starRadius}
            color={primaryColor}
            geometry={starGeometry}
            seedKey={starSystem.id}
            onDoubleClick={(event) => {
              event.stopPropagation();
              requestFocusOnBody(starBodyId);
            }}
            onHover={() => handleHoverBody(starBodyId)}
            onBlur={() => handleBlurBody(starBodyId)}
            onSelect={() => handleSelectBody(starBodyId)}
          />
          {planets.map(planet => (
            <PlanetOrbitGroup
              key={planet.id}
              planet={planet}
              orbitMaterial={orbitMaterial}
              planetGeometry={planetGeometry}
              moonGeometry={moonGeometry}
              planetMaterial={planetMaterialMap[planet.type]}
              moonMaterials={moonMaterialMap}
              orbitThickness={orbitThickness}
              onFocus={requestFocusOnBody}
              onHover={handleHoverBody}
              onBlur={handleBlurBody}
              onSelect={handleSelectBody}
            />
          ))}
          <SystemEntitiesLayer
            starBodyId={starBodyId}
            fleets={systemFleets}
            stations={systemStations}
            day={day}
            starRadius={starRadius}
            bodyWorldPositions={bodyWorldPositions}
            bodyRadii={bodyRadii}
            clampedScale={clampedScale}
            selectedFleetId={selectedFleetId}
            selectedObjectId={selectedObjectId}
            hoveredObjectId={hoveredObjectId}
            fleetIconScale={fleetIconScale}
            fleetLayoutConfig={fleetLayoutConfig}
            getFactionColor={getFactionColor}
            onHoverObject={handleHoverObject}
            onBlurObject={handleBlurObject}
            onSelectObject={handleSelectObject}
            onFocusPoint={requestFocusOnPoint}
          />
          {showBodyLabels && (
            <SystemBodyLabels
              labels={bodyLabels}
              baseScale={clampedScale}
            />
          )}
        </SystemRoot>
      </Canvas>
      <div className="pointer-events-none absolute inset-0 flex items-start justify-start p-4">
        <div className="pointer-events-auto flex gap-2">
          <button
            type="button"
            onClick={handleResetCamera}
            className="rounded border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow transition hover:border-slate-500 hover:bg-slate-700"
          >
            {t('systemView.actions.resetCamera')}
          </button>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-end justify-end p-4">
        <div className="pointer-events-auto w-80 max-w-full">
          {displayedBody ? (
            <SystemBodyInfoPanel
              body={displayedBody}
              isSelected={isSelectionActive}
              onClearSelection={isSelectionActive ? clearSelection : undefined}
              onCenter={() => handleCenterBody(displayedBody.id)}
              onOpenSurfaceView={onOpenSurfaceView}
            />
          ) : displayedFleet ? (
            <SystemFleetInfoPanel
              fleet={displayedFleet}
              fleetName={displayedFleetName}
              factionName={displayedFleetFaction?.name ?? t('systemView.fleetInfo.unknownFaction')}
              factionColor={displayedFleetFaction?.color}
              power={displayedFleetPower}
              isSelected={isSelectionActive}
              onClearSelection={isSelectionActive ? clearSelection : undefined}
              onCenter={() => handleCenterFleet(displayedFleet.id)}
              onInspect={onInspectFleet ? () => onInspectFleet(displayedFleet.id) : undefined}
            />
          ) : displayedStation ? (
            <SystemStationInfoPanel
              station={displayedStation}
              stationName={displayedStationName}
              factionName={displayedStationFaction?.name ?? t('systemView.fleetInfo.unknownFaction')}
              factionColor={displayedStationFaction?.color}
              isSelected={isSelectionActive}
              onClearSelection={isSelectionActive ? clearSelection : undefined}
              onCenter={() => handleCenterStation(displayedStation.id)}
            />
          ) : (
            <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-lg">
              <div className="text-xs uppercase tracking-wide text-slate-400">{t('systemView.objectInfo.title')}</div>
              <div className="mt-2 text-slate-300">{t('systemView.objectInfo.hoverHint')}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SystemView3D;
