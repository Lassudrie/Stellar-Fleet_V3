
import React, { Suspense, useEffect, useMemo, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import {
  BufferGeometry,
  BufferAttribute,
  Color,
  FrontSide,
  LineBasicMaterial,
  MathUtils,
  MeshStandardMaterial,
  NormalBlending,
  Points,
  Group,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';
import { ArmyState, FleetState, sorted } from '../../shared/shared';
import type {
  AtmosphereType,
  GameState,
  StarSystem,
  PlanetBody,
  LaserShot,
  EnemySighting,
  PlanetSurfaceDescriptor,
  GroundBuilding,
  Station,
  FactionState,
  PlanetType,
  MoonType,
  StarData
} from '../../shared/shared';
import { SCENARIO_TEMPLATES } from '../../content/scenarios';
import Galaxy from './Galaxy';
import FleetMesh from './FleetRenderer';
import TerritoryBorders from './TerritoryBorders';
import GameCamera from './GameCamera';
import IntelGhosts from './IntelGhosts';
import { Vec3 } from '../../engine/math/vec3';
import { buildGeodesicGrid, getSurfaceTileDir, resolveSurfaceTileId, type GeodesicGrid } from '../../engine/planetSurface';
import {
  applyDayNightTerminator,
  applyMoonOrbitSpacing,
  applyPlanetOrbitSpacing,
  ATMOSPHERE_PRESETS,
  ATMOSPHERE_SHELL_DISTANCE_BOOST_MAX,
  ATMOSPHERE_SHELL_DISTANCE_FAR_FACTOR,
  ATMOSPHERE_SHELL_DISTANCE_NEAR_FACTOR,
  computeFleetRingBaseRadius,
  computeInclinedOrbitPosition,
  createAtmosphereShellMaterial,
  createCloudLayerMaterial,
  createFallbackStarOrbit,
  buildPlanetModel,
  computeOrbitAngle,
  deriveScatteringCoeffs,
  DAY_NIGHT_NIGHT_MIN,
  DAY_NIGHT_NIGHT_MIN_ATMOSPHERE,
  DAY_NIGHT_TERMINATOR_SOFTNESS,
  DAY_NIGHT_TERMINATOR_SOFTNESS_ATMOSPHERE,
  getMoonRadiusKm,
  getMoonType,
  getPlanetRadiusKm,
  getPlanetType,
  getSpectralTint,
  getStarLightIntensityForRadius,
  getSurfaceTintFromTemperature,
  KM_PER_AU,
  KM_TO_SCENE_SCALE,
  MIN_PLANET_RADIUS,
  MIN_STAR_RADIUS,
  MOON_TYPE_COLORS,
  MOON_SPIN_REFERENCE_RADIUS_FACTOR,
  OWNER_TINT_STRENGTH,
  PLANET_SPIN_REFERENCE_RADIUS_FACTOR,
  PLANET_TYPE_COLORS,
  RADIUS_VISIBILITY_BONUS,
  resolveAirMassIndex,
  resolveThermalTints,
  SOLAR_RADIUS_KM,
  STAR_SPIN_REFERENCE_RADIUS_FACTOR,
  SURFACE_AO_INTENSITY,
  SURFACE_DISPLACEMENT_BIAS,
  SURFACE_DISPLACEMENT_SCALE,
  SURFACE_NORMAL_SCALE,
  SystemBodyLabels,
  SystemCelestialLayer,
  SystemEntitiesLayer,
  SystemRimLight,
  SystemStarfield,
  SystemSurfaceTextureManager,
  SYSTEM_VIEW_FIXED_TERMINATOR,
  useDisposableMemo
} from './universe/system';
import type {
  AtmosphereLayerBundle,
  AtmosphereParams,
  OrbitingMoon,
  OrbitingPlanet,
  OrbitingStar,
  PlanetSource,
  MoonSource
} from './universe/system';
import {
  getSystemFleets,
  hashStringToUnit,
  makeObjectId,
  parseObjectId,
  type SystemObjectId,
  type TacticalRingConfig
} from './screens';

type ViewTier = 'galaxy' | 'system' | 'planet' | 'surface';
type ViewContext = {
  tier: ViewTier;
  focus: { systemId?: string | null; bodyId?: string | null };
  desiredZoom?: number | null;
};
type GridData = {
  grid: GeodesicGrid;
  polygons: Vec3[][];
};

interface GameSceneProps {
  gameState: GameState;
  enemySightings: Record<string, EnemySighting>;
  selectedFleetId: string | null;
  isInteractive?: boolean;
  focusTarget?: Vec3 | null;
  onReady?: () => void;
  onFleetSelect: (id: string | null) => void;
  onFleetInspect: (id: string) => void;
  onSystemClick: (sys: StarSystem, event: ThreeEvent<MouseEvent>) => void;
  onBackgroundClick: () => void;
  viewContext?: ViewContext;
  viewZoom?: number;
  onViewZoomChange?: (zoom: number) => void;
  onFocusSystem?: (systemId: string) => void;
  onFocusPlanet?: (bodyId: string) => void;
  onFocusSurface?: (bodyId: string) => void;
  onSurfaceTileSelect?: (selection: { bodyId: string; tileId: number; dir: Vec3 }) => void;
}

const resolveFactionColor = (factions: GameState['factions'], id: string) =>
  factions.find(faction => faction.id === id)?.color || '#999';

// ------------------------------------------------------------
// Map metrics (was: ui/components/hooks/useMapMetrics.ts)
// ------------------------------------------------------------

const DEFAULT_RADIUS = 120;
const DEFAULT_MARGIN = 40;

interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface MapMetrics {
  center: Vec3;
  radius: number;
  bounds: MapBounds;
}

const WORLD_ORIGIN_SHIFT_THRESHOLD = 5000;

function useMapMetrics(systems: StarSystem[], galaxyRadius?: number): MapMetrics {
  return useMemo(() => {
    const requestedRadius = Math.max(galaxyRadius ?? 0, 0);
    const fallbackRadius = Math.max(DEFAULT_RADIUS, requestedRadius);

    if (systems.length === 0) {
      const span = fallbackRadius * 2;
      const margin = Math.max(DEFAULT_MARGIN, span * 0.1);
      return {
        center: { x: 0, y: 0, z: 0 },
        radius: fallbackRadius,
        bounds: {
          minX: -fallbackRadius - margin,
          maxX: fallbackRadius + margin,
          minZ: -fallbackRadius - margin,
          maxZ: fallbackRadius + margin
        }
      };
    }

    let minX = systems[0].position.x;
    let maxX = systems[0].position.x;
    let minZ = systems[0].position.z;
    let maxZ = systems[0].position.z;

    systems.forEach(({ position }) => {
      minX = Math.min(minX, position.x);
      maxX = Math.max(maxX, position.x);
      minZ = Math.min(minZ, position.z);
      maxZ = Math.max(maxZ, position.z);
    });

    const center: Vec3 = {
      x: (minX + maxX) / 2,
      y: 0,
      z: (minZ + maxZ) / 2
    };

    const extentX = maxX - minX;
    const extentZ = maxZ - minZ;
    const boundingDiagonal = Math.sqrt(extentX * extentX + extentZ * extentZ);
    const radius = Math.max(boundingDiagonal / 2, DEFAULT_RADIUS, requestedRadius);

    let boundsMinX = minX;
    let boundsMaxX = maxX;
    let boundsMinZ = minZ;
    let boundsMaxZ = maxZ;

    if (requestedRadius > 0) {
      boundsMinX = Math.min(boundsMinX, -requestedRadius);
      boundsMaxX = Math.max(boundsMaxX, requestedRadius);
      boundsMinZ = Math.min(boundsMinZ, -requestedRadius);
      boundsMaxZ = Math.max(boundsMaxZ, requestedRadius);
    }

    const spanX = boundsMaxX - boundsMinX;
    const spanZ = boundsMaxZ - boundsMinZ;
    const margin = Math.max(DEFAULT_MARGIN, Math.max(spanX, spanZ) * 0.1);

    return {
      center,
      radius,
      bounds: {
        minX: boundsMinX - margin,
        maxX: boundsMaxX + margin,
        minZ: boundsMinZ - margin,
        maxZ: boundsMaxZ + margin
      }
    };
  }, [galaxyRadius, systems]);
}

const offsetVec3 = (value: Vec3, origin: Vec3): Vec3 => ({
  x: value.x - origin.x,
  y: value.y - origin.y,
  z: value.z - origin.z
});

const offsetBounds = (bounds: MapBounds, origin: Vec3): MapBounds => ({
  minX: bounds.minX - origin.x,
  maxX: bounds.maxX - origin.x,
  minZ: bounds.minZ - origin.z,
  maxZ: bounds.maxZ - origin.z
});

const useWorldOrigin = () => {
  const worldOriginRef = useRef<Vector3>(new Vector3());
  const [worldOrigin, setWorldOrigin] = useState<Vec3>({ x: 0, y: 0, z: 0 });

  const shiftWorldOrigin = useCallback((shift: Vector3) => {
    if (shift.lengthSq() === 0) return;
    worldOriginRef.current.add(shift);
    setWorldOrigin({
      x: worldOriginRef.current.x,
      y: worldOriginRef.current.y,
      z: worldOriginRef.current.z
    });
  }, []);

  return { worldOriginRef, worldOrigin, shiftWorldOrigin };
};

const SimpleLine: React.FC<{ start: Vec3; end: Vec3; color: string; dashed?: boolean }> = ({ start, end, color, dashed }) => {
  const lineRef = useRef<any>(null);
  
  const geometry = useMemo(() => {
    const geo = new BufferGeometry();
    const positions = new Float32Array(6); 
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    return geo;
  }, []);

  useLayoutEffect(() => {
    const posAttribute = geometry.attributes.position;
    const arr = posAttribute.array as Float32Array;
    arr[0] = start.x; arr[1] = start.y; arr[2] = start.z;
    arr[3] = end.x;   arr[4] = end.y;   arr[5] = end.z;
    posAttribute.needsUpdate = true;
    if (dashed && lineRef.current) {
        lineRef.current.computeLineDistances();
    }
  }, [dashed, end.x, end.y, end.z, geometry, start.x, start.y, start.z]); 

  return (
    <lineSegments ref={lineRef} geometry={geometry} frustumCulled={false}>
      {dashed ? (
          <lineDashedMaterial color={color} dashSize={1.5} gapSize={1.0} transparent opacity={0.6} />
      ) : (
          <lineBasicMaterial color={color} transparent opacity={0.6} />
      )}
    </lineSegments>
  );
};

const LaserRenderer: React.FC<{ lasers: LaserShot[] }> = React.memo(({ lasers }) => {
  return (
    <group>
      {lasers.map((laser) => (
        <SimpleLine
          key={laser.id}
          start={{ x: laser.start.x, y: 0, z: laser.start.z }}
          end={{ x: laser.end.x, y: 0, z: laser.end.z }}
          color={laser.color}
        />
      ))}
    </group>
  );
});

// TrajectoryRenderer - Now uses playerFactionId check for coloring
const TrajectoryRenderer: React.FC<{
  fleets: GameState['fleets'];
  factions: GameState['factions'];
  playerFactionId: string;
}> = React.memo(({ fleets, factions, playerFactionId }) => {
    return (
        <group>
            {fleets.map(fleet => {
                if (fleet.state === FleetState.MOVING && fleet.targetPosition) {
                    const isPlayer = fleet.factionId === playerFactionId;
                    const color = resolveFactionColor(factions, fleet.factionId);

                    return (
                        <SimpleLine
                            key={`traj-${fleet.id}`}
                            start={{ x: fleet.position.x, y: 0, z: fleet.position.z }}
                            end={{ x: fleet.targetPosition.x, y: 0, z: fleet.targetPosition.z }}
                            color={color}
                            dashed={!isPlayer}
                        />
                    );
                }
                return null;
            })}
        </group>
    );
});

const SceneReadyReporter: React.FC<{ onReady?: () => void }> = ({ onReady }) => {
  const firedRef = useRef(false);

  useFrame(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onReady?.();
  });

  return null;
};

const PARALLAX_STAR_RENDER_ORDER = -1000;

const ParallaxStars: React.FC = () => {
  const starsRef = useRef<Points>(null);

  useLayoutEffect(() => {
    const stars = starsRef.current;
    if (!stars) return;
    stars.renderOrder = PARALLAX_STAR_RENDER_ORDER;

    const materials = Array.isArray(stars.material) ? stars.material : [stars.material];
    materials.forEach((material) => {
      material.transparent = false;
      material.depthWrite = false;
    });
  }, []);

  return (
    <Stars radius={200} depth={50} count={3000} factor={4} saturation={0} fade speed={0.5} ref={starsRef} />
  );
};

const TIER_INDEX: Record<ViewTier, number> = {
  galaxy: 0,
  system: 1,
  planet: 2,
  surface: 3
};

const isTierAtLeast = (tier: ViewTier, target: ViewTier): boolean => TIER_INDEX[tier] >= TIER_INDEX[target];

const SYSTEM_LAYER_SCALE_FACTOR = 0.08;
const PLANET_LAYER_SCALE = 120;
const ZOOM_THRESHOLDS = {
  system: 0.28,
  planet: 0.62,
  surface: 0.86
};
const ZOOM_PRESETS: Record<ViewTier, number> = {
  galaxy: 0.12,
  system: 0.38,
  planet: 0.7,
  surface: 0.93
};
const CAMERA_FOV_DEG = 35;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smoothProgress = (value: number, start: number, end: number) => {
  if (start === end) return value >= end ? 1 : 0;
  const t = clamp01((value - start) / (end - start));
  return t * t * (3 - 2 * t);
};

type ZoomStop = { zoom: number; distance: number };

const resolveMaxDistance = (radius: number): number => {
  const safeRadius = Math.max(radius, DEFAULT_RADIUS, 1);
  const halfFovRad = (CAMERA_FOV_DEG * Math.PI) / 360;
  const fitDistance = safeRadius / Math.sin(halfFovRad);
  return Math.max(safeRadius * 2.5, DEFAULT_RADIUS * 2, fitDistance);
};

const resolveZoomStops = (radius: number): ZoomStop[] => {
  const maxDistance = resolveMaxDistance(radius);
  const systemDistance = Math.min(140, maxDistance * 0.7);
  const planetDistance = Math.min(60, systemDistance * 0.65);
  const surfaceDistance = Math.min(35, planetDistance * 0.65);
  const closeDistance = Math.max(1.2, Math.min(8, surfaceDistance * 0.6));
  return [
    { zoom: 0, distance: maxDistance },
    { zoom: ZOOM_THRESHOLDS.system, distance: systemDistance },
    { zoom: ZOOM_THRESHOLDS.planet, distance: planetDistance },
    { zoom: ZOOM_THRESHOLDS.surface, distance: surfaceDistance },
    { zoom: 1, distance: closeDistance }
  ];
};

const zoomToDistance = (stops: ZoomStop[], zoom: number): number => {
  const z = clamp01(zoom);
  for (let i = 0; i < stops.length - 1; i += 1) {
    const start = stops[i];
    const end = stops[i + 1];
    if (z <= end.zoom) {
      const span = end.zoom - start.zoom;
      const t = span <= 0 ? 0 : (z - start.zoom) / span;
      return MathUtils.lerp(start.distance, end.distance, t);
    }
  }
  return stops[stops.length - 1].distance;
};

const distanceToZoom = (stops: ZoomStop[], distance: number): number => {
  const maxDistance = stops[0].distance;
  const minDistance = stops[stops.length - 1].distance;
  const clamped = Math.max(minDistance, Math.min(maxDistance, distance));

  for (let i = 0; i < stops.length - 1; i += 1) {
    const start = stops[i];
    const end = stops[i + 1];
    if (clamped <= start.distance && clamped >= end.distance) {
      const span = start.distance - end.distance;
      const t = span <= 0 ? 0 : (start.distance - clamped) / span;
      return MathUtils.lerp(start.zoom, end.zoom, t);
    }
  }
  return stops[stops.length - 1].zoom;
};

const resolveZoomTier = (zoom: number, focus: ViewContext['focus']): ViewTier => {
  if (!focus.systemId) return 'galaxy';
  if (zoom >= ZOOM_THRESHOLDS.surface && focus.bodyId) return 'surface';
  if (zoom >= ZOOM_THRESHOLDS.planet && focus.bodyId) return 'planet';
  if (zoom >= ZOOM_THRESHOLDS.system) return 'system';
  return 'galaxy';
};

const resolvePlanetColor = (planet: PlanetBody): string => {
  if (planet.class === 'gas_giant') return '#f2b880';
  if (planet.class === 'ice_giant') return '#9cd6f0';
  if (!planet.isSolid) return '#c7a77e';
  return '#7bbd83';
};

const resolveSurfaceDetailScales = (params: {
  isMoon: boolean;
  bodyType: PlanetType | MoonType;
  hasAtmosphere: boolean;
}): { displacementScale: number; displacementBias: number; normalScale: number } => {
  let displacementFactor = 1;
  let normalFactor = 1;

  if (params.isMoon) {
    switch (params.bodyType as MoonType) {
      case 'Icy':
        displacementFactor = 0.85;
        normalFactor = 0.9;
        break;
      case 'Volcanic':
        displacementFactor = 1.2;
        normalFactor = 1.15;
        break;
      case 'Eden':
        displacementFactor = 0.95;
        normalFactor = 0.95;
        break;
      case 'Irregular':
        displacementFactor = 1.15;
        normalFactor = 1.1;
        break;
      default:
        displacementFactor = 1;
        normalFactor = 1;
        break;
    }
  } else {
    switch (params.bodyType as PlanetType) {
      case 'SubNeptune':
        displacementFactor = 0.7;
        normalFactor = 0.8;
        break;
      case 'IceGiant':
        displacementFactor = 0.55;
        normalFactor = 0.7;
        break;
      case 'GasGiant':
        displacementFactor = 0.25;
        normalFactor = 0.5;
        break;
      case 'Dwarf':
        displacementFactor = 1.1;
        normalFactor = 1.05;
        break;
      default:
        displacementFactor = 1;
        normalFactor = 1;
        break;
    }
  }

  if (params.hasAtmosphere) {
    displacementFactor *= 0.92;
    normalFactor *= 0.94;
  } else {
    displacementFactor *= 1.08;
    normalFactor *= 1.06;
  }

  return {
    displacementScale: SURFACE_DISPLACEMENT_SCALE * displacementFactor,
    displacementBias: SURFACE_DISPLACEMENT_BIAS * displacementFactor,
    normalScale: SURFACE_NORMAL_SCALE * normalFactor
  };
};

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});

