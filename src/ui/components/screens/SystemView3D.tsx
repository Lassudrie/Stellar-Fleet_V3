import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3
} from 'three';
import {
  MoonData,
  MoonType,
  PlanetData,
  PlanetType,
  PlanetBodyType,
  StarSystem,
  StarSystemAstro
} from '../../../shared/types';
import { useI18n } from '../../i18n';
import SystemBodyInfoPanel, { SystemBodyInfo } from '../ui/SystemBodyInfoPanel';

interface SystemView3DProps {
  starSystem: StarSystem;
  astro?: StarSystemAstro;
  initialCameraState?: SystemCameraState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  scaleFactor?: number;
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
};

type MoonSource = MoonData & {
  radiusKm?: number;
  moonType?: MoonType;
  orbitDistanceKm?: number;
  habitabilityScore?: number;
};

type UseMemoDisposableDeps = React.DependencyList;

type CelestialBodyType = PlanetBodyType | 'star';

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
    return {
      id: `${planetId}-moon-${moonIndex + 1}`,
      radius: Math.max(moonRadiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minMoonRadius),
      orbitRadius: moonOrbitRadius,
      orbitAngle: moonAngle,
      type: getMoonType(moon as MoonSource)
    };
  });

  return { id: planetId, radius, orbitRadius, orbitAngle, type: planetType, moons };
};

const SystemRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <group name="SystemRoot">
    {children}
  </group>
);

interface StarMeshProps {
  radius: number;
  color: string;
  geometry: SphereGeometry;
  onDoubleClick?: (event: ThreeEvent<MouseEvent>) => void;
  onHover?: () => void;
  onBlur?: () => void;
  onSelect?: () => void;
}

const StarMesh: React.FC<StarMeshProps> = ({ radius, color, geometry, onDoubleClick, onHover, onBlur, onSelect }) => {
  const material = useDisposableMemo(
    () => new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.85,
      roughness: 0.4,
      metalness: 0.12
    }),
    [color]
  );

  const scale = useMemo<[number, number, number]>(() => [radius, radius, radius], [radius]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={scale}
      onDoubleClick={onDoubleClick}
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
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(moon.orbitRadius - orbitThickness, 0.0025), moon.orbitRadius + orbitThickness, 96),
    [moon.orbitRadius, orbitThickness]
  );
  const orbitRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const moonPosition = useMemo<[number, number, number]>(
    () => computeOrbitPosition(moon.orbitRadius, moon.orbitAngle),
    [moon.orbitAngle, moon.orbitRadius]
  );
  const moonScale = useMemo<[number, number, number]>(() => [moon.radius, moon.radius, moon.radius], [moon.radius]);

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <mesh
        geometry={moonGeometry}
        material={moonMaterial}
        position={moonPosition}
        scale={moonScale}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFocus(moon.id);
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

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <group position={planetPosition}>
        <mesh
          geometry={planetGeometry}
          material={planetMaterial}
          scale={planetScale}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onFocus(planet.id);
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

export type SystemCameraState = {
  position: [number, number, number];
  target: [number, number, number];
  anchoredBodyId?: string;
};

type FocusRequest = {
  target: Vector3;
  distance: number;
};

const SystemCamera: React.FC<{
  maxDistance: number;
  focusRequest: React.MutableRefObject<FocusRequest | null>;
  initialState?: SystemCameraState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  lastCameraStateRef: React.MutableRefObject<SystemCameraState>;
  anchoredTarget: [number, number, number];
  anchoredBodyId?: string;
}> = ({
  maxDistance,
  focusRequest,
  initialState,
  onCameraStateChange,
  lastCameraStateRef,
  anchoredTarget,
  anchoredBodyId
}) => {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();
  const initialTarget = useMemo<[number, number, number]>(() => initialState?.target ?? [0, 0, 0], [
    initialState?.target?.[0],
    initialState?.target?.[1],
    initialState?.target?.[2]
  ]);
  const initialPosition = useMemo<[number, number, number]>(() => initialState?.position ?? [0, 6, 12], [
    initialState?.position?.[0],
    initialState?.position?.[1],
    initialState?.position?.[2]
  ]);
  const targetRef = useRef<Vector3>(new Vector3(...initialTarget));
  const desiredTargetRef = useRef<Vector3>(targetRef.current.clone());
  const initialDistance = useMemo(() => {
    const distance = new Vector3(...initialPosition).distanceTo(new Vector3(...initialTarget));
    return distance || maxDistance * 0.6;
  }, [initialPosition, initialTarget, maxDistance]);
  const desiredDistanceRef = useRef<number>(initialDistance);
  const workingVector = useMemo(() => new Vector3(), []);

  useEffect(() => {
    camera.position.set(...initialPosition);
    targetRef.current.set(...initialTarget);
    desiredTargetRef.current.copy(targetRef.current);
    desiredDistanceRef.current = initialDistance;
    controlsRef.current?.target.copy(targetRef.current);
    controlsRef.current?.update();
    lastCameraStateRef.current = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [targetRef.current.x, targetRef.current.y, targetRef.current.z],
      anchoredBodyId
    };
  }, [anchoredBodyId, camera, initialDistance, initialPosition, initialTarget, lastCameraStateRef]);

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

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const pendingFocus = focusRequest.current;
    if (pendingFocus) {
      desiredTargetRef.current.copy(pendingFocus.target);
      desiredDistanceRef.current = Math.min(pendingFocus.distance, maxDistance);
      focusRequest.current = null;
    }

    const lerpAlpha = 1 - Math.exp(-6 * delta);
    targetRef.current.lerp(desiredTargetRef.current, lerpAlpha);

    const currentDirection = workingVector.copy(camera.position).sub(targetRef.current);
    const currentDistance = currentDirection.length();
    const nextDistance = MathUtils.damp(currentDistance, desiredDistanceRef.current, 8, delta);
    const clampedDistance = Math.min(nextDistance, maxDistance);

    const nextPosition = currentDirection.setLength(clampedDistance).add(targetRef.current);
    camera.position.copy(nextPosition);
    controls.target.copy(targetRef.current);
    controls.enableDamping = true;
    controls.dampingFactor = 0.2;
    controls.maxDistance = maxDistance;
    controls.update();

    lastCameraStateRef.current = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [targetRef.current.x, targetRef.current.y, targetRef.current.z],
      anchoredBodyId
    };
  });

  return <OrbitControls ref={controlsRef} />;
};

