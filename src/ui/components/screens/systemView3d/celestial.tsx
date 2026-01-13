import React, { useEffect, useMemo, useRef } from 'react';
import { Select } from '@react-three/postprocessing';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  BufferGeometry,
  Euler,
  Group,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3
} from 'three';
import { hashStringToUnit } from '../systemViewLayout';
import {
  BODY_SPIN_SPEED_MAX,
  BODY_SPIN_SPEED_MIN,
  BODY_SPIN_SPEED_MULTIPLIER,
  CLOUD_NOISE_SPEED_MAX,
  CLOUD_NOISE_SPEED_MIN,
  CLOUD_SPIN_MULTIPLIER_MAX,
  CLOUD_SPIN_MULTIPLIER_MIN,
  MOON_SPIN_SCALE_MAX,
  MOON_SPIN_SCALE_MIN,
  ORBIT_THICKNESS,
  PLANET_SPIN_SCALE_MAX,
  PLANET_SPIN_SCALE_MIN
} from './config';
import { AtmosphereStack, type AtmosphereLayerBundle } from './atmosphere';
import { useDisposableMemo } from './renderUtils';
import {
  computeInclinedOrbitPosition,
  getSpinScaleFromRadius,
  type OrbitingMoon,
  type OrbitingPlanet,
  type OrbitingStar
} from './systemModel';
import { StarMesh } from './stars';

const buildOrbitRingGeometry = (innerRadius: number, outerRadius: number, segments: number): BufferGeometry => {
  const geometry = new RingGeometry(innerRadius, outerRadius, segments);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
};

