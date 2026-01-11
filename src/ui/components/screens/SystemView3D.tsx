import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { EffectComposer, Select, SelectiveBloom, Selection, SMAA, Vignette } from '@react-three/postprocessing';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  Color,
  LineBasicMaterial,
  MathUtils,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PointLight,
  SRGBColorSpace,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';
import type {
  AtmosphereType,
  FactionState,
  Fleet,
  GameState,
  MoonType,
  PlanetBody,
  PlanetBodyType,
  PlanetData,
  PlanetType,
  Station,
  StarData,
  StarSystem,
  StarSystemAstro
} from '../../../shared/shared';
import { sorted } from '../../../shared/shared';
import { useI18n } from '../../i18n';
import SystemBodyInfoPanel, { SystemBodyInfo } from '../ui/SystemBodyInfoPanel';
import {
  getSystemFleets,
  hashStringToUnit,
  makeObjectId,
  parseObjectId,
  type TacticalRingConfig,
  type SystemObjectId
} from './systemViewLayout';
import {
  applyDayNightTerminator,
  applyMoonOrbitSpacing,
  applyPlanetOrbitSpacing,
  ATMOSPHERE_PRESETS,
  ATMOSPHERE_SHELL_DISTANCE_BOOST_MAX,
  ATMOSPHERE_SHELL_DISTANCE_FAR_FACTOR,
  ATMOSPHERE_SHELL_DISTANCE_NEAR_FACTOR,
  buildPlanetModel,
  computeFleetRingBaseRadius,
  computeInclinedOrbitPosition,
  computeOrbitAngle,
  createAtmosphereShellMaterial,
  createCloudLayerMaterial,
  createFallbackStarOrbit,
  DAY_NIGHT_NIGHT_MIN,
  DAY_NIGHT_NIGHT_MIN_ATMOSPHERE,
  DAY_NIGHT_TERMINATOR_SOFTNESS,
  DAY_NIGHT_TERMINATOR_SOFTNESS_ATMOSPHERE,
  deriveScatteringCoeffs,
  deriveSphericalState,
  getMoonRadiusKm,
  getMoonType,
  getPlanetRadiusKm,
  getPlanetType,
  getSpectralTint,
  getStarLightIntensityForRadius,
  getSurfaceTintFromTemperature,
  KM_PER_AU,
  KM_TO_SCENE_SCALE,
  MAX_DPR_DESKTOP,
  MAX_DPR_MOBILE,
  MIN_PLANET_RADIUS,
  MIN_STAR_RADIUS,
  MOON_SPIN_REFERENCE_RADIUS_FACTOR,
  MOON_TYPE_COLORS,
  PLANET_SPIN_REFERENCE_RADIUS_FACTOR,
  PLANET_TYPE_COLORS,
  positionFromSpherical,
  POST_FX_MSAA_SAMPLES_DESKTOP,
  POST_FX_MSAA_SAMPLES_MOBILE,
  RADIUS_VISIBILITY_BONUS,
  resolveAirMassIndex,
  resolveThermalTints,
  SOLAR_RADIUS_KM,
  STAR_SPIN_REFERENCE_RADIUS_FACTOR,
  SURFACE_AO_INTENSITY,
  SURFACE_DISPLACEMENT_BIAS,
  SURFACE_DISPLACEMENT_SCALE,
  SURFACE_NORMAL_SCALE,
  SYSTEM_VIEW_FIXED_TERMINATOR,
  OWNER_TINT_STRENGTH,
  SYSTEM_VIEW_CAMERA_MAX_DISTANCE_FACTOR,
  SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR,
  SystemBodyLabels,
  SystemCamera,
  SystemCelestialLayer,
  SystemEntitiesLayer,
  SystemRimLight,
  SystemStarfield,
  SystemSurfaceTextureManager,
  useDisposableMemo
} from './systemView3d';
import type {
  AtmosphereLayerBundle,
  AtmosphereParams,
  BodyLabelTarget,
  CameraSphericalState,
  FocusRequest,
  MoonSource,
  OrbitingMoon,
  OrbitingPlanet,
  OrbitingStar,
  PlanetSource,
  SystemCameraState
} from './systemView3d';

const envMeta =
  typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: { DEV?: boolean } })
    : undefined;

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

interface SystemView3DProps {
  starSystem: StarSystem;
  astro?: StarSystemAstro;
  fleets?: Fleet[];
  stations?: Station[];
  factions?: FactionState[];
  playerFactionId?: string;
  planetSurfaceDescriptorsByBodyId?: GameState['planetSurfaceDescriptorsByBodyId'];
  day?: number;
  selectedFleetId?: string | null;
  onSelectFleet?: (fleetId: string | null) => void;
  onInspectFleet?: (fleetId: string) => void;
  initialCameraState?: SystemCameraState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  scaleFactor?: number;
  showBodyLabels?: boolean;
  fixedTerminator?: boolean;
  onOpenSurfaceView?: (bodyId: string) => void;
  onBack?: () => void;
}

