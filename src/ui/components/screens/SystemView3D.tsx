import React, { useEffect, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { MeshBasicMaterial, MeshStandardMaterial, RingGeometry, SphereGeometry } from 'three';
import {
  MoonData,
  MoonType,
  PlanetData,
  PlanetType,
  StarSystem,
  StarSystemAstro
} from '../../../shared/types';

interface SystemView3DProps {
  starSystem: StarSystem;
  astro?: StarSystemAstro;
}

const KM_PER_AU = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371;
const SOLAR_RADIUS_KM = 695_700;
const KM_TO_SCENE_SCALE = 1 / 10_000_000;
const RADIUS_VISIBILITY_BONUS = 25;
const MIN_PLANET_RADIUS = 0.12;
const MIN_STAR_RADIUS = 0.5;
const ORBIT_THICKNESS = 0.04;
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
}) | {
  id?: string;
  class?: string;
  size?: number;
  moons?: MoonData[];
  radiusKm?: number;
  semiMajorAxisKm?: number;
  planetType?: PlanetType;
};

type MoonSource = MoonData & {
  radiusKm?: number;
  moonType?: MoonType;
  orbitDistanceKm?: number;
};

type UseMemoDisposableDeps = React.DependencyList;

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
  total: number
): OrbitingPlanet => {
  const radiusKm = getPlanetRadiusKm(planet);
  const semiMajorAxisKm = getSemiMajorAxisKm(planet, index);
  const orbitAngle = (index / Math.max(total, 1)) * Math.PI * 2;
  const orbitRadius = semiMajorAxisKm * KM_TO_SCENE_SCALE;
  const radius = Math.max(radiusKm * KM_TO_SCENE_SCALE * RADIUS_VISIBILITY_BONUS, MIN_PLANET_RADIUS);
  const planetId = planet.id ?? `planet-${index + 1}`;
  const planetType = getPlanetType(planet);

  const moons = (planet.moons ?? []).map((moon, moonIndex) => {
    const moonRadiusKm = getMoonRadiusKm(moon as MoonSource);
    const moonOrbitKm = getMoonOrbitKm(moon as MoonSource, radiusKm);
    const moonOrbitRadius = moonOrbitKm * KM_TO_SCENE_SCALE;
    const moonAngle = (moonIndex / Math.max(planet.moons?.length ?? 1, 1)) * Math.PI * 2 + Math.PI / 4;
    return {
      id: `${planetId}-moon-${moonIndex + 1}`,
      radius: Math.max(moonRadiusKm * KM_TO_SCENE_SCALE * RADIUS_VISIBILITY_BONUS, MIN_PLANET_RADIUS / 3),
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
}

const StarMesh: React.FC<StarMeshProps> = ({ radius, color, geometry }) => {
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

  return <mesh geometry={geometry} material={material} scale={scale} />;
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: MeshBasicMaterial;
  moonGeometry: SphereGeometry;
  moonMaterial: MeshStandardMaterial;
}

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps> = ({ moon, orbitMaterial, moonGeometry, moonMaterial }) => {
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(moon.orbitRadius - ORBIT_THICKNESS, 0.005), moon.orbitRadius + ORBIT_THICKNESS, 96),
    [moon.orbitRadius]
  );
  const orbitRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const moonPosition = useMemo<[number, number, number]>(
    () => computeOrbitPosition(moon.orbitRadius, moon.orbitAngle),
    [moon.orbitAngle, moon.orbitRadius]
  );
  const moonScale = useMemo<[number, number, number]>(() => [moon.radius, moon.radius, moon.radius], [moon.radius]);

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} />
      <mesh geometry={moonGeometry} material={moonMaterial} position={moonPosition} scale={moonScale} />
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
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({
  planet,
  orbitMaterial,
  planetGeometry,
  moonGeometry,
  planetMaterial,
  moonMaterials
}) => {
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(planet.orbitRadius - ORBIT_THICKNESS, 0.01), planet.orbitRadius + ORBIT_THICKNESS, 128),
    [planet.orbitRadius]
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
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} />
      <group position={planetPosition}>
        <mesh geometry={planetGeometry} material={planetMaterial} scale={planetScale} />
        {planet.moons.map(moon => (
          <MoonOrbitGroup
            key={moon.id}
            moon={moon}
            orbitMaterial={orbitMaterial}
            moonGeometry={moonGeometry}
            moonMaterial={moonMaterials[moon.type]}
          />
        ))}
      </group>
    </group>
  );
};

const SystemView3D: React.FC<SystemView3DProps> = ({ starSystem, astro }) => {
  const planets = useMemo<OrbitingPlanet[]>(() => {
    const sourcePlanets: PlanetSource[] = astro?.planets?.length ? astro.planets : starSystem.planets;
    if (!sourcePlanets.length) {
      return Array.from({ length: 3 }, (_, idx) => buildPlanetModel({ id: `placeholder-${idx}` }, idx, 3));
    }
    return sourcePlanets.map((planet, index) => buildPlanetModel(planet, index, sourcePlanets.length));
  }, [astro?.planets, starSystem.planets]);

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
  const starRadius = Math.max(starRadiusKm * KM_TO_SCENE_SCALE * RADIUS_VISIBILITY_BONUS, MIN_STAR_RADIUS);
  const primaryColor = starSystem.color || '#7dd3fc';

  return (
    <div className="w-full h-full bg-black">
      <Canvas camera={{ position: [0, 6, 12], fov: 55 }}>
        <color attach="background" args={['#000000']} />
        <ambientLight intensity={0.6} />
        <pointLight position={[6, 6, 4]} intensity={1.5} />

        <SystemRoot>
          <StarMesh radius={starRadius} color={primaryColor} geometry={starGeometry} />
          {planets.map(planet => (
            <PlanetOrbitGroup
              key={planet.id}
              planet={planet}
              orbitMaterial={orbitMaterial}
              planetGeometry={planetGeometry}
              moonGeometry={moonGeometry}
              planetMaterial={planetMaterialMap[planet.type]}
              moonMaterials={moonMaterialMap}
            />
          ))}
        </SystemRoot>
      </Canvas>
    </div>
  );
};

export default SystemView3D;