const subtract = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});

const scaleVec = (v: Vec3, scale: number): Vec3 => ({
  x: v.x * scale,
  y: v.y * scale,
  z: v.z * scale
});

const normalizeVec = (v: Vec3): Vec3 => {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len <= 0) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};

const buildGridData = (frequency: number): GridData => {
  const grid = buildGeodesicGrid(frequency);
  const faceCenters = grid.faces.map(([a, b, c]) => {
    const vA = grid.vertices[a];
    const vB = grid.vertices[b];
    const vC = grid.vertices[c];
    const center = {
      x: (vA.x + vB.x + vC.x) / 3,
      y: (vA.y + vB.y + vC.y) / 3,
      z: (vA.z + vB.z + vC.z) / 3
    };
    return normalizeVec(center);
  });

  const polygons = grid.facesByVertex.map((faceIndices, vertexIndex) => {
    const normal = grid.vertices[vertexIndex];
    const reference = Math.abs(normal.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const tangent = normalizeVec(cross(reference, normal));
    const bitangent = cross(normal, tangent);

    const ordered = faceIndices.map(faceIndex => {
      const center = faceCenters[faceIndex];
      const projection = subtract(center, scaleVec(normal, dot(center, normal)));
      const angle = Math.atan2(dot(projection, bitangent), dot(projection, tangent));
      return { center, angle };
    });

    ordered.sort((a, b) => a.angle - b.angle);
    return ordered.map(entry => entry.center);
  });

  return { grid, polygons };
};

const findClosestTile = (grid: GeodesicGrid, dir: Vec3): number => {
  let bestIndex = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < grid.vertices.length; i += 1) {
    const v = grid.vertices[i];
    const d = v.x * dir.x + v.y * dir.y + v.z * dir.z;
    if (d > bestDot) {
      bestDot = d;
      bestIndex = i;
    }
  }
  return bestIndex;
};

const ignoreRaycast = () => {};

const AnimatedScaleGroup: React.FC<{
  targetScale: number;
  position: Vec3;
  visible?: boolean;
  children: React.ReactNode;
}> = ({ targetScale, position, visible = true, children }) => {
  const groupRef = useRef<Group>(null);
  const scaleRef = useRef(targetScale);

  useLayoutEffect(() => {
    scaleRef.current = targetScale;
    if (groupRef.current) {
      groupRef.current.scale.setScalar(targetScale);
    }
  }, [targetScale]);

  useFrame(() => {
    const nextScale = MathUtils.lerp(scaleRef.current, targetScale, 0.15);
    scaleRef.current = nextScale;
    if (groupRef.current) {
      groupRef.current.scale.setScalar(nextScale);
    }
  });

  return (
    <group
      ref={groupRef}
      position={[position.x, position.y, position.z]}
      visible={visible && targetScale > 0.001}
    >
      {children}
    </group>
  );
};