type CelestialBodyType = PlanetBodyType | 'star';

type BodyContextMenuState = {
  bodyId: string;
  position: { x: number; y: number };
};

type AnchorPoint = { x: number; y: number };
type Size = { width: number; height: number };
type ViewportRect = { left: number; top: number; width: number; height: number };
type SafeAreaInsets = { top: number; right: number; bottom: number; left: number };
type PositioningConstraints = {
  anchor: AnchorPoint;
  menuSize: Size;
  viewport: ViewportRect;
  safeInsets: SafeAreaInsets;
  offset: number;
  padding: number;
};

type BodyListItem = {
  id: string;
  name: string;
  kind: 'star' | 'planet' | 'moon';
  subType?: string;
  children?: BodyListItem[];
};
type SurfaceTextureDebugInfo = {
  cacheSize: number;
  inflightSize: number;
  activeBodies: Array<{
    bodyId: string;
    diameterPx: number;
    resolution: { width: number; height: number } | null;
    isOnScreen: boolean;
  }>;
};

const MENU_OFFSET = 12;
const SAFE_PADDING = 8;
const OVERLAY_ID = 'ui-overlay';

const SystemRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <group name="SystemRoot">
    {children}
  </group>
);

const clamp = (value: number, min: number, max: number): number => {
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
};

const computeConstrainedMenuPosition = ({
  anchor,
  menuSize,
  viewport,
  safeInsets,
  offset,
  padding
}: PositioningConstraints): AnchorPoint => {
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;

  const minX = viewport.left + safeInsets.left + padding;
  const minY = viewport.top + safeInsets.top + padding;
  const maxX = viewportRight - safeInsets.right - padding - menuSize.width;
  const maxY = viewportBottom - safeInsets.bottom - padding - menuSize.height;

  let x = anchor.x + offset;
  let y = anchor.y + offset;

  const preferredRight = x + menuSize.width;
  const preferredBottom = y + menuSize.height;

  if (preferredRight > viewportRight - safeInsets.right - padding) {
    x = anchor.x - menuSize.width - offset;
  }

  if (preferredBottom > viewportBottom - safeInsets.bottom - padding) {
    y = anchor.y - menuSize.height - offset;
  }

  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, minY, maxY)
  };
};

