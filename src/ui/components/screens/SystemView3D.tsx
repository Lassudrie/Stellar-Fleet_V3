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
const KM_TO_SCENE_UNITS = 1 / 10_000_000;
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
  position: [number, number, number];
  type: MoonType;
};

type OrbitingPlanet = {
  id: string;
  radius: number;
  orbitRadius: number;
  position: [number, number, number];
  type: PlanetType;
  moons: OrbitingMoon[];
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

const getPlanetRadiusKm = (planet: PlanetData | { size?: number; radiusEarth?: number }): number => {
  if ('radiusEarth' in planet && typeof planet.radiusEarth === 'number') {
    return Math.max(planet.radiusEarth, 0.1) * EARTH_RADIUS_KM;
  }
  if ('size' in planet && typeof planet.size === 'number') {
    return Math.max(planet.size, 0.1) * EARTH_RADIUS_KM;
  }
  return EARTH_RADIUS_KM;
};

const getPlanetType = (planet: PlanetData | { class?: string }): PlanetType => {
  if ('type' in planet) return planet.type;
  const planetClass = planet.class;
  if (planetClass === 'gas_giant') return 'GasGiant';
  if (planetClass === 'ice_giant') return 'IceGiant';
  return 'Terrestrial';
};

const getSemiMajorAxisKm = (planet: PlanetData | undefined, index: number): number => {
  if (planet && 'semiMajorAxisAu' in planet && typeof planet.semiMajorAxisAu === 'number') {
    return planet.semiMajorAxisAu * KM_PER_AU;
  }
  return DEFAULT_ORBIT_INNER_KM + index * DEFAULT_ORBIT_STEP_KM;
};

const buildPlanetModel = (
  planet: PlanetData | { id?: string; class?: string; size?: number; moons?: MoonData[] },
  index: number,
  total: number
): OrbitingPlanet => {
  const radiusKm = getPlanetRadiusKm(planet);
  const semiMajorAxisKm = getSemiMajorAxisKm('semiMajorAxisAu' in planet ? planet : undefined, index);
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  const orbitRadius = semiMajorAxisKm * KM_TO_SCENE_UNITS;
  const position = computeOrbitPosition(orbitRadius, angle);
  const radius = Math.max(radiusKm * KM_TO_SCENE_UNITS * RADIUS_VISIBILITY_BONUS, MIN_PLANET_RADIUS);
  const planetId = 'id' in planet && planet.id ? planet.id : `planet-${index + 1}`;
  const planetType = getPlanetType(planet);

  const moons = ('moons' in planet && planet.moons ? planet.moons : []).map((moon, moonIndex) => {
    const moonRadiusKm = Math.max(moon.radiusEarth, 0.05) * EARTH_RADIUS_KM;
    const moonOrbitKm = moon.orbitDistanceRp * radiusKm;
    const moonOrbitRadius = moonOrbitKm * KM_TO_SCENE_UNITS;
    const moonAngle = (moonIndex / Math.max(planet.moons?.length ?? 1, 1)) * Math.PI * 2 + Math.PI / 4;
    return {
      id: `${planetId}-moon-${moonIndex + 1}`,
      radius: Math.max(moonRadiusKm * KM_TO_SCENE_UNITS * RADIUS_VISIBILITY_BONUS, MIN_PLANET_RADIUS / 3),
      orbitRadius: moonOrbitRadius,
      position: computeOrbitPosition(moonOrbitRadius, moonAngle),
      type: moon.type
    };
  });

  return { id: planetId, radius, orbitRadius, position, type: planetType, moons };
};

const SystemRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <group name="SystemRoot">
    {children}
  </group>
);

const StarMesh: React.FC<{ radius: number; color: string }> = ({ radius, color }) => {
  const geometry = useDisposableMemo(() => new SphereGeometry(radius, 64, 64), [radius]);
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

  return <mesh geometry={geometry} material={material} />;
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: MeshBasicMaterial;
}

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps> = ({ moon, orbitMaterial }) => {
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(moon.orbitRadius - ORBIT_THICKNESS, 0.005), moon.orbitRadius + ORBIT_THICKNESS, 96),
    [moon.orbitRadius]
  );
  const moonGeometry = useDisposableMemo(() => new SphereGeometry(moon.radius, 32, 32), [moon.radius]);
  const moonMaterial = useDisposableMemo(
    () => new MeshStandardMaterial({
      color: MOON_TYPE_COLORS[moon.type],
      roughness: 0.6,
      metalness: 0.15
    }),
    [moon.type]
  );
  const orbitRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} />
      <mesh geometry={moonGeometry} material={moonMaterial} position={moon.position} />
    </group>
  );
};

interface PlanetOrbitGroupProps {
  planet: OrbitingPlanet;
  orbitMaterial: MeshBasicMaterial;
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({ planet, orbitMaterial }) => {
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(planet.orbitRadius - ORBIT_THICKNESS, 0.01), planet.orbitRadius + ORBIT_THICKNESS, 128),
    [planet.orbitRadius]
  );
  const planetGeometry = useDisposableMemo(() => new SphereGeometry(planet.radius, 48, 48), [planet.radius]);
  const planetMaterial = useDisposableMemo(
    () => new MeshStandardMaterial({
      color: PLANET_TYPE_COLORS[planet.type],
      roughness: 0.55,
      metalness: 0.2
    }),
    [planet.type]
  );
  const orbitRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} />
      <group position={planet.position}>
        <mesh geometry={planetGeometry} material={planetMaterial} />
        {planet.moons.map(moon => (
          <MoonOrbitGroup key={moon.id} moon={moon} orbitMaterial={orbitMaterial} />
        ))}
      </group>
    </group>
  );
};

const SystemView3D: React.FC<SystemView3DProps> = ({ starSystem, astro }) => {
  const planets = useMemo<OrbitingPlanet[]>(() => {
      const sourcePlanets: (PlanetData | { id?: string; class?: string; size?: number; moons?: MoonData[] })[] =
        astro?.planets?.length ? astro.planets : starSystem.planets;
      if (!sourcePlanets.length) {
        return Array.from({ length: 3 }, (_, idx) => buildPlanetModel({ id: `placeholder-${idx}` }, idx, 3));
      }
      return sourcePlanets.map((planet, index) => buildPlanetModel(planet, index, sourcePlanets.length));
  }, [astro?.planets, starSystem.planets]);

  const orbitMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({ color: '#334155', transparent: true, opacity: 0.8 }),
    []
  );

  const starRadiusKm = (astro?.stars?.[0]?.radiusSun ?? 1) * SOLAR_RADIUS_KM;
  const starRadius = Math.max(starRadiusKm * KM_TO_SCENE_UNITS * RADIUS_VISIBILITY_BONUS, MIN_STAR_RADIUS);
  const primaryColor = starSystem.color || '#7dd3fc';

  return (
    <div className="w-full h-full bg-black">
      <Canvas camera={{ position: [0, 6, 12], fov: 55 }}>
        <color attach="background" args={['#000000']} />
        <ambientLight intensity={0.6} />
        <pointLight position={[6, 6, 4]} intensity={1.5} />

        <SystemRoot>
          <StarMesh radius={starRadius} color={primaryColor} />
          {planets.map(planet => (
            <PlanetOrbitGroup key={planet.id} planet={planet} orbitMaterial={orbitMaterial} />
          ))}
        </SystemRoot>
      </Canvas>
    </div>
  );
};

export default SystemView3D;