const SystemLayer: React.FC<{
  system: StarSystem;
  day: number;
  fleets: GameState['fleets'];
  stations: Station[];
  factions: FactionState[];
  planetSurfaceDescriptorsByBodyId?: Record<string, PlanetSurfaceDescriptor>;
  selectedFleetId: string | null;
  focusBodyId?: string | null;
  onPlanetClick?: (planetId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => void;
  onFleetSelect?: (fleetId: string) => void;
}> = ({
  system,
  day,
  fleets,
  stations,
  factions,
  planetSurfaceDescriptorsByBodyId,
  selectedFleetId,
  focusBodyId,
  onPlanetClick,
  onFleetSelect
}) => {
  const astro = system.astro ?? null;
  const prefersTouchFallback = useMemo(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true;
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  }, []);
  const clampedScale = 1;
  const sceneScale = KM_TO_SCENE_SCALE * clampedScale;
  const minPlanetRadius = MIN_PLANET_RADIUS * clampedScale;
  const minMoonRadius = minPlanetRadius / 3;
  const minStarRadius = MIN_STAR_RADIUS * clampedScale;
  const planetSpinReferenceRadius = minPlanetRadius * PLANET_SPIN_REFERENCE_RADIUS_FACTOR;
  const moonSpinReferenceRadius = minMoonRadius * MOON_SPIN_REFERENCE_RADIUS_FACTOR;
  const starSpinReferenceRadius = minStarRadius * STAR_SPIN_REFERENCE_RADIUS_FACTOR;
  const planetOrbitClearance = Math.max(minPlanetRadius * 2, clampedScale * 0.75);
  const moonOrbitClearance = Math.max(minMoonRadius * 2, clampedScale * 0.35);
  const focusDistanceFloor = 2.5 * clampedScale;

  const starModels = useMemo<OrbitingStar[]>(() => {
    const fallbackStar: StarData = {
      role: 'primary',
      spectralType: astro?.primarySpectralType ?? 'G',
      massSun: 1,
      radiusSun: 1,
      luminositySun: 1,
      teffK: 5800
    };
    const sourceStars = astro?.stars?.length ? astro.stars : [fallbackStar];
    const primaryMassSun = Math.max(sourceStars[0]?.massSun ?? 1, 0.1);

    return sourceStars.map((star, index) => {
      const isPrimary = index === 0;
      const starId = isPrimary
        ? `${system.id}-star-primary`
        : `${system.id}-star-companion-${index}`;
      const radiusKm = Math.max((star.radiusSun ?? 1) * SOLAR_RADIUS_KM, 1);
      const radius = Math.max(radiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minStarRadius);
      const spectralType = star.spectralType ?? astro?.primarySpectralType;
      const tintColor = getSpectralTint(spectralType, system.color || '#ffffff');
      const surfaceTintColor = getSurfaceTintFromTemperature(star.teffK, tintColor);
      const seedKey = `${system.id}-star-${index + 1}`;
      let position: [number, number, number] = [0, 0, 0];
      if (!isPrimary) {
        const orbit = star.orbit ?? createFallbackStarOrbit(seedKey, index, primaryMassSun);
        const orbitAngle = computeOrbitAngle(MathUtils.degToRad(orbit.phaseDeg), orbit.periodDays, day);
        const orbitRadius = orbit.semiMajorAxisAu * KM_PER_AU * sceneScale;
        position = computeInclinedOrbitPosition(orbitRadius, orbitAngle, orbit.inclinationDeg, orbit.ascendingNodeDeg);
      }

      return {
        id: starId,
        data: star,
        radius,
        radiusKm,
        tintColor,
        surfaceTintColor,
        seedKey,
        position
      };
    });
  }, [astro?.primarySpectralType, astro?.stars, day, minStarRadius, sceneScale, system.color, system.id]);

  const primaryStar = starModels[0];
  const starBodyId = primaryStar?.id ?? `${system.id}-star-primary`;
  const starRadius = primaryStar?.radius ?? minStarRadius;
  const starTintColor = primaryStar?.tintColor ?? getSpectralTint(astro?.primarySpectralType, system.color || '#ffffff');
  const sunPosition = useMemo(
    () => new Vector3(...(primaryStar?.position ?? [0, 0, 0])),
    [primaryStar?.position]
  );
  const orbitMassSun = Math.max(primaryStar?.data.massSun ?? 1, 0.1);
  const astroKey = useMemo(() => {
    if (!astro) return 'no-astro';
    return `${astro.seed}|${astro.starCount}|${astro.planets.length}`;
  }, [astro]);

  const planetBodies = useMemo(
    () => system.planets.filter(body => body.bodyType === 'planet'),
    [system.planets]
  );
  const moonBodiesByPlanetIndex = useMemo(() => {
    const buckets: PlanetBody[][] = [];
    let planetIndex = -1;
    system.planets.forEach((body) => {
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
  }, [system.planets]);
  const sourcePlanets = useMemo<PlanetSource[]>(() => {
    if (astro?.planets?.length) {
      return astro.planets.map((planet, index) => {
        const linkedBody = planetBodies[index];
        const fallbackPlanetId = `planet-${system.id}-${index + 1}`;
        const planetId = linkedBody?.id ?? (planet as { id?: string }).id ?? fallbackPlanetId;
        const moonBodies = moonBodiesByPlanetIndex[index] ?? [];
        const moons: MoonSource[] = (planet.moons ?? []).map((moon, moonIndex) => ({
          ...moon,
          id: moonBodies[moonIndex]?.id ?? `moon-${system.id}-${index + 1}-${moonIndex + 1}`,
          name: (moon as MoonSource).name ?? moonBodies[moonIndex]?.name,
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
  }, [astro?.planets, moonBodiesByPlanetIndex, planetBodies, system.id]);

  const planets = useMemo<OrbitingPlanet[]>(() => {
    const rawPlanets = sourcePlanets.map((planet, index) => buildPlanetModel(
      planet,
      index,
      sourcePlanets.length,
      sceneScale,
      orbitMassSun,
      day
    ));
    const planetsWithSpacedMoons = rawPlanets.map(planet => ({
      ...planet,
      moons: applyMoonOrbitSpacing(planet.moons, planet.radius, moonOrbitClearance)
    }));
    return applyPlanetOrbitSpacing(planetsWithSpacedMoons, starRadius, planetOrbitClearance);
  }, [
    day,
    moonOrbitClearance,
    orbitMassSun,
    planetOrbitClearance,
    sceneScale,
    sourcePlanets,
    starRadius
  ]);

  const orbitMaterial = useDisposableMemo(
    () => new LineBasicMaterial({
      color: '#e2e8f0',
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
      toneMapped: false
    }),
    []
  );

  const planetMaterialMap = useMemo<Record<PlanetType, MeshStandardMaterial>>(() => {
    const materials = Object.entries(PLANET_TYPE_COLORS).reduce((acc, [type, color]) => {
      acc[type as PlanetType] = new MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0,
        dithering: true
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
        metalness: 0,
        dithering: true
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

  type AtmosphereBundleCacheEntry = AtmosphereLayerBundle & { key: string };
  const sunColorRef = useRef<Color>(new Color('#ffffff'));
  const starLightColor = useMemo(
    () => new Color('#ffffff').lerp(new Color(starTintColor), 0.2).getStyle(),
    [starTintColor]
  );
  useEffect(() => {
    sunColorRef.current.set(starLightColor);
  }, [starLightColor]);
  const atmosphereBundleByBodyIdRef = useRef<Map<string, AtmosphereBundleCacheEntry>>(new Map());
  const disposeAtmosphereBundle = useCallback((bundle: AtmosphereLayerBundle) => {
    bundle.shell.material.dispose();
    bundle.haze?.material.dispose();
    bundle.clouds?.material.dispose();
  }, []);
  const clearAtmosphereCache = useCallback(() => {
    atmosphereBundleByBodyIdRef.current.forEach(entry => disposeAtmosphereBundle(entry));
    atmosphereBundleByBodyIdRef.current.clear();
  }, [disposeAtmosphereBundle]);
  useEffect(() => () => clearAtmosphereCache(), [clearAtmosphereCache]);
  useEffect(() => {
    clearAtmosphereCache();
  }, [astroKey, clearAtmosphereCache]);

  const resolveAtmosphereParams = useCallback((
    body: OrbitingPlanet | OrbitingMoon,
    atmosphere: Exclude<AtmosphereType, 'None'>,
    isGasBody: boolean
  ) => {
    const preset = ATMOSPHERE_PRESETS[atmosphere];
    const airMass = resolveAirMassIndex(body.airMassIndex, body.pressureBar, atmosphere);
    const temperatureK = typeof body.temperatureK === 'number' && Number.isFinite(body.temperatureK)
      ? body.temperatureK
      : (atmosphere === 'H2He' ? 140 : 288);
    const gravityG = typeof body.gravityG === 'number' && Number.isFinite(body.gravityG)
      ? body.gravityG
      : (isGasBody ? 2.2 : 1);
    const pressureAtm = typeof body.pressureBar === 'number' && Number.isFinite(body.pressureBar)
      ? body.pressureBar
      : preset.pressureAtm;
    const tempFactor = MathUtils.clamp(temperatureK / 288, 0.45, 2.2);
    const gravityFactor = MathUtils.clamp(1 / Math.max(gravityG, 0.35), 0.4, 2.2);
    const scaleHeightKm = preset.scaleHeightKm * MathUtils.clamp(tempFactor * gravityFactor, 0.5, 2.4);
    const aerosols = MathUtils.clamp(preset.aerosols * MathUtils.lerp(0.7, 1.25, airMass), 0, 1);
    let cloudiness = MathUtils.clamp(preset.clouds * MathUtils.lerp(0.55, 1.2, airMass), 0, 1);
    let storminess = MathUtils.clamp(preset.storminess * MathUtils.lerp(0.6, 1.3, airMass), 0, 1);

    if (atmosphere === 'Earthlike') {
      const tempSuitability = MathUtils.clamp(1 - Math.abs(temperatureK - 288) / 170, 0, 1);
      cloudiness = MathUtils.clamp(cloudiness * MathUtils.lerp(0.6, 1.3, tempSuitability), 0, 1);
    } else if (atmosphere === 'CO2') {
      cloudiness = MathUtils.clamp(cloudiness * 0.9, 0, 1);
    } else if (atmosphere === 'H2He') {
      cloudiness = MathUtils.clamp(cloudiness * 1.05, 0, 1);
    }

    if (isGasBody) {
      cloudiness = MathUtils.clamp(cloudiness + 0.12, 0, 1);
      storminess = MathUtils.clamp(storminess + 0.08, 0, 1);
    }

    const radiusKm = Math.max(body.radius / (sceneScale * RADIUS_VISIBILITY_BONUS), 1);
    const baseAltitudeRatio = preset.cloudStyle?.baseAltitude ?? (isGasBody ? 0.012 : 0.006);
    const cloudAltitudeKm = Math.max(1, radiusKm * baseAltitudeRatio * MathUtils.lerp(0.85, 1.25, airMass));
    const albedoBoostBase = preset.albedoBoost ?? 0;
    const albedoBoost = MathUtils.clamp(albedoBoostBase + cloudiness * 0.12 + aerosols * 0.05, 0, 1);

    const params: AtmosphereParams = {
      planetClass: isGasBody ? 'gas' : 'terrestrial',
      pressureAtm,
      scaleHeightKm,
      composition: preset.composition,
      aerosols,
      clouds: cloudiness,
      cloudAltitudeKm,
      storminess,
      albedoBoost
    };

    return {
      params,
      cloudStyle: preset.cloudStyle,
      airMass,
      radiusKm
    };
  }, [sceneScale]);

  const resolveAtmosphereBundle = useCallback((body: OrbitingPlanet | OrbitingMoon): AtmosphereLayerBundle | null => {
    const atmosphere = body.atmosphere;
    if (!atmosphere || atmosphere === 'None') return null;

    const isGasBody = body.isSolid === false
      || body.type === 'GasGiant'
      || body.type === 'IceGiant'
      || body.type === 'SubNeptune';
    const { params, cloudStyle, airMass, radiusKm } = resolveAtmosphereParams(body, atmosphere, isGasBody);
    const coeffs = deriveScatteringCoeffs(params);
    const distanceNear = body.radius * ATMOSPHERE_SHELL_DISTANCE_NEAR_FACTOR;
    const distanceFar = body.radius * ATMOSPHERE_SHELL_DISTANCE_FAR_FACTOR;

    let cloudsKey = 'cloud:none';
    let clouds: AtmosphereLayerBundle['clouds'] = undefined;
    if (cloudStyle && params.clouds > 0.08) {
      const seed = hashStringToUnit(`${body.id}|cloud_seed`);
      const seed2 = hashStringToUnit(`${body.id}|cloud_seed2`);
      const bandOffset = hashStringToUnit(`${body.id}|cloud_band_offset`) * Math.PI * 2;
      const cloudiness = MathUtils.clamp(params.clouds, 0, 1);
      const threshold = MathUtils.clamp(
        cloudStyle.threshold - cloudiness * (isGasBody ? 0.18 : 0.12),
        0.16,
        0.9
      );
      const opacity = MathUtils.clamp(
        cloudStyle.opacity * MathUtils.lerp(0.65, 1.2, cloudiness) * (isGasBody ? 1.15 : 1),
        0,
        0.98
      );
      const altitudeRatio = MathUtils.clamp(params.cloudAltitudeKm / radiusKm, 0.002, 0.2);
      const cloudScale = 1 + altitudeRatio;
      const bandStrength = cloudStyle.bandStrength * MathUtils.lerp(0.6, 1.2, params.storminess);
      const bandFrequency = cloudStyle.bandFrequency * MathUtils.lerp(0.8, 1.2, params.storminess);
      const noiseScale = cloudStyle.noiseScale * MathUtils.lerp(0.9, 1.2, params.storminess);
      cloudsKey = `cloud:${cloudScale.toFixed(4)}:${threshold.toFixed(3)}:${opacity.toFixed(3)}:${bandStrength.toFixed(2)}`;

      clouds = {
        material: createCloudLayerMaterial({
          sunColor: sunColorRef.current,
          sunPosition,
          cloudColor: cloudStyle.color,
          shadowColor: cloudStyle.shadowColor,
          opacity,
          threshold,
          softness: cloudStyle.softness,
          noiseScale,
          seed,
          seed2,
          bandStrength,
          bandFrequency,
          bandOffset,
          rimPower: cloudStyle.rimPower,
          rimStrength: cloudStyle.rimStrength,
          nightMin: MathUtils.clamp(coeffs.nightMin + airMass * 0.04, 0.06, 0.18)
        }),
        scale: cloudScale
      };
    }

    let hazeKey = 'haze:none';
    let haze: AtmosphereLayerBundle['haze'] = undefined;
    if (!isGasBody && params.pressureAtm > 0.08) {
      const pressureNorm = MathUtils.clamp(Math.log10(params.pressureAtm + 0.1) / 2, 0, 1);
      const scaleNorm = MathUtils.clamp(params.scaleHeightKm / 80, 0, 1);
      const hazeBase = MathUtils.clamp(0.12 + pressureNorm * 0.32 + params.aerosols * 0.2, 0.08, 0.6);
      const hazeAlphaScale = MathUtils.clamp(0.22 + pressureNorm * 0.35 + params.aerosols * 0.18, 0.18, 0.6);
      const hazeCoeffs = {
        betaRayleigh: coeffs.betaRayleigh.clone().multiplyScalar(0.35 + pressureNorm * 0.25),
        betaMie: coeffs.betaMie.clone().multiplyScalar(0.6 + pressureNorm * 0.7 + params.aerosols * 0.35),
        absorption: coeffs.absorption.clone().multiplyScalar(0.5 + params.aerosols * 0.25),
        hazeTint: coeffs.hazeTint.clone().lerp(new Color('#ffffff'), 0.15 + params.aerosols * 0.15),
        mieG: MathUtils.clamp(coeffs.mieG + 0.04 + params.aerosols * 0.08, 0.55, 0.92),
        rimPower: MathUtils.lerp(1.6, 2.4, 1 - pressureNorm),
        gasStrength: coeffs.gasStrength,
        thickness: MathUtils.clamp(
          coeffs.thickness * MathUtils.lerp(0.4, 0.8, pressureNorm) * MathUtils.lerp(0.8, 1.1, scaleNorm),
          0.005,
          0.08
        ),
        nightMin: MathUtils.clamp(coeffs.nightMin + pressureNorm * 0.05, 0.04, 0.18)
      };
      const hazeScale = 1 + hazeCoeffs.thickness;
      hazeKey = `haze:${hazeScale.toFixed(4)}:${hazeBase.toFixed(3)}:${hazeAlphaScale.toFixed(3)}`;
      haze = {
        material: createAtmosphereShellMaterial({
          sunColor: sunColorRef.current,
          sunPosition,
          coeffs: hazeCoeffs,
          distanceNear,
          distanceFar,
          boostMax: ATMOSPHERE_SHELL_DISTANCE_BOOST_MAX * 0.6,
          hazeBase,
          alphaScale: hazeAlphaScale,
          side: FrontSide,
          blending: NormalBlending
        }),
        scale: hazeScale
      };
    }

    const shellKey = [
      atmosphere,
      params.planetClass,
      params.pressureAtm.toFixed(2),
      params.scaleHeightKm.toFixed(2),
      params.aerosols.toFixed(2),
      params.clouds.toFixed(2),
      params.storminess.toFixed(2),
      params.albedoBoost.toFixed(2),
      body.radius.toFixed(3)
    ].join('|');
    const cacheKey = `${shellKey}|${cloudsKey}|${hazeKey}`;

    const existing = atmosphereBundleByBodyIdRef.current.get(body.id);
    if (existing && existing.key === cacheKey) return existing;
    if (existing) {
      disposeAtmosphereBundle(existing);
      atmosphereBundleByBodyIdRef.current.delete(body.id);
    }

    const bundle: AtmosphereBundleCacheEntry = {
      key: cacheKey,
      shell: {
        material: createAtmosphereShellMaterial({
          sunColor: sunColorRef.current,
          sunPosition,
          coeffs,
          distanceNear,
          distanceFar,
          boostMax: ATMOSPHERE_SHELL_DISTANCE_BOOST_MAX
        }),
        scale: 1 + coeffs.thickness
      }
    };

    if (clouds) {
      bundle.clouds = clouds;
    }
    if (haze) {
      bundle.haze = haze;
    }

    atmosphereBundleByBodyIdRef.current.set(body.id, bundle);
    return bundle;
  }, [disposeAtmosphereBundle, resolveAtmosphereParams, sunPosition]);

  const bodyMaterialByIdRef = useRef<Map<string, MeshStandardMaterial>>(new Map());
  useEffect(() => () => {
    bodyMaterialByIdRef.current.forEach(material => material.dispose());
    bodyMaterialByIdRef.current.clear();
  }, []);

  const resolveOwnerTintedColor = useCallback((baseColor: string, ownerTint: string): string => {
    if (ownerTint === '#ffffff' || OWNER_TINT_STRENGTH <= 0) return baseColor;
    return new Color(baseColor).lerp(new Color(ownerTint), OWNER_TINT_STRENGTH).getStyle();
  }, []);

  const factionById = useMemo(() => new Map(factions.map((faction) => [faction.id, faction])), [factions]);
  const ownerColorByBodyId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    system.planets.forEach(body => {
      const ownerId = body.ownerFactionId ?? null;
      out[body.id] = ownerId ? (factionById.get(ownerId)?.color ?? '#ffffff') : '#ffffff';
    });
    return out;
  }, [factionById, system.planets]);

  const resolvePlanetMaterial = useCallback((planet: OrbitingPlanet): MeshStandardMaterial => {
    const base = planetMaterialMap[planet.type];
    const baseColor = PLANET_TYPE_COLORS[planet.type];
    const { baseColor: tintedBaseColor, surfaceTint } = resolveThermalTints(baseColor, planet.temperatureK);
    const hasAtmosphere = Boolean(planet.atmosphere && planet.atmosphere !== 'None');
    const terminatorSoftness = hasAtmosphere ? DAY_NIGHT_TERMINATOR_SOFTNESS_ATMOSPHERE : DAY_NIGHT_TERMINATOR_SOFTNESS;
    const nightMin = hasAtmosphere ? DAY_NIGHT_NIGHT_MIN_ATMOSPHERE : DAY_NIGHT_NIGHT_MIN;
    const ownerTint = ownerColorByBodyId[planet.id] ?? '#ffffff';
    const surfaceScales = resolveSurfaceDetailScales({ isMoon: false, bodyType: planet.type, hasAtmosphere });
    const existing = bodyMaterialByIdRef.current.get(planet.id);
    if (existing) {
      existing.userData.baseColor = tintedBaseColor;
      existing.userData.surfaceTintColor = surfaceTint;
      existing.userData.ownerTintColor = ownerTint;
      existing.userData.ownerTintStrength = OWNER_TINT_STRENGTH;
      if (typeof existing.userData.baseEmissiveIntensity !== 'number') {
        existing.userData.baseEmissiveIntensity = existing.emissiveIntensity ?? 0;
      }
      existing.userData.surfaceDisplacementScale = surfaceScales.displacementScale;
      existing.userData.surfaceDisplacementBias = surfaceScales.displacementBias;
      existing.normalScale.set(surfaceScales.normalScale, surfaceScales.normalScale);
      existing.metalness = 0;
      existing.dithering = true;
      const baseTint = existing.map ? surfaceTint : tintedBaseColor;
      existing.color.set(resolveOwnerTintedColor(baseTint, ownerTint));
      applyDayNightTerminator(existing, { nightMin, terminatorSoftness, sunPosition });
      return existing;
    }
    const material = base.clone();
    material.normalScale = new Vector2(surfaceScales.normalScale, surfaceScales.normalScale);
    material.aoMapIntensity = SURFACE_AO_INTENSITY;
    material.metalness = 0;
    material.dithering = true;
    material.userData.baseColor = tintedBaseColor;
    material.userData.surfaceTintColor = surfaceTint;
    material.userData.ownerTintColor = ownerTint;
    material.userData.ownerTintStrength = OWNER_TINT_STRENGTH;
    material.userData.baseRoughness = material.roughness;
    material.userData.baseEmissiveIntensity = material.emissiveIntensity ?? 0;
    material.userData.surfaceTextureKey = null;
    material.userData.surfaceDisplacementScale = surfaceScales.displacementScale;
    material.userData.surfaceDisplacementBias = surfaceScales.displacementBias;
    material.emissive.set('#000000');
    material.color.set(resolveOwnerTintedColor(tintedBaseColor, ownerTint));
    applyDayNightTerminator(material, { nightMin, terminatorSoftness, sunPosition });
    bodyMaterialByIdRef.current.set(planet.id, material);
    return material;
  }, [ownerColorByBodyId, planetMaterialMap, resolveOwnerTintedColor, sunPosition]);

  const resolveMoonMaterial = useCallback((moon: OrbitingMoon): MeshStandardMaterial => {
    const base = moonMaterialMap[moon.type];
    const baseColor = MOON_TYPE_COLORS[moon.type];
    const { baseColor: tintedBaseColor, surfaceTint } = resolveThermalTints(baseColor, moon.temperatureK);
    const hasAtmosphere = Boolean(moon.atmosphere && moon.atmosphere !== 'None');
    const terminatorSoftness = hasAtmosphere ? DAY_NIGHT_TERMINATOR_SOFTNESS_ATMOSPHERE : DAY_NIGHT_TERMINATOR_SOFTNESS;
    const nightMin = hasAtmosphere ? DAY_NIGHT_NIGHT_MIN_ATMOSPHERE : DAY_NIGHT_NIGHT_MIN;
    const ownerTint = ownerColorByBodyId[moon.id] ?? '#ffffff';
    const surfaceScales = resolveSurfaceDetailScales({ isMoon: true, bodyType: moon.type, hasAtmosphere });
    const existing = bodyMaterialByIdRef.current.get(moon.id);
    if (existing) {
      existing.userData.baseColor = tintedBaseColor;
      existing.userData.surfaceTintColor = surfaceTint;
      existing.userData.ownerTintColor = ownerTint;
      existing.userData.ownerTintStrength = OWNER_TINT_STRENGTH;
      if (typeof existing.userData.baseEmissiveIntensity !== 'number') {
        existing.userData.baseEmissiveIntensity = existing.emissiveIntensity ?? 0;
      }
      existing.userData.surfaceDisplacementScale = surfaceScales.displacementScale;
      existing.userData.surfaceDisplacementBias = surfaceScales.displacementBias;
      existing.normalScale.set(surfaceScales.normalScale, surfaceScales.normalScale);
      existing.metalness = 0;
      existing.dithering = true;
      const baseTint = existing.map ? surfaceTint : tintedBaseColor;
      existing.color.set(resolveOwnerTintedColor(baseTint, ownerTint));
      applyDayNightTerminator(existing, { nightMin, terminatorSoftness, sunPosition });
      return existing;
    }
    const material = base.clone();
    material.normalScale = new Vector2(surfaceScales.normalScale, surfaceScales.normalScale);
    material.aoMapIntensity = SURFACE_AO_INTENSITY;
    material.metalness = 0;
    material.dithering = true;
    material.userData.baseColor = tintedBaseColor;
    material.userData.surfaceTintColor = surfaceTint;
    material.userData.ownerTintColor = ownerTint;
    material.userData.ownerTintStrength = OWNER_TINT_STRENGTH;
    material.userData.baseRoughness = material.roughness;
    material.userData.baseEmissiveIntensity = material.emissiveIntensity ?? 0;
    material.userData.surfaceTextureKey = null;
    material.userData.surfaceDisplacementScale = surfaceScales.displacementScale;
    material.userData.surfaceDisplacementBias = surfaceScales.displacementBias;
    material.emissive.set('#000000');
    material.color.set(resolveOwnerTintedColor(tintedBaseColor, ownerTint));
    applyDayNightTerminator(material, { nightMin, terminatorSoftness, sunPosition });
    bodyMaterialByIdRef.current.set(moon.id, material);
    return material;
  }, [moonMaterialMap, ownerColorByBodyId, resolveOwnerTintedColor, sunPosition]);

  const resolveBodyMaterial = useCallback((bodyId: string): MeshStandardMaterial | null => {
    return bodyMaterialByIdRef.current.get(bodyId) ?? null;
  }, []);

  const bodyWorldPositions = useMemo<Record<string, [number, number, number]>>(() => {
    const positions: Record<string, [number, number, number]> = {};

    starModels.forEach((star) => {
      positions[star.id] = star.position;
    });

    planets.forEach((planet) => {
      const planetPosition = computeInclinedOrbitPosition(
        planet.orbitRadius,
        planet.orbitAngle,
        planet.orbitInclinationDeg,
        planet.orbitAscendingNodeDeg
      );
      positions[planet.id] = planetPosition;

      planet.moons.forEach((moon) => {
        const moonOffset = computeInclinedOrbitPosition(
          moon.orbitRadius,
          moon.orbitAngle,
          moon.orbitInclinationDeg,
          moon.orbitAscendingNodeDeg
        );
        positions[moon.id] = [
          planetPosition[0] + moonOffset[0],
          planetPosition[1] + moonOffset[1],
          planetPosition[2] + moonOffset[2]
        ];
      });
    });

    return positions;
  }, [planets, starModels]);
  const bodyRadii = useMemo<Record<string, number>>(() => {
    const radii: Record<string, number> = {};

    starModels.forEach((star) => {
      radii[star.id] = star.radius;
    });

    planets.forEach((planet) => {
      radii[planet.id] = planet.radius;
      planet.moons.forEach((moon) => {
        radii[moon.id] = moon.radius;
      });
    });

    return radii;
  }, [planets, starModels]);

  const systemFleets = useMemo(() => getSystemFleets(system, fleets), [fleets, system]);
  const systemStations = useMemo(
    () => stations.filter((station) => station.systemId === system.id),
    [stations, system.id]
  );

  const bodyNameById = useMemo(() => {
    const map = new Map<string, string>();
    system.planets.forEach((body) => {
      map.set(body.id, body.name || body.id);
    });
    return map;
  }, [system.planets]);

  const bodyLabels = useMemo(() => {
    const labels: Array<{
      id: string;
      name: string;
      position: [number, number, number];
      radius: number;
      kind: 'planet' | 'moon';
      parent?: { position: [number, number, number]; radius: number };
    }> = [];

    planets.forEach((planet) => {
      const planetPosition = bodyWorldPositions[planet.id];
      const planetRadius = bodyRadii[planet.id];
      if (planetPosition && planetRadius) {
        labels.push({
          id: planet.id,
          name: bodyNameById.get(planet.id) ?? planet.id,
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
            name: bodyNameById.get(moon.id) ?? moon.id,
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
  }, [bodyNameById, bodyRadii, bodyWorldPositions, planets]);

  const solidBodyIds = useMemo(
    () => new Set(system.planets.filter(body => body.isSolid).map(body => body.id)),
    [system.planets]
  );

  const [hoveredObjectId, setHoveredObjectId] = useState<SystemObjectId | null>(null);
  const selectedObjectId = useMemo(
    () => (selectedFleetId ? makeObjectId('fleet', selectedFleetId) : null),
    [selectedFleetId]
  );

  const handleSelectObject = useCallback((objectId: SystemObjectId) => {
    const parsed = parseObjectId(objectId);
    if (!parsed) return;
    if (parsed.kind === 'fleet') {
      onFleetSelect?.(parsed.id);
    }
  }, [onFleetSelect]);
  const handleHoverObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(objectId);
  }, []);
  const handleBlurObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectBody = useCallback((bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => {
    if (!solidBodyIds.has(bodyId)) return;
    onPlanetClick?.(bodyId, event);
  }, [onPlanetClick, solidBodyIds]);
  const handleHoverBody = useCallback((bodyId: string) => {
    setHoveredObjectId(makeObjectId('body', bodyId));
  }, []);
  const handleBlurBody = useCallback((bodyId: string) => {
    const objectId = makeObjectId('body', bodyId);
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);

  const selectedBodyId = focusBodyId ?? null;
  const highDetailBodyId = selectedBodyId ?? null;

  const starSegments = 64;
  const planetSegments = 96;
  const moonSegments = 64;
  const enableHighGeometry = Boolean(highDetailBodyId);
  const starGeometry = useDisposableMemo(
    () => new SphereGeometry(1, starSegments, starSegments),
    [starSegments]
  );
  const planetGeometry = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, planetSegments, planetSegments);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, [planetSegments]);
  const moonGeometry = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, moonSegments, moonSegments);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, [moonSegments]);
  const planetGeometryHigh = useMemo(() => {
    if (!enableHighGeometry) return null;
    const geometry = new SphereGeometry(1, 128, 128);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, [enableHighGeometry]);
  useEffect(() => () => {
    planetGeometryHigh?.dispose();
  }, [planetGeometryHigh]);
  const moonGeometryHigh = useMemo(() => {
    if (!enableHighGeometry) return null;
    const geometry = new SphereGeometry(1, 96, 96);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, [enableHighGeometry]);
  useEffect(() => () => {
    moonGeometryHigh?.dispose();
  }, [moonGeometryHigh]);

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

  const maxOrbitRadius = useMemo(() => {
    const starExtent = starModels.reduce((max, star) => {
      const [x, y, z] = star.position;
      const distance = Math.sqrt(x * x + y * y + z * z);
      return Math.max(max, distance + star.radius);
    }, starRadius);

    return planets.reduce((max, planet) => {
      const planetExtent = planet.orbitRadius + planet.radius;
      const moonExtent = planet.moons.reduce(
        (moonMax, moon) => Math.max(moonMax, planet.orbitRadius + moon.orbitRadius + moon.radius),
        planetExtent
      );
      return Math.max(max, moonExtent);
    }, starExtent);
  }, [planets, starModels, starRadius]);

  const hitboxScaleMultiplier = prefersTouchFallback ? 1.2 : 1;
  const cloudShadowStrengthScale = 1;
  const ambientLightIntensity = MathUtils.clamp(0.08 + clampedScale * 0.03, 0.08, 0.22);
  const starLightIntensity = getStarLightIntensityForRadius(starRadius);
  const rimLightIntensity = 0.24;
  const rimLightDistance = Math.max(maxOrbitRadius * 3.2, starRadius * 120);
  const rimLightColor = useMemo(
    () => new Color('#e6ecff').lerp(new Color(starTintColor), 0.3).getStyle(),
    [starTintColor]
  );
  const starfieldRadius = Math.max(maxOrbitRadius * 4, starRadius * 120);
  const companionStarLights = useMemo(() => (
    starModels.slice(1).map((star) => ({
      id: star.id,
      position: star.position,
      intensity: getStarLightIntensityForRadius(star.radius),
      color: new Color('#ffffff').lerp(new Color(star.tintColor), 0.2).getStyle()
    }))
  ), [starModels]);

  return (
    <group>
      <ambientLight intensity={ambientLightIntensity} color="#cfe1ff" />
      <pointLight
        position={primaryStar?.position ?? [0, 0, 0]}
        intensity={starLightIntensity}
        distance={0}
        decay={0}
        color={starLightColor}
      />
      {companionStarLights.map((light) => (
        <pointLight
          key={light.id}
          position={light.position}
          intensity={light.intensity}
          distance={0}
          decay={0}
          color={light.color}
        />
      ))}
      <SystemRimLight
        intensity={rimLightIntensity}
        color={rimLightColor}
        distance={rimLightDistance}
        target={primaryStar?.position ?? [0, 0, 0]}
      />
      <SystemStarfield radius={starfieldRadius} seedKey={`${system.id}-starfield`} tintColor={system.color || '#ffffff'} />
      <SystemSurfaceTextureManager
        starSystem={system}
        astroKey={astroKey}
        planetSurfaceDescriptorsByBodyId={planetSurfaceDescriptorsByBodyId}
        ownerColorByBodyId={ownerColorByBodyId}
        planets={planets}
        bodyWorldPositions={bodyWorldPositions}
        bodyRadii={bodyRadii}
        selectedBodyId={selectedBodyId}
        cloudShadowStrengthScale={cloudShadowStrengthScale}
        resolveMaterial={resolveBodyMaterial}
      />
      <SystemCelestialLayer
        stars={starModels}
        starGeometry={starGeometry}
        planets={planets}
        orbitMaterial={orbitMaterial}
        planetGeometry={planetGeometry}
        planetGeometryHigh={planetGeometryHigh}
        moonGeometry={moonGeometry}
        moonGeometryHigh={moonGeometryHigh}
        resolvePlanetMaterial={resolvePlanetMaterial}
        resolveMoonMaterial={resolveMoonMaterial}
        resolveAtmosphereBundle={resolveAtmosphereBundle}
        starSpinReferenceRadius={starSpinReferenceRadius}
        planetSpinReferenceRadius={planetSpinReferenceRadius}
        moonSpinReferenceRadius={moonSpinReferenceRadius}
        highDetailBodyId={highDetailBodyId}
        fixedTerminator={SYSTEM_VIEW_FIXED_TERMINATOR}
        hitboxScaleMultiplier={hitboxScaleMultiplier}
        sunPosition={sunPosition}
        enableBloom={!prefersTouchFallback}
        onBodyPressStart={() => {}}
        onBodyPressMove={() => {}}
        onBodyPressEnd={() => {}}
        onBodyPressCancel={() => {}}
        onHoverBody={handleHoverBody}
        onBlurBody={handleBlurBody}
        onSelectBody={handleSelectBody}
      />
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
        getFactionColor={(id) => factionById.get(id)?.color ?? '#94a3b8'}
        onHoverObject={handleHoverObject}
        onBlurObject={handleBlurObject}
        onSelectObject={handleSelectObject}
        onFocusPoint={() => {}}
      />
      {bodyLabels.length > 0 && (
        <SystemBodyLabels
          labels={bodyLabels}
          baseScale={clampedScale}
        />
      )}
    </group>
  );
};

const PlanetLayer: React.FC<{
  planet: PlanetBody;
  radius: number;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
}> = ({ planet, radius, onClick }) => {
  return (
    <mesh
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    >
      <sphereGeometry args={[radius, 64, 64]} />
      <meshStandardMaterial color={resolvePlanetColor(planet)} roughness={0.85} metalness={0.05} />
    </mesh>
  );
};

const SURFACE_CAP_ANGLE_DEG = 60;
const SURFACE_LINE_OFFSET = 1.01;
const SURFACE_MARKER_OFFSET = 1.035;
const SURFACE_ARMY_MARKER_RADIUS = 0.02;
const SURFACE_BUILDING_MARKER_RADIUS = 0.028;
const SURFACE_MAX_SEGMENTS = 18000;

const selectSurfaceFrequency = (distance: number, radius: number): number => {
  const near = radius * 6;
  const mid = radius * 12;
  if (distance <= near) return 12;
  if (distance <= mid) return 8;
  return 4;
};

const SurfaceLayer: React.FC<{
  planetRadius: number;
  center: Vec3;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor | null;
  armies: GameState['armies'];
  buildings: GroundBuilding[];
  getFactionColor: (id: string) => string;
  onSelectTile?: (selection: { bodyId: string; tileId: number; dir: Vec3 }) => void;
}> = ({ planetRadius, center, bodyId, descriptor, armies, buildings, getFactionColor, onSelectTile }) => {
  const { camera } = useThree();
  const geometryRef = useRef<BufferGeometry>(null);
  const gridCacheRef = useRef<Map<number, GridData>>(new Map());
  const lastViewDirRef = useRef<Vector3>(new Vector3(0, 0, 1));
  const viewDirRef = useRef<Vector3>(new Vector3());
  const lastFrequencyRef = useRef<number>(0);
  const centerVec = useMemo(() => new Vector3(center.x, center.y, center.z), [center.x, center.y, center.z]);
  const hoverFrameRef = useRef<number | null>(null);
  const hoverPointRef = useRef<Vector3>(new Vector3());

  const getGridData = (frequency: number): GridData => {
    const cache = gridCacheRef.current;
    const existing = cache.get(frequency);
    if (existing) return existing;
    const data = buildGridData(frequency);
    cache.set(frequency, data);
    return data;
  };

  const markers = useMemo(() => {
    if (!descriptor) return [];
    const markerRadius = planetRadius * SURFACE_MARKER_OFFSET;
    const armySize = planetRadius * SURFACE_ARMY_MARKER_RADIUS;
    const buildingSize = planetRadius * SURFACE_BUILDING_MARKER_RADIUS;
    const out: Array<{
      id: string;
      kind: 'army' | 'building';
      position: Vec3;
      color: string;
      size: number;
    }> = [];

    armies.forEach((army) => {
      if (!army.surfacePos) return;
      const tileId = resolveSurfaceTileId(descriptor, army.surfacePos);
      if (tileId === null) return;
      const dir = getSurfaceTileDir(descriptor, tileId);
      if (!dir) return;
      out.push({
        id: army.id,
        kind: 'army',
        position: { x: dir.x * markerRadius, y: dir.y * markerRadius, z: dir.z * markerRadius },
        color: getFactionColor(army.factionId),
        size: armySize
      });
    });

    buildings.forEach((building) => {
      const tileId = resolveSurfaceTileId(descriptor, building.surfacePos);
      if (tileId === null) return;
      const dir = getSurfaceTileDir(descriptor, tileId);
      if (!dir) return;
      out.push({
        id: building.id,
        kind: 'building',
        position: { x: dir.x * markerRadius, y: dir.y * markerRadius, z: dir.z * markerRadius },
        color: getFactionColor(building.factionId),
        size: buildingSize
      });
    });

    return sorted(out, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
  }, [armies, buildings, descriptor, getFactionColor, planetRadius]);

  const emitSelection = (point: Vector3) => {
    if (!onSelectTile) return;
    const hitDir = point.clone().sub(centerVec).normalize();
    const distance = camera.position.distanceTo(centerVec);
    const frequency = lastFrequencyRef.current || selectSurfaceFrequency(distance, planetRadius);
    const gridData = getGridData(frequency);
    const tileId = findClosestTile(gridData.grid, { x: hitDir.x, y: hitDir.y, z: hitDir.z });
    onSelectTile({ bodyId, tileId, dir: { x: hitDir.x, y: hitDir.y, z: hitDir.z } });
  };

  const scheduleHoverPick = (point: Vector3) => {
    hoverPointRef.current.copy(point);
    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      emitSelection(hoverPointRef.current);
    });
  };

  useEffect(() => {
    return () => {
      if (hoverFrameRef.current !== null) {
        cancelAnimationFrame(hoverFrameRef.current);
      }
    };
  }, []);

  useFrame(() => {
    const geometry = geometryRef.current;
    if (!geometry) return;

    const distance = camera.position.distanceTo(centerVec);
    const nextFrequency = selectSurfaceFrequency(distance, planetRadius);
    const viewDir = viewDirRef.current;
    viewDir.copy(camera.position).sub(centerVec).normalize();
    const minDot = Math.cos((SURFACE_CAP_ANGLE_DEG * Math.PI) / 180);

    const shouldUpdate =
      nextFrequency !== lastFrequencyRef.current
      || viewDir.dot(lastViewDirRef.current) < 0.995;

    if (!shouldUpdate) return;
    lastFrequencyRef.current = nextFrequency;
    lastViewDirRef.current.copy(viewDir);

    const { grid, polygons } = getGridData(nextFrequency);
    const radius = planetRadius * SURFACE_LINE_OFFSET;
    const positions: number[] = [];
    let segmentCount = 0;
    let reachedBudget = false;

    for (let i = 0; i < grid.vertices.length; i += 1) {
      if (reachedBudget) break;
      const v = grid.vertices[i];
      const dotVal = v.x * viewDir.x + v.y * viewDir.y + v.z * viewDir.z;
      if (dotVal < minDot) continue;

      const polygon = polygons[i];
      if (!polygon || polygon.length < 3) continue;

      for (let j = 0; j < polygon.length; j += 1) {
        if (segmentCount >= SURFACE_MAX_SEGMENTS) {
          reachedBudget = true;
          break;
        }
        const a = polygon[j];
        const b = polygon[(j + 1) % polygon.length];
        positions.push(
          a.x * radius, a.y * radius, a.z * radius,
          b.x * radius, b.y * radius, b.z * radius
        );
        segmentCount += 1;
      }
    }

    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.computeBoundingSphere();
  });

  return (
    <group>
      <lineSegments raycast={ignoreRaycast}>
        <bufferGeometry ref={geometryRef} />
        <lineBasicMaterial color="#cbd5f5" transparent opacity={0.65} />
      </lineSegments>
      {markers.map(marker => (
        <mesh
          key={marker.id}
          position={[marker.position.x, marker.position.y, marker.position.z]}
          raycast={ignoreRaycast}
        >
          {marker.kind === 'army' ? (
            <sphereGeometry args={[marker.size, 10, 10]} />
          ) : (
            <boxGeometry args={[marker.size * 1.2, marker.size * 1.2, marker.size * 1.2]} />
          )}
          <meshBasicMaterial color={marker.color} transparent opacity={0.9} />
        </mesh>
      ))}
      <mesh
        onClick={(event) => {
          if (!onSelectTile) return;
          event.stopPropagation();
          emitSelection(event.point);
        }}
        onPointerMove={(event) => {
          if (!onSelectTile) return;
          if (event.pointerType !== 'mouse') return;
          if ((event.buttons ?? 0) > 0) return;
          scheduleHoverPick(event.point);
        }}
      >
        <sphereGeometry args={[planetRadius * SURFACE_LINE_OFFSET, 48, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
};

const LegacyGameScene: React.FC<GameSceneProps> = ({
  gameState,
  enemySightings,
  selectedFleetId,
  onFleetSelect,
  onFleetInspect,
  onSystemClick,
  onBackgroundClick,
  focusTarget,
  isInteractive = true,
  onReady
}) => {
  const { worldOrigin, shiftWorldOrigin } = useWorldOrigin();

  const playerHomeworld = useMemo(() => {
    const ownedHomeworld = gameState.systems.find(
      (system) => system.isHomeworld && system.ownerFactionId === gameState.playerFactionId
    );

    if (ownedHomeworld) {
      return { x: ownedHomeworld.position.x, y: 0, z: ownedHomeworld.position.z };
    }

    const ownedSystem = gameState.systems.find((system) => system.ownerFactionId === gameState.playerFactionId);

    if (ownedSystem) {
      return { x: ownedSystem.position.x, y: 0, z: ownedSystem.position.z };
    }

    return { x: 0, y: 0, z: 0 };
  }, [gameState.playerFactionId, gameState.systems]);

  const isScenarioReady = gameState.systems.length > 0;

  const initialHomeworldRef = useRef<Vec3 | null>(null);
  const [lastFocusedTarget, setLastFocusedTarget] = useState<Vec3 | null>(null);

  useEffect(() => {
    if (isScenarioReady && !initialHomeworldRef.current) {
      initialHomeworldRef.current = playerHomeworld;
    }
  }, [isScenarioReady, playerHomeworld]);

  useEffect(() => {
    if (focusTarget) {
      setLastFocusedTarget({ x: focusTarget.x, y: 0, z: focusTarget.z });
    }
  }, [focusTarget]);

  const homeworldForCamera = initialHomeworldRef.current ?? playerHomeworld;
  const renderHomeworld = useMemo(
    () => offsetVec3(homeworldForCamera, worldOrigin),
    [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z, worldOrigin.x, worldOrigin.y, worldOrigin.z]
  );

  const cameraTarget = useMemo(
    () => [renderHomeworld.x, renderHomeworld.y, renderHomeworld.z] as [number, number, number],
    [renderHomeworld.x, renderHomeworld.y, renderHomeworld.z]
  );

  const cameraPosition = useMemo(
    () => [renderHomeworld.x, renderHomeworld.y + 80, renderHomeworld.z + 50] as [number, number, number],
    [renderHomeworld.x, renderHomeworld.y, renderHomeworld.z]
  );

  const cameraFocusTarget = useMemo(
    () => (lastFocusedTarget ? offsetVec3(lastFocusedTarget, worldOrigin) : null),
    [
      lastFocusedTarget?.x,
      lastFocusedTarget?.y,
      lastFocusedTarget?.z,
      worldOrigin.x,
      worldOrigin.y,
      worldOrigin.z
    ]
  );

  const scenarioRadius = useMemo(() => {
    const template = SCENARIO_TEMPLATES.find(scenario => scenario.id === gameState.scenarioId);
    return template?.generation.radius;
  }, [gameState.scenarioId]);

  const mapMetrics = useMapMetrics(gameState.systems, scenarioRadius);
  const mapBounds = useMemo(
    () => offsetBounds(mapMetrics.bounds, worldOrigin),
    [mapMetrics.bounds, worldOrigin.x, worldOrigin.y, worldOrigin.z]
  );
  const ownershipSignature = useMemo(() => {
      const owners = gameState.systems.map((system) => `${system.id}:${system.ownerFactionId ?? 'none'}`);
      return sorted(owners).join('|');
  }, [gameState.systems]);

  const battlingSystemIds = useMemo(() => {
    if (!gameState.battles) return new Set<string>();
    return new Set(
        gameState.battles
            .filter(b => b.status !== 'resolved' || b.turnResolved === gameState.day)
            .map(b => b.systemId)
    );
  }, [gameState.battles, gameState.day]);

  const visibleFleetIds = useMemo(() => {
      return new Set(gameState.fleets.map(f => f.id));
  }, [gameState.fleets]);

  const hasCoarsePointer = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;

  const handleFleetInteraction = (
    fleetId: string,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => {
    if (!isInteractive) return;
    const isDouble = options?.isDouble ?? false;
    const pointerType = options?.pointerType;
    const isTouchPointer = pointerType === 'touch' || hasCoarsePointer();

    if (isDouble) {
      onFleetInspect(fleetId);
      return;
    }

    if (isTouchPointer) {
      onFleetInspect(fleetId);
      return;
    }
    onFleetSelect(fleetId);
  };

  // Color Helper
  const getFactionColor = useMemo(() => (id: string) => resolveFactionColor(gameState.factions, id), [gameState.factions]);
  const worldOriginVector = useMemo(
    () => new Vector3(worldOrigin.x, worldOrigin.y, worldOrigin.z),
    [worldOrigin.x, worldOrigin.y, worldOrigin.z]
  );
  const handleGalaxySystemClick = useCallback((sys: StarSystem, event: ThreeEvent<MouseEvent>) => {
    if (!isInteractive) return;
    event.point.add(worldOriginVector);
    onSystemClick(sys, event);
  }, [isInteractive, onSystemClick, worldOriginVector]);

  return (
    <div className={`absolute inset-0 z-0 bg-black ${isInteractive ? '' : 'pointer-events-none'}`}>
      <Canvas
        gl={{ antialias: false, powerPreference: "high-performance" }}
        dpr={[1, 1.5]}
        onPointerMissed={() => {
            if (!isInteractive) return;
            onBackgroundClick();
        }}
      >
        <Suspense fallback={null}>
            <GameCamera
              initialPosition={cameraPosition}
              initialTarget={cameraTarget}
              focusTarget={cameraFocusTarget}
              ready={isScenarioReady}
              mapRadius={mapMetrics.radius}
              mapBounds={mapBounds}
              onWorldOriginShift={shiftWorldOrigin}
              worldOriginShiftThreshold={WORLD_ORIGIN_SHIFT_THRESHOLD}
            />
            <group position={[-worldOrigin.x, -worldOrigin.y, -worldOrigin.z]}>
              <ambientLight intensity={0.4} color="#aaccff" />
              <pointLight position={[0, 50, 0]} intensity={1.5} color="#ffffff" />
              <ParallaxStars />
              
              <group>
                  <TerritoryBorders 
                      systems={gameState.systems} 
                      signature={ownershipSignature}
                      factions={gameState.factions} // Pass factions for coloring
                  />

                  <Galaxy 
                    systems={gameState.systems} 
                    fleets={gameState.fleets}
                    factions={gameState.factions}
                    armies={gameState.armies}
                    battlingSystemIds={battlingSystemIds}
                    onSystemClick={handleGalaxySystemClick} 
                    playerFactionId={gameState.playerFactionId}
                  />
                  
                  <TrajectoryRenderer
                    fleets={gameState.fleets}
                    factions={gameState.factions}
                    playerFactionId={gameState.playerFactionId}
                  />

                  <IntelGhosts
                      sightings={enemySightings}
                      currentDay={gameState.day}
                      visibleFleetIds={visibleFleetIds}
                      getFactionColor={getFactionColor}
                  />

                  {gameState.fleets.map(fleet => (
                      <FleetMesh
                          key={fleet.id}
                          fleet={fleet}
                          day={gameState.day}
                          isSelected={selectedFleetId === fleet.id}
                          onSelect={(e, isDouble, pointerType) => {
                              e.stopPropagation();
                              handleFleetInteraction(fleet.id, { isDouble, pointerType });
                          }}
                          playerFactionId={gameState.playerFactionId}
                          color={getFactionColor(fleet.factionId)}
                      />
                  ))}

                  <LaserRenderer lasers={gameState.lasers} />
              </group>
            </group>

            <SceneReadyReporter onReady={onReady} />

            <EffectComposer enableNormalPass={false}>
                <Bloom luminanceThreshold={0.2} mipmapBlur intensity={1.2} radius={0.4} />
            </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
};

const UniverseScene: React.FC<GameSceneProps> = ({
  gameState,
  enemySightings,
  selectedFleetId,
  onFleetSelect,
  onFleetInspect,
  onSystemClick,
  onBackgroundClick,
  focusTarget,
  isInteractive = true,
  onReady,
  viewContext,
  viewZoom,
  onViewZoomChange,
  onFocusSystem,
  onFocusPlanet,
  onFocusSurface,
  onSurfaceTileSelect
}) => {
  const { worldOrigin, shiftWorldOrigin } = useWorldOrigin();
  const resolvedView = viewContext ?? { tier: 'galaxy', focus: {} };
  const fallbackZoom = ZOOM_PRESETS[resolvedView.tier] ?? ZOOM_PRESETS.galaxy;
  const zoomValue = clamp01(viewZoom ?? fallbackZoom);
  const zoomTier = viewZoom === undefined ? resolvedView.tier : resolveZoomTier(zoomValue, resolvedView.focus);

  const playerHomeworld = useMemo(() => {
    const ownedHomeworld = gameState.systems.find(
      (system) => system.isHomeworld && system.ownerFactionId === gameState.playerFactionId
    );

    if (ownedHomeworld) {
      return { x: ownedHomeworld.position.x, y: 0, z: ownedHomeworld.position.z };
    }

    const ownedSystem = gameState.systems.find((system) => system.ownerFactionId === gameState.playerFactionId);

    if (ownedSystem) {
      return { x: ownedSystem.position.x, y: 0, z: ownedSystem.position.z };
    }

    return { x: 0, y: 0, z: 0 };
  }, [gameState.playerFactionId, gameState.systems]);

  const isScenarioReady = gameState.systems.length > 0;
  const initialHomeworldRef = useRef<Vec3 | null>(null);
  const [lastFocusedTarget, setLastFocusedTarget] = useState<Vec3 | null>(null);

  useEffect(() => {
    if (isScenarioReady && !initialHomeworldRef.current) {
      initialHomeworldRef.current = playerHomeworld;
    }
  }, [isScenarioReady, playerHomeworld]);

  const resolvedSystem = useMemo(() => {
    if (resolvedView.focus.systemId) {
      return gameState.systems.find(system => system.id === resolvedView.focus.systemId) ?? null;
    }
    if (zoomTier !== 'galaxy') {
      return gameState.systems[0] ?? null;
    }
    return null;
  }, [gameState.systems, resolvedView.focus.systemId, zoomTier]);
  const hasSystemFocus = Boolean(resolvedSystem);

  const resolvedPlanet = useMemo(() => {
    if (!resolvedSystem) return null;
    if (resolvedView.focus.bodyId) {
      return resolvedSystem.planets.find(planet => planet.id === resolvedView.focus.bodyId) ?? null;
    }
    if (isTierAtLeast(zoomTier, 'planet')) {
      return resolvedSystem.planets.find(planet => planet.isSolid) ?? resolvedSystem.planets[0] ?? null;
    }
    return null;
  }, [resolvedSystem, resolvedView.focus.bodyId, zoomTier]);
  const hasPlanetFocus = Boolean(resolvedPlanet);
  const planetRadius = useMemo(
    () => (resolvedPlanet ? Math.max(4, resolvedPlanet.size * 2.5) : 0),
    [resolvedPlanet]
  );
  const surfaceDescriptor = useMemo(() => {
    if (!resolvedPlanet) return null;
    return gameState.planetSurfaceDescriptorsByBodyId?.[resolvedPlanet.id] ?? null;
  }, [gameState.planetSurfaceDescriptorsByBodyId, resolvedPlanet]);
  const surfaceArmies = useMemo(() => {
    if (!resolvedPlanet) return [];
    return gameState.armies.filter(
      army => army.state === ArmyState.DEPLOYED && army.containerId === resolvedPlanet.id
    );
  }, [gameState.armies, resolvedPlanet]);
  const surfaceBuildings = useMemo(() => {
    if (!resolvedPlanet) return [];
    return (gameState.groundBuildings ?? []).filter(building => building.surfacePos.bodyId === resolvedPlanet.id);
  }, [gameState.groundBuildings, resolvedPlanet]);

  const homeworldForCamera = initialHomeworldRef.current ?? playerHomeworld;
  const focusBase = zoomTier === 'galaxy' || !resolvedSystem
    ? homeworldForCamera
    : resolvedSystem.position;
  const renderFocusBase = useMemo(
    () => offsetVec3(focusBase, worldOrigin),
    [focusBase.x, focusBase.y, focusBase.z, worldOrigin.x, worldOrigin.y, worldOrigin.z]
  );

  const cameraOffset = useMemo(() => {
    switch (zoomTier) {
      case 'system':
        return { y: 45, z: 30 };
      case 'planet':
        return { y: 18, z: 12 };
      case 'surface':
        return { y: 9, z: 6 };
      default:
        return { y: 80, z: 50 };
    }
  }, [zoomTier]);

  const cameraTarget = useMemo(
    () => [renderFocusBase.x, renderFocusBase.y, renderFocusBase.z] as [number, number, number],
    [renderFocusBase.x, renderFocusBase.y, renderFocusBase.z]
  );

  const cameraPosition = useMemo(
    () => [renderFocusBase.x, renderFocusBase.y + cameraOffset.y, renderFocusBase.z + cameraOffset.z] as [number, number, number],
    [cameraOffset.y, cameraOffset.z, renderFocusBase.x, renderFocusBase.y, renderFocusBase.z]
  );

  useEffect(() => {
    const nextFocus = zoomTier === 'galaxy'
      ? (focusTarget ? { x: focusTarget.x, y: 0, z: focusTarget.z } : null)
      : (resolvedSystem ? { x: resolvedSystem.position.x, y: 0, z: resolvedSystem.position.z } : null);
    if (!nextFocus) return;
    setLastFocusedTarget(prev => {
      if (prev && prev.x === nextFocus.x && prev.y === nextFocus.y && prev.z === nextFocus.z) {
        return prev;
      }
      return nextFocus;
    });
  }, [
    zoomTier,
    focusTarget?.x,
    focusTarget?.y,
    focusTarget?.z,
    resolvedSystem?.position.x,
    resolvedSystem?.position.y,
    resolvedSystem?.position.z
  ]);

  const cameraFocusTarget = useMemo(
    () => (lastFocusedTarget ? offsetVec3(lastFocusedTarget, worldOrigin) : null),
    [
      lastFocusedTarget?.x,
      lastFocusedTarget?.y,
      lastFocusedTarget?.z,
      worldOrigin.x,
      worldOrigin.y,
      worldOrigin.z
    ]
  );

  const scenarioRadius = useMemo(() => {
    const template = SCENARIO_TEMPLATES.find(scenario => scenario.id === gameState.scenarioId);
    return template?.generation.radius;
  }, [gameState.scenarioId]);

  const mapMetrics = useMapMetrics(gameState.systems, scenarioRadius);
  const zoomStops = useMemo(() => resolveZoomStops(mapMetrics.radius), [mapMetrics.radius]);
  const zoomDistanceLimits = useMemo(() => {
    const minDistance = zoomStops[zoomStops.length - 1].distance;
    const maxDistance = zoomStops[0].distance;
    return { min: minDistance, max: maxDistance };
  }, [zoomStops]);
  const zoomTargetDistance = useMemo(() => {
    if (viewZoom === undefined) return null;
    return zoomToDistance(zoomStops, zoomValue);
  }, [viewZoom, zoomStops, zoomValue]);
  const handleDistanceChange = useCallback((distance: number) => {
    if (!onViewZoomChange) return;
    const nextZoom = distanceToZoom(zoomStops, distance);
    onViewZoomChange(nextZoom);
  }, [onViewZoomChange, zoomStops]);

  const ownershipSignature = useMemo(() => {
    const owners = gameState.systems.map((system) => `${system.id}:${system.ownerFactionId ?? 'none'}`);
    return sorted(owners).join('|');
  }, [gameState.systems]);

  const battlingSystemIds = useMemo(() => {
    if (!gameState.battles) return new Set<string>();
    return new Set(
      gameState.battles
        .filter(b => b.status !== 'resolved' || b.turnResolved === gameState.day)
        .map(b => b.systemId)
    );
  }, [gameState.battles, gameState.day]);

  const visibleFleetIds = useMemo(() => {
    return new Set(gameState.fleets.map(f => f.id));
  }, [gameState.fleets]);

  const worldOriginVector = useMemo(
    () => new Vector3(worldOrigin.x, worldOrigin.y, worldOrigin.z),
    [worldOrigin.x, worldOrigin.y, worldOrigin.z]
  );
  const handleGalaxySystemClick = (sys: StarSystem, event: ThreeEvent<MouseEvent>) => {
    if (!isInteractive) return;
    event.point.add(worldOriginVector);
    onFocusSystem?.(sys.id);
    onSystemClick(sys, event);
  };

  const handleFleetInteraction = (
    fleetId: string,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => {
    if (!isInteractive) return;
    const isDouble = options?.isDouble ?? false;
    const pointerType = options?.pointerType;
    const isTouchPointer = pointerType === 'touch'
      || (typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches);

    if (isDouble) {
      onFleetInspect(fleetId);
      return;
    }

    if (isTouchPointer) {
      onFleetInspect(fleetId);
      return;
    }
    onFleetSelect(fleetId);
  };

  const getFactionColor = useMemo(() => (id: string) => resolveFactionColor(gameState.factions, id), [gameState.factions]);

  const distanceLimits = useMemo(() => {
    if (viewZoom !== undefined) {
      if (zoomStops.length >= 5) {
        const overshoot = 1.05;
        const undershoot = 0.95;
        const globalMax = zoomStops[0].distance;
        const globalMin = zoomStops[zoomStops.length - 1].distance;
        const clampDistance = (value: number) => Math.max(globalMin, Math.min(globalMax, value));

        let min = globalMin;
        let max = globalMax;
        if (zoomTier === 'galaxy') {
          min = zoomStops[1].distance * undershoot;
          max = zoomStops[0].distance;
        } else if (zoomTier === 'system') {
          min = zoomStops[2].distance * undershoot;
          max = zoomStops[1].distance * overshoot;
        } else if (zoomTier === 'planet') {
          min = zoomStops[3].distance * undershoot;
          max = zoomStops[2].distance * overshoot;
        } else {
          min = zoomStops[4].distance;
          max = zoomStops[3].distance * overshoot;
        }

        const clampedMin = clampDistance(min);
        const clampedMax = clampDistance(max);
        if (clampedMin > clampedMax) return zoomDistanceLimits;
        return { min: clampedMin, max: clampedMax };
      }
      return zoomDistanceLimits;
    }
    if (resolvedView.tier === 'system') {
      return { min: 8, max: 140 };
    }
    if (resolvedView.tier === 'planet') {
      return { min: 2.5, max: 60 };
    }
    if (resolvedView.tier === 'surface') {
      return { min: 1.2, max: 35 };
    }
    return undefined;
  }, [resolvedView.tier, viewZoom, zoomDistanceLimits, zoomStops, zoomTier]);

  const virtualMapBounds = viewZoom === undefined
    ? (resolvedView.tier === 'galaxy' ? mapMetrics.bounds : null)
    : (!hasSystemFocus || zoomValue < ZOOM_THRESHOLDS.system ? mapMetrics.bounds : null);
  const mapBounds = useMemo(
    () => (virtualMapBounds ? offsetBounds(virtualMapBounds, worldOrigin) : null),
    [virtualMapBounds, worldOrigin.x, worldOrigin.y, worldOrigin.z]
  );
  const allowRotate = viewZoom === undefined
    ? isTierAtLeast(resolvedView.tier, 'planet')
    : (hasPlanetFocus && zoomValue >= ZOOM_THRESHOLDS.planet);

  const systemZoomT = hasSystemFocus
    ? smoothProgress(zoomValue, ZOOM_THRESHOLDS.system, ZOOM_THRESHOLDS.planet)
    : 0;
  const planetZoomT = hasSystemFocus
    ? smoothProgress(zoomValue, ZOOM_THRESHOLDS.planet, ZOOM_THRESHOLDS.surface)
    : 0;
  const surfaceZoomT = hasSystemFocus
    ? smoothProgress(zoomValue, ZOOM_THRESHOLDS.surface, 1)
    : 0;

  const showGalaxyLayer = viewZoom === undefined
    ? resolvedView.tier === 'galaxy'
    : (!hasSystemFocus || zoomValue < ZOOM_THRESHOLDS.planet);
  const showSystemLayer = hasSystemFocus && systemZoomT > 0.01;
  const showPlanetLayer = hasPlanetFocus && planetZoomT > 0.01;
  const showSurfaceLayer = hasPlanetFocus && surfaceZoomT > 0.01;

  const systemScaleTarget = showSystemLayer
    ? mapMetrics.radius * SYSTEM_LAYER_SCALE_FACTOR * systemZoomT
    : 0;
  const planetScaleBoost = MathUtils.lerp(1, 1.6, surfaceZoomT);
  const planetScaleTarget = showPlanetLayer
    ? PLANET_LAYER_SCALE * planetZoomT * planetScaleBoost
    : 0;

  return (
    <div className={`absolute inset-0 z-0 bg-black ${isInteractive ? '' : 'pointer-events-none'}`}>
      <Canvas
        gl={{ antialias: false, powerPreference: "high-performance" }}
        dpr={[1, 1.5]}
        onPointerMissed={() => {
          if (!isInteractive) return;
          onBackgroundClick();
        }}
      >
        <Suspense fallback={null}>
          <GameCamera
            initialPosition={cameraPosition}
            initialTarget={cameraTarget}
            focusTarget={cameraFocusTarget}
            ready={isScenarioReady}
            mapRadius={mapMetrics.radius}
            mapBounds={mapBounds ?? undefined}
            distanceLimits={distanceLimits}
            enableRotate={allowRotate}
            zoomTargetDistance={zoomTargetDistance ?? undefined}
            onDistanceChange={viewZoom === undefined ? undefined : handleDistanceChange}
            onWorldOriginShift={shiftWorldOrigin}
            worldOriginShiftThreshold={WORLD_ORIGIN_SHIFT_THRESHOLD}
          />
          <group position={[-worldOrigin.x, -worldOrigin.y, -worldOrigin.z]}>
            <ambientLight intensity={0.4} color="#aaccff" />
            <pointLight position={[0, 50, 0]} intensity={1.5} color="#ffffff" />
            {!showSystemLayer && <ParallaxStars />}

            {showGalaxyLayer && (
              <group>
                <TerritoryBorders
                  systems={gameState.systems}
                  signature={ownershipSignature}
                  factions={gameState.factions}
                />

                <Galaxy
                  systems={gameState.systems}
                  fleets={gameState.fleets}
                  factions={gameState.factions}
                  armies={gameState.armies}
                  battlingSystemIds={battlingSystemIds}
                  onSystemClick={handleGalaxySystemClick}
                  playerFactionId={gameState.playerFactionId}
                />

                <TrajectoryRenderer
                  fleets={gameState.fleets}
                  factions={gameState.factions}
                  playerFactionId={gameState.playerFactionId}
                />

                <IntelGhosts
                  sightings={enemySightings}
                  currentDay={gameState.day}
                  visibleFleetIds={visibleFleetIds}
                  getFactionColor={getFactionColor}
                />

                {gameState.fleets.map(fleet => (
                  <FleetMesh
                    key={fleet.id}
                    fleet={fleet}
                    day={gameState.day}
                    isSelected={selectedFleetId === fleet.id}
                    onSelect={(e, isDouble, pointerType) => {
                      e.stopPropagation();
                      handleFleetInteraction(fleet.id, { isDouble, pointerType });
                    }}
                    playerFactionId={gameState.playerFactionId}
                    color={getFactionColor(fleet.factionId)}
                  />
                ))}

                <LaserRenderer lasers={gameState.lasers} />
              </group>
            )}

            {resolvedSystem && (
              <AnimatedScaleGroup
                targetScale={systemScaleTarget}
                position={resolvedSystem.position}
                visible={showSystemLayer}
              >
                <SystemLayer
                  system={resolvedSystem}
                  day={gameState.day}
                  fleets={gameState.fleets}
                  stations={gameState.stations ?? []}
                  factions={gameState.factions}
                  planetSurfaceDescriptorsByBodyId={gameState.planetSurfaceDescriptorsByBodyId}
                  selectedFleetId={selectedFleetId}
                  focusBodyId={resolvedView.focus.bodyId ?? null}
                  onPlanetClick={(planetId) => (onFocusPlanet ?? onFocusSurface)?.(planetId)}
                  onFleetSelect={(fleetId) => handleFleetInteraction(fleetId)}
                />
              </AnimatedScaleGroup>
            )}

            {resolvedSystem && resolvedPlanet && (
              <AnimatedScaleGroup
                targetScale={planetScaleTarget}
                position={resolvedSystem.position}
                visible={showPlanetLayer}
              >
                <PlanetLayer planet={resolvedPlanet} radius={planetRadius} />
                {showSurfaceLayer && (
                  <SurfaceLayer
                    planetRadius={planetRadius}
                    center={offsetVec3(resolvedSystem.position, worldOrigin)}
                    bodyId={resolvedPlanet.id}
                    descriptor={surfaceDescriptor}
                    armies={surfaceArmies}
                    buildings={surfaceBuildings}
                    getFactionColor={getFactionColor}
                    onSelectTile={onSurfaceTileSelect}
                  />
                )}
              </AnimatedScaleGroup>
            )}
          </group>

          <SceneReadyReporter onReady={onReady} />

          <EffectComposer enableNormalPass={false}>
            <Bloom luminanceThreshold={0.2} mipmapBlur intensity={1.2} radius={0.4} />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
};

const GameScene: React.FC<GameSceneProps> = (props) => {
  if (props.viewContext) {
    return <UniverseScene {...props} />;
  }
  return <UniverseScene {...props} />;
};

export default GameScene;