const resolveOrbitRingRadii = (radius: number, thicknessScale = 1): { inner: number; outer: number } => {
  if (radius <= 0) return { inner: 0.0001, outer: 0.0001 };
  const offset = Math.min(Math.max(radius * 0.0025, ORBIT_THICKNESS) * thicknessScale, radius * 0.9) * 0.5;
  return {
    inner: radius - offset,
    outer: radius + offset
  };
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: MeshBasicMaterial;
  orbitMaterialShadow: MeshBasicMaterial;
  moonGeometry: SphereGeometry;
  moonMaterial: MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
  enableBloom: boolean;
  spinReferenceRadius: number;
  fixedTerminator: boolean;
  hitboxScaleMultiplier: number;
  sunPosition: Vector3;
  onPressStart: (bodyId: string, event: ThreeEvent<PointerEvent>) => void;
  onPressMove: (event: ThreeEvent<PointerEvent>) => void;
  onPressEnd: () => void;
  onPressCancel: () => void;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => void;
}

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps> = ({
  moon,
  orbitMaterial,
  orbitMaterialShadow,
  moonGeometry,
  moonMaterial,
  resolveAtmosphereBundle,
  enableBloom,
  spinReferenceRadius,
  fixedTerminator,
  hitboxScaleMultiplier,
  sunPosition,
  onPressStart,
  onPressMove,
  onPressEnd,
  onPressCancel,
  onHover,
  onBlur,
  onSelect
}) => {
  const hitboxMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    []
  );
  useEffect(() => () => hitboxMaterial.dispose(), [hitboxMaterial]);
  const orbitRadii = useMemo(
    () => resolveOrbitRingRadii(moon.orbitRadius),
    [moon.orbitRadius]
  );
  const orbitGeometryShadow = useDisposableMemo(
    () => buildOrbitRingGeometry(orbitRadii.inner, orbitRadii.outer, 96),
    [orbitRadii.inner, orbitRadii.outer]
  );
  const orbitRadiiBright = useMemo(
    () => resolveOrbitRingRadii(moon.orbitRadius, 0.65),
    [moon.orbitRadius]
  );
  const orbitGeometryBright = useDisposableMemo(
    () => buildOrbitRingGeometry(orbitRadiiBright.inner, orbitRadiiBright.outer, 96),
    [orbitRadiiBright.inner, orbitRadiiBright.outer]
  );
  const orbitRotation = useMemo(() => {
    const inclination = MathUtils.degToRad(moon.orbitInclinationDeg);
    const ascendingNode = MathUtils.degToRad(moon.orbitAscendingNodeDeg);
    return new Euler(inclination, ascendingNode, 0, 'XYZ');
  }, [moon.orbitAscendingNodeDeg, moon.orbitInclinationDeg]);
  const moonPosition = useMemo<[number, number, number]>(
    () => computeInclinedOrbitPosition(
      moon.orbitRadius,
      moon.orbitAngle,
      moon.orbitInclinationDeg,
      moon.orbitAscendingNodeDeg
    ),
    [moon.orbitAngle, moon.orbitAscendingNodeDeg, moon.orbitInclinationDeg, moon.orbitRadius]
  );
  const moonHitboxScale = useMemo<[number, number, number]>(
    () => {
      const scale = moon.radius * 2 * hitboxScaleMultiplier;
      return [scale, scale, scale];
    },
    [hitboxScaleMultiplier, moon.radius]
  );
  const moonScale = useMemo<[number, number, number]>(() => [moon.radius, moon.radius, moon.radius], [moon.radius]);
  const atmosphereBundle = moon.atmosphere && moon.atmosphere !== 'None'
    ? resolveAtmosphereBundle(moon)
    : null;
  const spinScale = useMemo(
    () => getSpinScaleFromRadius(moon.radius, spinReferenceRadius, MOON_SPIN_SCALE_MIN, MOON_SPIN_SCALE_MAX),
    [moon.radius, spinReferenceRadius]
  );
  const baseSpinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${moon.id}-spin`);
    return MathUtils.lerp(BODY_SPIN_SPEED_MIN, BODY_SPIN_SPEED_MAX, seed)
      * BODY_SPIN_SPEED_MULTIPLIER
      * spinScale;
  }, [moon.id, spinScale]);
  const spinSpeed = fixedTerminator ? 0 : baseSpinSpeed;
  const cloudSpinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${moon.id}-cloud-spin`);
    const multiplier = MathUtils.lerp(CLOUD_SPIN_MULTIPLIER_MIN, CLOUD_SPIN_MULTIPLIER_MAX, seed);
    return baseSpinSpeed * multiplier;
  }, [moon.id, baseSpinSpeed]);
  const cloudNoiseSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${moon.id}-cloud-noise`);
    return MathUtils.lerp(CLOUD_NOISE_SPEED_MIN, CLOUD_NOISE_SPEED_MAX, seed);
  }, [moon.id]);
  const atmosphereNode = atmosphereBundle
    ? (
      <AtmosphereStack
        geometry={moonGeometry}
        radius={moon.radius}
        bundle={atmosphereBundle}
        cloudSpinSpeed={cloudSpinSpeed}
        cloudNoiseSpeed={cloudNoiseSpeed}
        sunPosition={sunPosition}
      />
    )
    : null;
  const spinGroupRef = useRef<Group>(null);

  useFrame((_, delta) => {
    if (spinGroupRef.current) {
      spinGroupRef.current.rotation.y += delta * spinSpeed;
    }
  });

  return (
    <group>
      <mesh
        geometry={orbitGeometryShadow}
        material={orbitMaterialShadow}
        rotation={orbitRotation}
        frustumCulled
        raycast={() => null}
        renderOrder={2}
      />
      <mesh
        geometry={orbitGeometryBright}
        material={orbitMaterial}
        rotation={orbitRotation}
        frustumCulled
        raycast={() => null}
        renderOrder={3}
      />
      <group position={moonPosition}>
        <group ref={spinGroupRef}>
          <mesh
            geometry={moonGeometry}
            material={hitboxMaterial}
            scale={moonHitboxScale}
            castShadow={false}
            receiveShadow={false}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              onPressStart(moon.id, event);
            }}
            onPointerUp={() => {
              onPressEnd();
            }}
            onPointerMove={(event) => {
              event.stopPropagation();
              onPressMove(event);
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(moon.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onPressMove(event);
              if (event.pointerType !== 'touch') {
                onPressCancel();
              }
              onBlur(moon.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(moon.id, event);
            }}
            frustumCulled
          />
          <mesh
            geometry={moonGeometry}
            material={moonMaterial}
            scale={moonScale}
            castShadow
            receiveShadow
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
              onSelect(moon.id, event);
            }}
            frustumCulled
          />
          {atmosphereNode && (enableBloom ? <Select enabled>{atmosphereNode}</Select> : atmosphereNode)}
        </group>
      </group>
    </group>
  );
};

interface PlanetOrbitGroupProps {
  planet: OrbitingPlanet;
  orbitMaterial: MeshBasicMaterial;
  orbitMaterialShadow: MeshBasicMaterial;
  planetGeometry: SphereGeometry;
  planetGeometryHigh: SphereGeometry | null;
  moonGeometry: SphereGeometry;
  moonGeometryHigh: SphereGeometry | null;
  planetMaterial: MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
  enableBloom: boolean;
  spinReferenceRadius: number;
  moonSpinReferenceRadius: number;
  highDetailBodyId: string | null;
  fixedTerminator: boolean;
  hitboxScaleMultiplier: number;
  sunPosition: Vector3;
  onPressStart: (bodyId: string, event: ThreeEvent<PointerEvent>) => void;
  onPressMove: (event: ThreeEvent<PointerEvent>) => void;
  onPressEnd: () => void;
  onPressCancel: () => void;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => void;
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({
  planet,
  orbitMaterial,
  orbitMaterialShadow,
  planetGeometry,
  planetGeometryHigh,
  moonGeometry,
  moonGeometryHigh,
  planetMaterial,
  resolveMoonMaterial,
  resolveAtmosphereBundle,
  enableBloom,
  spinReferenceRadius,
  moonSpinReferenceRadius,
  highDetailBodyId,
  fixedTerminator,
  hitboxScaleMultiplier,
  sunPosition,
  onPressStart,
  onPressMove,
  onPressEnd,
  onPressCancel,
  onHover,
  onBlur,
  onSelect
}) => {
  const hitboxMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    []
  );
  useEffect(() => () => hitboxMaterial.dispose(), [hitboxMaterial]);
  const orbitRadii = useMemo(
    () => resolveOrbitRingRadii(planet.orbitRadius),
    [planet.orbitRadius]
  );
  const orbitGeometryShadow = useDisposableMemo(
    () => buildOrbitRingGeometry(orbitRadii.inner, orbitRadii.outer, 128),
    [orbitRadii.inner, orbitRadii.outer]
  );
  const orbitRadiiBright = useMemo(
    () => resolveOrbitRingRadii(planet.orbitRadius, 0.65),
    [planet.orbitRadius]
  );
  const orbitGeometryBright = useDisposableMemo(
    () => buildOrbitRingGeometry(orbitRadiiBright.inner, orbitRadiiBright.outer, 128),
    [orbitRadiiBright.inner, orbitRadiiBright.outer]
  );
  const orbitRotation = useMemo(() => {
    const inclination = MathUtils.degToRad(planet.orbitInclinationDeg);
    const ascendingNode = MathUtils.degToRad(planet.orbitAscendingNodeDeg);
    return new Euler(inclination, ascendingNode, 0, 'XYZ');
  }, [planet.orbitAscendingNodeDeg, planet.orbitInclinationDeg]);
  const planetPosition = useMemo<[number, number, number]>(
    () => computeInclinedOrbitPosition(
      planet.orbitRadius,
      planet.orbitAngle,
      planet.orbitInclinationDeg,
      planet.orbitAscendingNodeDeg
    ),
    [planet.orbitAngle, planet.orbitAscendingNodeDeg, planet.orbitInclinationDeg, planet.orbitRadius]
  );
  const planetScale = useMemo<[number, number, number]>(
    () => [planet.radius, planet.radius, planet.radius],
    [planet.radius]
  );
  const planetHitboxScale = useMemo<[number, number, number]>(
    () => {
      const scale = planet.radius * 1.5 * hitboxScaleMultiplier;
      return [scale, scale, scale];
    },
    [hitboxScaleMultiplier, planet.radius]
  );
  const atmosphereBundle = planet.atmosphere && planet.atmosphere !== 'None'
    ? resolveAtmosphereBundle(planet)
    : null;
  const spinScale = useMemo(
    () => getSpinScaleFromRadius(planet.radius, spinReferenceRadius, PLANET_SPIN_SCALE_MIN, PLANET_SPIN_SCALE_MAX),
    [planet.radius, spinReferenceRadius]
  );
  const baseSpinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${planet.id}-spin`);
    return MathUtils.lerp(BODY_SPIN_SPEED_MIN, BODY_SPIN_SPEED_MAX, seed)
      * BODY_SPIN_SPEED_MULTIPLIER
      * spinScale;
  }, [planet.id, spinScale]);
  const spinSpeed = fixedTerminator ? 0 : baseSpinSpeed;
  const cloudSpinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${planet.id}-cloud-spin`);
    const multiplier = MathUtils.lerp(CLOUD_SPIN_MULTIPLIER_MIN, CLOUD_SPIN_MULTIPLIER_MAX, seed);
    return baseSpinSpeed * multiplier;
  }, [planet.id, baseSpinSpeed]);
  const cloudNoiseSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${planet.id}-cloud-noise`);
    return MathUtils.lerp(CLOUD_NOISE_SPEED_MIN, CLOUD_NOISE_SPEED_MAX, seed);
  }, [planet.id]);
  const spinGroupRef = useRef<Group>(null);
  const planetGeometryActive = highDetailBodyId === planet.id && planetGeometryHigh
    ? planetGeometryHigh
    : planetGeometry;
  const atmosphereNode = atmosphereBundle
    ? (
      <AtmosphereStack
        geometry={planetGeometryActive}
        radius={planet.radius}
        bundle={atmosphereBundle}
        cloudSpinSpeed={cloudSpinSpeed}
        cloudNoiseSpeed={cloudNoiseSpeed}
        sunPosition={sunPosition}
      />
    )
    : null;

  useFrame((_, delta) => {
    if (spinGroupRef.current) {
      spinGroupRef.current.rotation.y += delta * spinSpeed;
    }
  });

  return (
    <group>
      <mesh
        geometry={orbitGeometryShadow}
        material={orbitMaterialShadow}
        rotation={orbitRotation}
        frustumCulled
        raycast={() => null}
        renderOrder={2}
      />
      <mesh
        geometry={orbitGeometryBright}
        material={orbitMaterial}
        rotation={orbitRotation}
        frustumCulled
        raycast={() => null}
        renderOrder={3}
      />
      <group position={planetPosition}>
        <group ref={spinGroupRef}>
          <mesh
            geometry={planetGeometryActive}
            material={hitboxMaterial}
            scale={planetHitboxScale}
            castShadow={false}
            receiveShadow={false}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              onPressStart(planet.id, event);
            }}
            onPointerUp={() => {
              onPressEnd();
            }}
            onPointerMove={(event) => {
              event.stopPropagation();
              onPressMove(event);
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(planet.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onPressMove(event);
              if (event.pointerType !== 'touch') {
                onPressCancel();
              }
              onBlur(planet.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(planet.id, event);
            }}
            frustumCulled
          />
          <mesh
            geometry={planetGeometryActive}
            material={planetMaterial}
            scale={planetScale}
            castShadow
            receiveShadow
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
              onSelect(planet.id, event);
            }}
            frustumCulled
          />
          {atmosphereNode && (enableBloom ? <Select enabled>{atmosphereNode}</Select> : atmosphereNode)}
        </group>
        {planet.moons.map(moon => {
          const moonGeometryActive = highDetailBodyId === moon.id && moonGeometryHigh
            ? moonGeometryHigh
            : moonGeometry;
          return (
            <MoonOrbitGroup
              key={moon.id}
              moon={moon}
              orbitMaterial={orbitMaterial}
              orbitMaterialShadow={orbitMaterialShadow}
              moonGeometry={moonGeometryActive}
              moonMaterial={resolveMoonMaterial(moon)}
              resolveAtmosphereBundle={resolveAtmosphereBundle}
              enableBloom={enableBloom}
              spinReferenceRadius={moonSpinReferenceRadius}
              fixedTerminator={fixedTerminator}
              hitboxScaleMultiplier={hitboxScaleMultiplier}
              sunPosition={sunPosition}
              onPressStart={onPressStart}
              onPressMove={onPressMove}
              onPressEnd={onPressEnd}
              onPressCancel={onPressCancel}
              onHover={onHover}
              onBlur={onBlur}
              onSelect={onSelect}
            />
          );
        })}
      </group>
    </group>
  );
};