const SystemView3D: React.FC<SystemView3DProps> = ({
  starSystem,
  astro,
  initialCameraState,
  onCameraStateChange,
  scaleFactor = 1
}) => {
  const { t } = useI18n();
  const clampedScale = Math.max(scaleFactor, 0.1);
  const sceneScale = KM_TO_SCENE_SCALE * clampedScale;
  const orbitThickness = ORBIT_THICKNESS * clampedScale;
  const minPlanetRadius = MIN_PLANET_RADIUS * clampedScale;
  const minMoonRadius = minPlanetRadius / 3;
  const minStarRadius = MIN_STAR_RADIUS * clampedScale;
  const focusDistanceFloor = 2.5 * clampedScale;
  const baseCameraDistance = 12 * clampedScale;
  const defaultCameraPosition = useMemo<[number, number, number]>(
    () => [0, 6 * clampedScale, 12 * clampedScale],
    [clampedScale]
  );
  const planetBodies = useMemo(
    () => starSystem.planets.filter(body => body.bodyType === 'planet'),
    [starSystem.planets]
  );
  const sourcePlanets = useMemo<PlanetSource[]>(() => {
    if (astro?.planets?.length) {
      return astro.planets.map((planet, index) => {
        const linkedBody = planetBodies[index];
        const planetId = linkedBody?.id ?? (planet as { id?: string }).id ?? `planet-${index + 1}`;
        return {
          ...planet,
          id: planetId,
          name: linkedBody?.name,
          planetType: planet.type,
          habitabilityScore: (planet as { habitabilityScore?: number }).habitabilityScore
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
        moons: []
      }));
    }

    return Array.from({ length: 3 }, (_, idx) => ({
      id: `placeholder-${idx + 1}`,
      planetType: 'Terrestrial' as PlanetType,
      moons: []
    }));
  }, [astro?.planets, planetBodies]);

  const planets = useMemo<OrbitingPlanet[]>(() => {
    return sourcePlanets.map((planet, index) => buildPlanetModel(
      planet,
      index,
      sourcePlanets.length,
      sceneScale,
      minPlanetRadius,
      minMoonRadius
    ));
  }, [minMoonRadius, minPlanetRadius, sceneScale, sourcePlanets]);

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

  const starRadiusKm = (astro?.stars?.[0]?.radiusSun ?? 1) * SOLAR_RADIUS_KM;
  const starRadius = Math.max(starRadiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minStarRadius);
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
  const cameraInitialState = useMemo<SystemCameraState>(() => ({
    position: initialCameraState?.position ?? defaultCameraPosition,
    target: initialCameraState?.target ?? [0, 0, 0],
    anchoredBodyId: initialCameraState?.anchoredBodyId ?? starBodyId
  }), [defaultCameraPosition, initialCameraState, starBodyId]);
  const bodyInfoMap = useMemo<Record<string, SystemBodyInfo>>(() => {
    const map: Record<string, SystemBodyInfo> = {};
    map[starBodyId] = {
      id: starBodyId,
      name: t('systemView.bodyInfo.starName', { system: starSystem.name }),
      bodyType: 'star' as CelestialBodyType,
      bodySubType: astro?.primarySpectralType,
      radiusKm: starRadiusKm
    };

    sourcePlanets.forEach((planet, index) => {
      const planetId = planet.id ?? `planet-${index + 1}`;
      const planetName = planet.name ?? t('systemView.bodyInfo.unnamedPlanet', { index: index + 1 });
      const planetType = getPlanetType(planet);
      map[planetId] = {
        id: planetId,
        name: planetName,
        bodyType: 'planet',
        bodySubType: planetType,
        radiusKm: getPlanetRadiusKm(planet),
        atmosphere: (planet as PlanetData).atmosphere,
        habitabilityScore: (planet as { habitabilityScore?: number }).habitabilityScore
      };

      const moons = (planet.moons ?? []) as MoonSource[];
      moons.forEach((moon, moonIndex) => {
        const moonId = `${planetId}-moon-${moonIndex + 1}`;
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
          habitabilityScore: (moon as { habitabilityScore?: number }).habitabilityScore
        };
      });
    });

    return map;
  }, [astro?.primarySpectralType, sourcePlanets, starBodyId, starRadiusKm, starSystem.name, t]);
  const [anchoredBodyId, setAnchoredBodyId] = useState<string | undefined>(cameraInitialState.anchoredBodyId ?? starBodyId);
  const [hoveredBodyId, setHoveredBodyId] = useState<string | null>(null);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);
  const displayedBodyId = selectedBodyId ?? hoveredBodyId;
  const displayedBody = displayedBodyId ? bodyInfoMap[displayedBodyId] : undefined;
  const handleHover = useCallback((bodyId: string) => {
    setHoveredBodyId(bodyId);
  }, []);
  const handleBlur = useCallback((bodyId: string) => {
    setHoveredBodyId(prev => (prev === bodyId ? null : prev));
  }, []);
  const handleSelect = useCallback((bodyId: string) => {
    setSelectedBodyId(bodyId);
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedBodyId(null);
  }, []);
  useEffect(() => {
    setHoveredBodyId(null);
    setSelectedBodyId(null);
  }, [starSystem.id]);
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
  const focusRequestRef = useRef<FocusRequest | null>(null);
  const lastCameraStateRef = useRef<SystemCameraState>(cameraInitialState);
  useEffect(() => {
    lastCameraStateRef.current = cameraInitialState;
  }, [cameraInitialState]);
  useEffect(() => {
    setAnchoredBodyId(cameraInitialState.anchoredBodyId ?? starBodyId);
  }, [cameraInitialState.anchoredBodyId, starBodyId]);
  const anchoredTarget = useMemo<[number, number, number]>(() => {
    return bodyWorldPositions[anchoredBodyId ?? ''] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
  }, [anchoredBodyId, bodyWorldPositions, starBodyId]);
  const requestFocusOnBody = useCallback((bodyId: string) => {
    const position = bodyWorldPositions[bodyId];
    if (!position) return;
    const radius = bodyRadii[bodyId] ?? focusDistanceFloor;
    const desiredDistance = Math.min(Math.max(radius * 8, focusDistanceFloor), cameraMaxDistance * 0.95);
    focusRequestRef.current = {
      target: new Vector3(...position),
      distance: desiredDistance
    };
    setAnchoredBodyId(bodyId);
  }, [bodyWorldPositions, bodyRadii, cameraMaxDistance, focusDistanceFloor]);
  const initialCameraPosition = cameraInitialState.position;

  return (
    <div className="relative w-full h-full bg-black">
      <Canvas camera={{ position: initialCameraPosition, fov: 55 }}>
        <color attach="background" args={['#000000']} />
        <ambientLight intensity={0.6} />
        <pointLight position={[6, 6, 4]} intensity={1.5} />

        <SystemCamera
          maxDistance={cameraMaxDistance}
          focusRequest={focusRequestRef}
          initialState={cameraInitialState}
          onCameraStateChange={onCameraStateChange}
          lastCameraStateRef={lastCameraStateRef}
          anchoredTarget={anchoredTarget}
          anchoredBodyId={anchoredBodyId}
        />

        <SystemRoot>
          <StarMesh
            radius={starRadius}
            color={primaryColor}
            geometry={starGeometry}
            onDoubleClick={(event) => {
              event.stopPropagation();
              requestFocusOnBody(starBodyId);
            }}
            onHover={() => handleHover(starBodyId)}
            onBlur={() => handleBlur(starBodyId)}
            onSelect={() => handleSelect(starBodyId)}
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
              onHover={handleHover}
              onBlur={handleBlur}
              onSelect={handleSelect}
            />
          ))}
        </SystemRoot>
      </Canvas>
      <div className="pointer-events-none absolute inset-0 flex items-end justify-end p-4">
        <div className="pointer-events-auto w-80 max-w-full">
          <SystemBodyInfoPanel
            body={displayedBody}
            isSelected={Boolean(selectedBodyId)}
            onClearSelection={selectedBodyId ? clearSelection : undefined}
          />
        </div>
      </div>
    </div>
  );
};

export default SystemView3D;