const readSafeAreaInsets = (): SafeAreaInsets => {
  if (typeof document === 'undefined') {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const style = window.getComputedStyle(overlay);
  const toNumber = (value: string | null) => {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    top: toNumber(style.paddingTop),
    right: toNumber(style.paddingRight),
    bottom: toNumber(style.paddingBottom),
    left: toNumber(style.paddingLeft)
  };
};

const readViewportRect = (): ViewportRect => {
  if (typeof window === 'undefined') {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const vv = window.visualViewport;
  if (vv) {
    return {
      left: vv.offsetLeft,
      top: vv.offsetTop,
      width: vv.width,
      height: vv.height
    };
  }

  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight
  };
};

const SystemView3D: React.FC<SystemView3DProps> = ({
  starSystem,
  astro,
  fleets = [],
  stations = [],
  factions = [],
  planetSurfaceDescriptorsByBodyId,
  day = 0,
  selectedFleetId = null,
  onSelectFleet,
  initialCameraState,
  onCameraStateChange,
  scaleFactor = 1,
  showBodyLabels = true,
  fixedTerminator = SYSTEM_VIEW_FIXED_TERMINATOR,
  onOpenSurfaceView,
  onBack
}) => {
  const { t } = useI18n();
  const showSurfaceDebug = useMemo(() => {
    if (!envMeta?.env?.DEV) return false;
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('surfaceDebug') === '1';
  }, []);
  const prefersTouchFallback = typeof window !== 'undefined' && (
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    || (typeof window.matchMedia !== 'function' && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
  const clampedScale = Math.max(scaleFactor, 0.1);
  const sceneScale = KM_TO_SCENE_SCALE * clampedScale;
  const minPlanetRadius = MIN_PLANET_RADIUS * clampedScale;
  const minMoonRadius = minPlanetRadius / 3;
  const minStarRadius = MIN_STAR_RADIUS * clampedScale;
  const planetSpinReferenceRadius = minPlanetRadius * PLANET_SPIN_REFERENCE_RADIUS_FACTOR;
  const moonSpinReferenceRadius = minMoonRadius * MOON_SPIN_REFERENCE_RADIUS_FACTOR;
  const starSpinReferenceRadius = minStarRadius * STAR_SPIN_REFERENCE_RADIUS_FACTOR;
  // Visual padding to keep planets and the star clearly separated; tune to adjust orbit spacing.
  const planetOrbitClearance = Math.max(minPlanetRadius * 2, clampedScale * 0.75);
  const moonOrbitClearance = Math.max(minMoonRadius * 2, clampedScale * 0.35);
  const focusDistanceFloor = 2.5 * clampedScale;
  const baseCameraDistance = 12 * clampedScale;
  const defaultCameraPosition = useMemo<[number, number, number]>(
    () => [0, 6 * clampedScale, 12 * clampedScale],
    [clampedScale]
  );
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
        ? `${starSystem.id}-star-primary`
        : `${starSystem.id}-star-companion-${index}`;
      const radiusKm = Math.max((star.radiusSun ?? 1) * SOLAR_RADIUS_KM, 1);
      const radius = Math.max(radiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minStarRadius);
      const spectralType = star.spectralType ?? astro?.primarySpectralType;
      const tintColor = getSpectralTint(spectralType, starSystem.color || '#ffffff');
      const surfaceTintColor = getSurfaceTintFromTemperature(star.teffK, tintColor);
      const seedKey = `${starSystem.id}-star-${index + 1}`;
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
  }, [astro?.primarySpectralType, astro?.stars, day, minStarRadius, sceneScale, starSystem.color, starSystem.id]);
  const primaryStar = starModels[0];
  const starBodyId = primaryStar?.id ?? `${starSystem.id}-star-primary`;
  const starRadius = primaryStar?.radius ?? minStarRadius;
  const starTintColor = primaryStar?.tintColor ?? getSpectralTint(astro?.primarySpectralType, starSystem.color || '#ffffff');
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
  }, [astro?.planets, moonBodiesByPlanetIndex, planetBodies, starSystem.id]);

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
      color: '#334155',
      transparent: true,
      opacity: 0.75,
      depthTest: false,
      depthWrite: false
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
  const atmosphereBundleByBodyIdRef = useRef<Map<string, AtmosphereBundleCacheEntry>>(new Map());
  const disposeAtmosphereBundle = useCallback((bundle: AtmosphereLayerBundle) => {
    bundle.shell.material.dispose();
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
    const cacheKey = `${shellKey}|${cloudsKey}`;

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
    starSystem.planets.forEach(body => {
      const ownerId = body.ownerFactionId ?? null;
      out[body.id] = ownerId ? (factionById.get(ownerId)?.color ?? '#ffffff') : '#ffffff';
    });
    return out;
  }, [factionById, starSystem.planets]);

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

  const starGeometry = useDisposableMemo(() => new SphereGeometry(1, 64, 64), []);
  const planetGeometry = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, 96, 96);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, []);
  const planetGeometryHigh = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, 128, 128);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, []);
  const moonGeometry = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, 64, 64);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, []);
  const moonGeometryHigh = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, 96, 96);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
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
  const resolvedAnchoredBodyId = useMemo(() => {
    if (initialCameraState?.anchoredBodyId && bodyWorldPositions[initialCameraState.anchoredBodyId]) {
      return initialCameraState.anchoredBodyId;
    }
    return starBodyId;
  }, [bodyWorldPositions, initialCameraState?.anchoredBodyId, starBodyId]);
  const [anchoredBodyId, setAnchoredBodyId] = useState<string | undefined>(resolvedAnchoredBodyId);
  const bodyInfoMap = useMemo<Record<string, SystemBodyInfo>>(() => {
    const map: Record<string, SystemBodyInfo> = {};
    const hasMultipleStars = starModels.length > 1;
    starModels.forEach((star, index) => {
      const suffix = String.fromCharCode(65 + index);
      const starName = hasMultipleStars
        ? t('systemView.bodyInfo.starNameWithSuffix', { system: starSystem.name, suffix })
        : t('systemView.bodyInfo.starName', { system: starSystem.name });
      map[star.id] = {
        id: star.id,
        name: starName,
        bodyType: 'star' as CelestialBodyType,
        bodySubType: star.data.spectralType ?? astro?.primarySpectralType,
        radiusKm: star.radiusKm,
        isSolid: false
      };
    });

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
        const moonName = moon.name ?? t('moon.name', { index: moonIndex + 1 });
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
  }, [astro?.primarySpectralType, sourcePlanets, starModels, starSystem.id, starSystem.name, t]);
  const systemFleets = useMemo(() => getSystemFleets(starSystem, fleets), [fleets, starSystem]);
  const systemStations = useMemo(
    () => stations.filter((station) => station.systemId === starSystem.id),
    [stations, starSystem.id]
  );
  const fleetById = useMemo(() => new Map(systemFleets.map((fleet) => [fleet.id, fleet])), [systemFleets]);

  const [hoveredObjectId, setHoveredObjectId] = useState<SystemObjectId | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<SystemObjectId | null>(null);
  const [bodyContextMenu, setBodyContextMenu] = useState<BodyContextMenuState | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuConstraints, setContextMenuConstraints] = useState<{ maxHeight?: number; maxWidth?: number }>({});
  const [infoBodyId, setInfoBodyId] = useState<string | null>(null);
  const [isBodyListOpen, setIsBodyListOpen] = useState(false);
  const [closeUpBodyId, setCloseUpBodyId] = useState<string | null>(null);
  const [surfaceDebug, setSurfaceDebug] = useState<SurfaceTextureDebugInfo | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

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

  const selectedBodyId = useMemo(() => {
    const parsed = parseObjectId(selectedObjectId);
    return parsed?.kind === 'body' ? parsed.id : null;
  }, [selectedObjectId]);
  const hoveredBodyId = useMemo(() => {
    const parsed = parseObjectId(hoveredObjectId);
    return parsed?.kind === 'body' ? parsed.id : null;
  }, [hoveredObjectId]);
  const infoBody = infoBodyId ? bodyInfoMap[infoBodyId] : null;
  const highDetailBodyId = selectedBodyId ?? hoveredBodyId ?? closeUpBodyId ?? null;

  const handleHoverBody = useCallback((bodyId: string) => {
    setHoveredObjectId(makeObjectId('body', bodyId));
  }, []);
  const handleBlurBody = useCallback((bodyId: string) => {
    const objectId = makeObjectId('body', bodyId);
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectBody = useCallback((bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => {
    const body = bodyInfoMap[bodyId];
    setSelectedObjectId(makeObjectId('body', bodyId));
    onSelectFleet?.(null);
    if (!body || body.bodyType === 'star') {
      setBodyContextMenu(null);
      return;
    }
    setBodyContextMenu({ bodyId, position: { x: event.clientX, y: event.clientY } });
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
    setInfoBodyId(null);
  }, [bodyInfoMap, onSelectFleet]);
  const handleHoverObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(objectId);
  }, []);
  const handleBlurObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectObject = useCallback((objectId: SystemObjectId) => {
    setSelectedObjectId(objectId);
    setBodyContextMenu(null);
    const parsed = parseObjectId(objectId);
    if (parsed?.kind === 'fleet') {
      onSelectFleet?.(parsed.id);
    } else {
      onSelectFleet?.(null);
    }
  }, [onSelectFleet]);
  const closeBodyContextMenu = useCallback(() => {
    setBodyContextMenu(null);
    setContextMenuPosition(null);
  }, []);
  const handleBodyPressStart = useCallback((_bodyId: string, _event: ThreeEvent<PointerEvent>) => {}, []);
  const handleBodyPressMove = useCallback((_event: ThreeEvent<PointerEvent>) => {}, []);
  const handleBodyPressEnd = useCallback(() => {}, []);
  const handleBodyPressCancel = useCallback(() => {}, []);
  const recalcContextMenuPosition = useCallback(() => {
    if (!bodyContextMenu || !contextMenuRef.current) return;
    const viewport = readViewportRect();
    const safeInsets = readSafeAreaInsets();
    const rect = contextMenuRef.current.getBoundingClientRect();
    const constrained = computeConstrainedMenuPosition({
      anchor: bodyContextMenu.position,
      menuSize: { width: rect.width, height: rect.height },
      viewport,
      safeInsets,
      offset: MENU_OFFSET,
      padding: SAFE_PADDING
    });
    setContextMenuPosition(constrained);

    const maxHeight = Math.max(SAFE_PADDING, viewport.height - safeInsets.top - safeInsets.bottom - (SAFE_PADDING * 2));
    const maxWidth = Math.max(SAFE_PADDING, viewport.width - safeInsets.left - safeInsets.right - (SAFE_PADDING * 2));
    setContextMenuConstraints({ maxHeight, maxWidth });
  }, [bodyContextMenu]);
  const contextMenuBody = bodyContextMenu ? bodyInfoMap[bodyContextMenu.bodyId] : null;
  const contextMenuSurfaceTarget = contextMenuBody?.surfaceBodyId ?? contextMenuBody?.id ?? null;
  const canViewSurface = Boolean(
    onOpenSurfaceView
    && contextMenuBody
    && contextMenuBody.bodyType !== 'star'
    && (contextMenuBody.isSolid ?? true)
  );
  const contextMenuTitleId = useMemo(
    () => (bodyContextMenu ? `system-body-context-${bodyContextMenu.bodyId}` : 'system-body-context'),
    [bodyContextMenu]
  );
  useLayoutEffect(() => {
    if (!bodyContextMenu) return;
    recalcContextMenuPosition();
  }, [bodyContextMenu, canViewSurface, contextMenuBody, recalcContextMenuPosition]);
  useEffect(() => {
    if (!bodyContextMenu || !contextMenuRef.current) return;
    const observer = new ResizeObserver(() => recalcContextMenuPosition());
    observer.observe(contextMenuRef.current);
    return () => observer.disconnect();
  }, [bodyContextMenu, recalcContextMenuPosition]);
  useEffect(() => {
    if (!bodyContextMenu) return;
    const handleViewportChange = () => recalcContextMenuPosition();
    window.addEventListener('resize', handleViewportChange);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', handleViewportChange);
    vv?.addEventListener('scroll', handleViewportChange);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      vv?.removeEventListener('resize', handleViewportChange);
      vv?.removeEventListener('scroll', handleViewportChange);
    };
  }, [bodyContextMenu, recalcContextMenuPosition]);
  useEffect(() => {
    if (!bodyContextMenu) return;
    contextMenuRef.current?.focus();
  }, [bodyContextMenu]);
  useEffect(() => {
    if (!bodyContextMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const menu = contextMenuRef.current;
      if (menu && menu.contains(event.target as Node)) return;
      closeBodyContextMenu();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [bodyContextMenu, closeBodyContextMenu]);
  useEffect(() => {
    if (!bodyContextMenu && !infoBodyId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeBodyContextMenu();
      setInfoBodyId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [bodyContextMenu, closeBodyContextMenu, infoBodyId]);
  const getFactionColor = useCallback(
    (id: string) => factionById.get(id)?.color ?? '#94a3b8',
    [factionById]
  );
  useEffect(() => {
    setHoveredObjectId(null);
    setSelectedObjectId(null);
    setIsBodyListOpen(false);
    setCloseUpBodyId(null);
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
  const cameraMaxDistance = Math.max(maxOrbitRadius * SYSTEM_VIEW_CAMERA_MAX_DISTANCE_FACTOR, baseCameraDistance);
  const ambientLightIntensity = MathUtils.clamp(0.05 + clampedScale * 0.02, 0.05, 0.15);
  const starLightDistance = Math.max(maxOrbitRadius * 8, starRadius * 60);
  const starLightIntensity = useMemo(() => getStarLightIntensityForRadius(starRadius), [starRadius]);
  const ambientLightColor = useMemo(
    () => new Color(starTintColor).lerp(new Color('#0b1020'), 0.7).getStyle(),
    [starTintColor]
  );
  const starLightColor = useMemo(
    () => new Color('#ffffff').lerp(new Color(starTintColor), 0.2).getStyle(),
    [starTintColor]
  );
  useEffect(() => {
    sunColorRef.current.set(starLightColor);
  }, [starLightColor]);
  const companionStarLights = useMemo(() => (
    starModels.slice(1).map((star) => ({
      id: star.id,
      position: star.position,
      intensity: getStarLightIntensityForRadius(star.radius),
      color: new Color('#ffffff').lerp(new Color(star.tintColor), 0.2).getStyle()
    }))
  ), [starModels]);
  const starIdSet = useMemo(() => new Set(starModels.map(star => star.id)), [starModels]);
  const cameraZoomConstraints = useMemo(() => {
    const anchorId = anchoredBodyId ?? starBodyId;
    const anchoredRadius = bodyRadii[anchorId];
    const effectiveRadius = typeof anchoredRadius === 'number' ? anchoredRadius : focusDistanceFloor;
    const isStarAnchor = starIdSet.has(anchorId);
    const minRadiusDistance = effectiveRadius * SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR;
    const minDistance = isStarAnchor ? Math.max(focusDistanceFloor, minRadiusDistance) : minRadiusDistance;
    return {
      minDistance,
      effectiveRadius,
      surfaceClearance: Math.max(minDistance - effectiveRadius, 0.0001 * clampedScale),
      isStarAnchor
    };
  }, [anchoredBodyId, bodyRadii, clampedScale, focusDistanceFloor, starBodyId, starIdSet]);
  const cameraMinDistance = cameraZoomConstraints.minDistance;
  const rotateSpeed = MathUtils.clamp(1 / clampedScale, 0.35, 2.5);
  const zoomSpeed = MathUtils.clamp(1 / clampedScale, 0.4, 3);
  const cameraFar = cameraMaxDistance + maxOrbitRadius * 2.5;
  const cameraNear = cameraZoomConstraints.isStarAnchor
    ? Math.max(0.05, Math.min(cameraMinDistance * 0.25, cameraFar / 2000))
    : Math.max(0.001 * clampedScale, Math.min(cameraZoomConstraints.surfaceClearance * 0.5, cameraFar / 20000));
  const starfieldRadius = Math.max(cameraFar * 0.9, maxOrbitRadius * 4);
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
  const bodyListItems = useMemo<BodyListItem[]>(() => {
    const planetItems: BodyListItem[] = planets.map((planet) => ({
      id: planet.id,
      name: bodyInfoMap[planet.id]?.name ?? planet.id,
      kind: 'planet',
      subType: bodyInfoMap[planet.id]?.bodySubType,
      children: planet.moons.map((moon) => ({
        id: moon.id,
        name: bodyInfoMap[moon.id]?.name ?? moon.id,
        kind: 'moon',
        subType: bodyInfoMap[moon.id]?.bodySubType
      }))
    }));
    return starModels.map((star, index) => ({
      id: star.id,
      name: bodyInfoMap[star.id]?.name ?? star.id,
      kind: 'star',
      subType: bodyInfoMap[star.id]?.bodySubType,
      children: index === 0 ? planetItems : undefined
    }));
  }, [bodyInfoMap, planets, starModels]);
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
  const handleNavigateToBody = useCallback((bodyId: string) => {
    setSelectedObjectId(makeObjectId('body', bodyId));
    setBodyContextMenu(null);
    onSelectFleet?.(null);
    requestFocusOnBody(bodyId);
  }, [onSelectFleet, requestFocusOnBody]);
  const initialCameraPosition = useMemo<[number, number, number]>(() => (
    positionFromSpherical(cameraInitialSpherical, anchoredTarget)
  ), [
    anchoredTarget,
    cameraInitialSpherical.phi,
    cameraInitialSpherical.radius,
    cameraInitialSpherical.theta
  ]);

  const lowSpec = prefersTouchFallback;
  const hitboxScaleMultiplier = prefersTouchFallback ? 1.2 : 1;
  const [rendererCaps, setRendererCaps] = useState(() => ({
    contextAntialias: false,
    isWebGL2: false,
    maxSamples: 0
  }));
  const wantsBloom = !lowSpec;
  const wantsVignette = !lowSpec;
  const enablePostFX = wantsBloom || wantsVignette || !rendererCaps.contextAntialias;
  const enableShadows = !lowSpec;
  const enableAntialias = true;
  const maxDpr = prefersTouchFallback ? MAX_DPR_MOBILE : MAX_DPR_DESKTOP;
  const toneMappingExposure = prefersTouchFallback ? 0.8 : 0.75;
  const shadowMapSize = prefersTouchFallback ? 512 : 1024;
  const shadowCameraFar = Math.max(maxOrbitRadius * 2.2, starRadius * 120);
  const shadowCameraNear = Math.max(0.02 * clampedScale, 0.005);
  const postFxMultisampling = useMemo(() => {
    if (!enablePostFX || !rendererCaps.isWebGL2) return 0;
    const targetSamples = prefersTouchFallback ? POST_FX_MSAA_SAMPLES_MOBILE : POST_FX_MSAA_SAMPLES_DESKTOP;
    const maxSamples = rendererCaps.maxSamples || targetSamples;
    return Math.min(targetSamples, maxSamples);
  }, [enablePostFX, prefersTouchFallback, rendererCaps.isWebGL2, rendererCaps.maxSamples]);
  const enableSmaa = enablePostFX && postFxMultisampling === 0;
  const bloomIntensity = prefersTouchFallback ? 0.14 : 0.25;
  const bloomThreshold = prefersTouchFallback ? 0.7 : 0.65;
  const bloomSmoothing = prefersTouchFallback ? 0.65 : 0.6;
  const bloomRadius = prefersTouchFallback ? 0.12 : 0.18;
  const vignetteOffset = prefersTouchFallback ? 0.68 : 0.62;
  const vignetteDarkness = prefersTouchFallback ? 0.14 : 0.2;
  const cloudShadowStrengthScale = prefersTouchFallback ? 0.2 : 1;
  const rimLightIntensity = prefersTouchFallback ? 0.12 : 0.18;
  const rimLightDistance = Math.max(cameraFar * 0.8, maxOrbitRadius * 3.2);
  const rimLightColor = useMemo(
    () => new Color('#e6ecff').lerp(new Color(starTintColor), 0.3).getStyle(),
    [starTintColor]
  );
  const ambientLightRef = useRef<AmbientLight>(null);
  const starLightRef = useRef<PointLight>(null);
  const [bloomLightsReady, setBloomLightsReady] = useState(false);
  useEffect(() => {
    if (bloomLightsReady) return;
    if (starLightRef.current) {
      setBloomLightsReady(true);
    }
  }, [bloomLightsReady]);
  const bloomLights = useMemo(() => {
    if (!bloomLightsReady) return [];
    return [starLightRef.current].filter(Boolean) as Object3D[];
  }, [bloomLightsReady]);
  const isTouchUi = prefersTouchFallback;
  const contextMenuContainerClass = `pointer-events-auto fixed z-40 rounded border border-slate-700 bg-slate-900/95 p-2 text-white shadow-2xl backdrop-blur overflow-y-auto overscroll-contain ${
    isTouchUi ? 'min-w-[210px] text-base' : 'min-w-[180px] text-sm'
  }`;
  const contextMenuButtonBaseClass = isTouchUi
    ? 'w-full rounded px-3 py-3 text-left text-base font-semibold'
    : 'w-full rounded px-2 py-2 text-left text-sm font-semibold';
  const contextMenuHeaderClass = isTouchUi
    ? 'px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400'
    : 'px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400';
  const resolveBodyListTypeLabel = useCallback((item: BodyListItem): string => {
    if (item.kind === 'star') {
      return item.subType ?? t('systemView.bodyInfo.bodyType.star');
    }
    if (item.subType) {
      return t(`systemView.bodySubType.${item.kind}.${item.subType}`, { defaultValue: item.subType });
    }
    return t(`systemView.bodyInfo.bodyType.${item.kind}`);
  }, [t]);
  const renderBodyRow = (item: BodyListItem, depth: number) => {
    const isSelected = selectedBodyId === item.id;
    const bodyTypeLabel = resolveBodyListTypeLabel(item);
    const dotClass = item.kind === 'star'
      ? 'bg-amber-400'
      : item.kind === 'planet'
        ? 'bg-sky-400'
        : 'bg-slate-400';
    const paddingLeft = 10 + depth * 14;

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => handleNavigateToBody(item.id)}
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm transition ${
          isSelected ? 'bg-slate-700/80 text-white' : 'text-slate-200 hover:bg-slate-700/60 hover:text-white'
        }`}
        style={{ paddingLeft }}
        aria-pressed={isSelected}
      >
        <span className={`h-2 w-2 flex-none rounded-full ${dotClass}`} />
        <span className="flex-1 truncate">{item.name}</span>
        <span className="text-[10px] uppercase tracking-wide text-slate-500">{bodyTypeLabel}</span>
      </button>
    );
  };

  return (
    <div className="relative w-full h-full bg-black">
      <Canvas
        shadows={enableShadows}
        onCreated={({ gl }) => {
          gl.shadowMap.type = PCFSoftShadowMap;
          gl.outputColorSpace = SRGBColorSpace;
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = toneMappingExposure;
          const context = gl.getContext();
          const attributes = context.getContextAttributes?.();
          const nextCaps = {
            contextAntialias: Boolean(attributes?.antialias),
            isWebGL2: gl.capabilities.isWebGL2,
            maxSamples: gl.capabilities.maxSamples ?? 0
          };
          setRendererCaps((prev) => (
            prev.contextAntialias === nextCaps.contextAntialias
            && prev.isWebGL2 === nextCaps.isWebGL2
            && prev.maxSamples === nextCaps.maxSamples
              ? prev
              : nextCaps
          ));
        }}
        camera={{ position: initialCameraPosition, fov: 55, near: cameraNear, far: cameraFar }}
        gl={{
          antialias: enableAntialias,
          depth: true,
          stencil: false,
          powerPreference: lowSpec ? 'low-power' : 'high-performance'
        }}
        dpr={[1, maxDpr]}
      >
        <color attach="background" args={['#000000']} />
        <SystemStarfield
          radius={starfieldRadius}
          seedKey={`${starSystem.id}-${astroKey}-starfield`}
          tintColor={starTintColor}
        />
        <SystemRimLight
          intensity={rimLightIntensity}
          color={rimLightColor}
          distance={rimLightDistance}
          target={anchoredTarget}
        />
        <ambientLight ref={ambientLightRef} intensity={ambientLightIntensity} color={ambientLightColor} />
        <pointLight
          ref={starLightRef}
          position={primaryStar?.position ?? [0, 0, 0]}
          intensity={starLightIntensity}
          distance={starLightDistance}
          decay={2}
          color={starLightColor}
          castShadow={enableShadows}
          shadow-mapSize={[shadowMapSize, shadowMapSize]}
          shadow-camera-near={shadowCameraNear}
          shadow-camera-far={shadowCameraFar}
          shadow-bias={-0.00015}
          shadow-normalBias={0.02}
        />
        {companionStarLights.map((light) => (
          <pointLight
            key={light.id}
            position={light.position}
            intensity={light.intensity}
            distance={starLightDistance}
            decay={2}
            color={light.color}
            castShadow={false}
          />
        ))}

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

        <Selection>
          <Select enabled>
            <SystemRoot>
              <SystemSurfaceTextureManager
                starSystem={starSystem}
                astroKey={astroKey}
                planetSurfaceDescriptorsByBodyId={planetSurfaceDescriptorsByBodyId ?? undefined}
                ownerColorByBodyId={ownerColorByBodyId}
                planets={planets}
                bodyWorldPositions={bodyWorldPositions}
                bodyRadii={bodyRadii}
                selectedBodyId={selectedBodyId}
                hoveredBodyId={hoveredBodyId}
                lowSpec={lowSpec}
                cloudShadowStrengthScale={cloudShadowStrengthScale}
                debugEnabled={showSurfaceDebug}
                onDebugUpdate={showSurfaceDebug ? setSurfaceDebug : undefined}
                onCloseUpBodyIdChange={setCloseUpBodyId}
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
                fixedTerminator={fixedTerminator}
                hitboxScaleMultiplier={hitboxScaleMultiplier}
                sunPosition={sunPosition}
                onBodyPressStart={handleBodyPressStart}
                onBodyPressMove={handleBodyPressMove}
                onBodyPressEnd={handleBodyPressEnd}
                onBodyPressCancel={handleBodyPressCancel}
                onFocusBody={requestFocusOnBody}
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
          </Select>
          {enablePostFX && (
            <EffectComposer enableNormalPass={false} multisampling={postFxMultisampling}>
              {enableSmaa && <SMAA />}
              {wantsBloom && bloomLightsReady && (
                <SelectiveBloom
                  intensity={bloomIntensity}
                  mipmapBlur={!prefersTouchFallback}
                  radius={bloomRadius}
                  luminanceThreshold={bloomThreshold}
                  luminanceSmoothing={bloomSmoothing}
                  lights={bloomLights}
                />
              )}
              {wantsVignette && <Vignette offset={vignetteOffset} darkness={vignetteDarkness} />}
            </EffectComposer>
          )}
        </Selection>
      </Canvas>
      <div className="pointer-events-none absolute left-4 top-4 z-40 flex items-center gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="pointer-events-auto rounded-full border border-slate-700 bg-slate-900/80 p-2 text-white shadow transition hover:border-slate-400 hover:bg-slate-800"
            aria-label={t('systemView.backToGalaxy')}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
              <path
                fillRule="evenodd"
                d="M12.78 4.22a.75.75 0 010 1.06L7.06 11H20a.75.75 0 010 1.5H7.06l5.72 5.72a.75.75 0 11-1.06 1.06l-7-7a.75.75 0 010-1.06l7-7a.75.75 0 011.06 0z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
        <div className="pointer-events-auto relative">
          {isBodyListOpen ? (
            <div className="absolute left-0 top-full mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-slate-700 bg-slate-900/90 shadow-2xl backdrop-blur">
              <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  {t('systemView.bodyList.title')}
                </div>
                <button
                  type="button"
                  onClick={() => setIsBodyListOpen(false)}
                  className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-200 transition hover:border-slate-500 hover:bg-slate-700"
                  aria-label={t('systemView.bodyList.close')}
                >
                  {t('systemView.bodyList.close')}
                </button>
              </div>
              <div className="max-h-[65vh] overflow-y-auto px-2 py-2">
                {bodyListItems.map((star) => (
                  <div key={star.id} className="space-y-1">
                    {renderBodyRow(star, 0)}
                    {star.children?.map((planet) => (
                      <div key={planet.id} className="space-y-1">
                        {renderBodyRow(planet, 1)}
                        {planet.children?.map((moon) => (
                          <div key={moon.id}>{renderBodyRow(moon, 2)}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsBodyListOpen(true)}
              className="rounded-full border border-slate-700 bg-slate-900/85 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-200 shadow transition hover:border-slate-500 hover:bg-slate-800"
              aria-label={t('systemView.bodyList.open')}
            >
              {t('systemView.bodyList.open', { system: starSystem.name })}
            </button>
          )}
        </div>
      </div>
      {showSurfaceDebug && surfaceDebug && (
        <div className="pointer-events-none absolute right-4 top-4 z-40 rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-[11px] text-slate-100 shadow-lg">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Surface Textures
          </div>
          <div className="flex gap-3 text-slate-200">
            <span>cache: {surfaceDebug.cacheSize}</span>
            <span>inflight: {surfaceDebug.inflightSize}</span>
          </div>
          <div className="mt-2 space-y-1 text-slate-300">
            {surfaceDebug.activeBodies.map((body) => (
              <div key={body.bodyId} className="flex items-center gap-2">
                <span className="min-w-[90px] truncate">{body.bodyId}</span>
                <span className="text-slate-500">{Math.round(body.diameterPx)}px</span>
                <span className="text-slate-400">
                  {body.resolution ? `${body.resolution.width}x${body.resolution.height}` : 'off'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {bodyContextMenu && contextMenuBody && (contextMenuPosition ?? bodyContextMenu.position) && (
        <div
          ref={contextMenuRef}
          role="dialog"
          aria-labelledby={contextMenuTitleId}
          tabIndex={-1}
          className={contextMenuContainerClass}
          style={{
            left: (contextMenuPosition ?? bodyContextMenu.position).x,
            top: (contextMenuPosition ?? bodyContextMenu.position).y,
            maxHeight: contextMenuConstraints.maxHeight,
            maxWidth: contextMenuConstraints.maxWidth
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            closeBodyContextMenu();
          }}
        >
          <div id={contextMenuTitleId} className={contextMenuHeaderClass}>
            {contextMenuBody.name}
          </div>
          <button
            type="button"
            onClick={() => {
              setInfoBodyId(contextMenuBody.id);
              closeBodyContextMenu();
            }}
            className={`${contextMenuButtonBaseClass} text-slate-200 transition hover:bg-slate-700/60 hover:text-white`}
          >
            {t('systemView.bodyInfo.title')}
          </button>
          {canViewSurface && contextMenuSurfaceTarget && (
            <button
              type="button"
              onClick={() => {
                onOpenSurfaceView?.(contextMenuSurfaceTarget);
                closeBodyContextMenu();
              }}
              className={`mt-1 ${contextMenuButtonBaseClass} text-emerald-200 transition hover:bg-emerald-700/30 hover:text-white`}
            >
              {t('systemView.bodyInfo.viewSurface')}
            </button>
          )}
        </div>
      )}
      {infoBody && (
        <div className="pointer-events-none absolute inset-0">
          <div
            className="pointer-events-auto absolute inset-0"
            onPointerDown={() => setInfoBodyId(null)}
          />
          <div
            className="pointer-events-auto absolute right-4 top-4 w-80 max-w-[calc(100%-2rem)]"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SystemBodyInfoPanel
              body={infoBody}
              isSelected
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default SystemView3D;