interface SystemCelestialLayerProps {
  stars: OrbitingStar[];
  starGeometry: SphereGeometry;
  planets: OrbitingPlanet[];
  orbitMaterial: MeshBasicMaterial;
  orbitMaterialShadow: MeshBasicMaterial;
  planetGeometry: SphereGeometry;
  planetGeometryHigh: SphereGeometry | null;
  moonGeometry: SphereGeometry;
  moonGeometryHigh: SphereGeometry | null;
  resolvePlanetMaterial: (planet: OrbitingPlanet) => MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
  starSpinReferenceRadius: number;
  planetSpinReferenceRadius: number;
  moonSpinReferenceRadius: number;
  highDetailBodyId: string | null;
  fixedTerminator: boolean;
  hitboxScaleMultiplier: number;
  sunPosition: Vector3;
  enableBloom: boolean;
  onBodyPressStart: (bodyId: string, event: ThreeEvent<PointerEvent>) => void;
  onBodyPressMove: (event: ThreeEvent<PointerEvent>) => void;
  onBodyPressEnd: () => void;
  onBodyPressCancel: () => void;
  onHoverBody: (bodyId: string) => void;
  onBlurBody: (bodyId: string) => void;
  onSelectBody: (bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => void;
}

export const SystemCelestialLayer: React.FC<SystemCelestialLayerProps> = ({
  stars,
  starGeometry,
  planets,
  orbitMaterial,
  orbitMaterialShadow,
  planetGeometry,
  planetGeometryHigh,
  moonGeometry,
  moonGeometryHigh,
  resolvePlanetMaterial,
  resolveMoonMaterial,
  resolveAtmosphereBundle,
  starSpinReferenceRadius,
  planetSpinReferenceRadius,
  moonSpinReferenceRadius,
  highDetailBodyId,
  fixedTerminator,
  hitboxScaleMultiplier,
  sunPosition,
  enableBloom,
  onBodyPressStart,
  onBodyPressMove,
  onBodyPressEnd,
  onBodyPressCancel,
  onHoverBody,
  onBlurBody,
  onSelectBody
}) => {
  return (
    <group name="SystemCelestialLayer">
      {stars.map((star) => (
        <group key={star.id} position={star.position}>
          {enableBloom ? (
            <Select enabled>
              <StarMesh
                radius={star.radius}
                tintColor={star.tintColor}
                surfaceTintColor={star.surfaceTintColor}
                geometry={starGeometry}
                seedKey={star.seedKey}
                spinReferenceRadius={starSpinReferenceRadius}
                enableLensFlare={star.data.role === 'primary'}
                onHover={() => onHoverBody(star.id)}
                onBlur={() => onBlurBody(star.id)}
                onSelect={(event) => onSelectBody(star.id, event)}
              />
            </Select>
          ) : (
            <StarMesh
              radius={star.radius}
              tintColor={star.tintColor}
              surfaceTintColor={star.surfaceTintColor}
              geometry={starGeometry}
              seedKey={star.seedKey}
              spinReferenceRadius={starSpinReferenceRadius}
              enableLensFlare={star.data.role === 'primary'}
              onHover={() => onHoverBody(star.id)}
              onBlur={() => onBlurBody(star.id)}
              onSelect={(event) => onSelectBody(star.id, event)}
            />
          )}
        </group>
      ))}
      {planets.map(planet => (
        <PlanetOrbitGroup
          key={planet.id}
          planet={planet}
          orbitMaterial={orbitMaterial}
          orbitMaterialShadow={orbitMaterialShadow}
          planetGeometry={planetGeometry}
          planetGeometryHigh={planetGeometryHigh}
          moonGeometry={moonGeometry}
          moonGeometryHigh={moonGeometryHigh}
          planetMaterial={resolvePlanetMaterial(planet)}
          resolveMoonMaterial={resolveMoonMaterial}
          resolveAtmosphereBundle={resolveAtmosphereBundle}
          enableBloom={enableBloom}
          spinReferenceRadius={planetSpinReferenceRadius}
          moonSpinReferenceRadius={moonSpinReferenceRadius}
          highDetailBodyId={highDetailBodyId}
          fixedTerminator={fixedTerminator}
          hitboxScaleMultiplier={hitboxScaleMultiplier}
          sunPosition={sunPosition}
          onPressStart={onBodyPressStart}
          onPressMove={onBodyPressMove}
          onPressEnd={onBodyPressEnd}
          onPressCancel={onBodyPressCancel}
          onHover={onHoverBody}
          onBlur={onBlurBody}
          onSelect={onSelectBody}
        />
      ))}
    </group>
  );
};
