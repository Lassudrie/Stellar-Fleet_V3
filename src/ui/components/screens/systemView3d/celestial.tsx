import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import {
  BufferGeometry,
  Euler,
  Group,
  LineBasicMaterial,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
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

const buildOrbitLineGeometry = (radius: number, segments: number): BufferGeometry => {
  const points: Vector3[] = [];
  const step = (Math.PI * 2) / segments;
  for (let i = 0; i < segments; i += 1) {
    const angle = i * step;
    points.push(new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  const geometry = new BufferGeometry();
  geometry.setFromPoints(points);
  return geometry;
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: LineBasicMaterial;
  moonGeometry: SphereGeometry;
  moonMaterial: MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
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

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps & { onFocus: (bodyId: string) => void }> = ({
  moon,
  orbitMaterial,
  moonGeometry,
  moonMaterial,
  resolveAtmosphereBundle,
  spinReferenceRadius,
  fixedTerminator,
  hitboxScaleMultiplier,
  sunPosition,
  onPressStart,
  onPressMove,
  onPressEnd,
  onPressCancel,
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
    () => buildOrbitLineGeometry(moon.orbitRadius, 96),
    [moon.orbitRadius]
  );
  const orbitRotation = useMemo(() => {
    const inclination = MathUtils.degToRad(moon.orbitInclinationDeg);
    const ascendingNode = MathUtils.degToRad(moon.orbitAscendingNodeDeg);
    return new Euler(-Math.PI / 2 - inclination, -ascendingNode, 0, 'YXZ');
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
  const spinGroupRef = useRef<Group>(null);

  useFrame((_, delta) => {
    if (spinGroupRef.current) {
      spinGroupRef.current.rotation.y += delta * spinSpeed;
    }
  });

  return (
    <group>
      <lineLoop
        geometry={orbitGeometry}
        material={orbitMaterial}
        rotation={orbitRotation}
        frustumCulled
        raycast={() => null}
        renderOrder={2}
      />
      <group position={moonPosition}>
        <group ref={spinGroupRef}>
          <mesh
            geometry={moonGeometry}
            material={hitboxMaterial}
            scale={moonHitboxScale}
            castShadow={false}
            receiveShadow={false}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(moon.id);
            }}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              const now = performance.now();
              if (event.pointerType === 'touch' && now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
                lastTouchRef.current = 0;
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                onPressCancel();
                onFocus(moon.id);
                return;
              }
              if (event.pointerType === 'touch') {
                lastTouchRef.current = now;
              }
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
              onSelect(moon.id, event);
            }}
            frustumCulled
          />
          {atmosphereBundle && (
            <AtmosphereStack
              geometry={moonGeometry}
              radius={moon.radius}
              bundle={atmosphereBundle}
              cloudSpinSpeed={cloudSpinSpeed}
              cloudNoiseSpeed={cloudNoiseSpeed}
              sunPosition={sunPosition}
            />
          )}
        </group>
      </group>
    </group>
  );
};

interface PlanetOrbitGroupProps {
  planet: OrbitingPlanet;
  orbitMaterial: LineBasicMaterial;
  planetGeometry: SphereGeometry;
  planetGeometryHigh: SphereGeometry;
  moonGeometry: SphereGeometry;
  moonGeometryHigh: SphereGeometry;
  planetMaterial: MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
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
  onFocus: (bodyId: string) => void;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => void;
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({
  planet,
  orbitMaterial,
  planetGeometry,
  planetGeometryHigh,
  moonGeometry,
  moonGeometryHigh,
  planetMaterial,
  resolveMoonMaterial,
  resolveAtmosphereBundle,
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
    () => buildOrbitLineGeometry(planet.orbitRadius, 128),
    [planet.orbitRadius]
  );
  const orbitRotation = useMemo(() => {
    const inclination = MathUtils.degToRad(planet.orbitInclinationDeg);
    const ascendingNode = MathUtils.degToRad(planet.orbitAscendingNodeDeg);
    return new Euler(-Math.PI / 2 - inclination, -ascendingNode, 0, 'YXZ');
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
  const planetGeometryActive = highDetailBodyId === planet.id ? planetGeometryHigh : planetGeometry;

  useFrame((_, delta) => {
    if (spinGroupRef.current) {
      spinGroupRef.current.rotation.y += delta * spinSpeed;
    }
  });

  return (
    <group>
      <lineLoop
        geometry={orbitGeometry}
        material={orbitMaterial}
        rotation={orbitRotation}
        frustumCulled
        raycast={() => null}
        renderOrder={2}
      />
      <group position={planetPosition}>
        <group ref={spinGroupRef}>
          <mesh
            geometry={planetGeometryActive}
            material={hitboxMaterial}
            scale={planetHitboxScale}
            castShadow={false}
            receiveShadow={false}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(planet.id);
            }}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              const now = performance.now();
              if (event.pointerType === 'touch' && now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
                lastTouchRef.current = 0;
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                onPressCancel();
                onFocus(planet.id);
                return;
              }
              if (event.pointerType === 'touch') {
                lastTouchRef.current = now;
              }
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
              onSelect(planet.id, event);
            }}
            frustumCulled
          />
          {atmosphereBundle && (
            <AtmosphereStack
              geometry={planetGeometryActive}
              radius={planet.radius}
              bundle={atmosphereBundle}
              cloudSpinSpeed={cloudSpinSpeed}
              cloudNoiseSpeed={cloudNoiseSpeed}
              sunPosition={sunPosition}
            />
          )}
        </group>
        {planet.moons.map(moon => {
          const moonGeometryActive = highDetailBodyId === moon.id ? moonGeometryHigh : moonGeometry;
          return (
            <MoonOrbitGroup
              key={moon.id}
              moon={moon}
              orbitMaterial={orbitMaterial}
              moonGeometry={moonGeometryActive}
              moonMaterial={resolveMoonMaterial(moon)}
              resolveAtmosphereBundle={resolveAtmosphereBundle}
              spinReferenceRadius={moonSpinReferenceRadius}
              fixedTerminator={fixedTerminator}
              hitboxScaleMultiplier={hitboxScaleMultiplier}
              sunPosition={sunPosition}
              onPressStart={onPressStart}
              onPressMove={onPressMove}
              onPressEnd={onPressEnd}
              onPressCancel={onPressCancel}
              onFocus={onFocus}
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
  orbitMaterial: LineBasicMaterial;
  planetGeometry: SphereGeometry;
  planetGeometryHigh: SphereGeometry;
  moonGeometry: SphereGeometry;
  moonGeometryHigh: SphereGeometry;
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
  onBodyPressStart: (bodyId: string, event: ThreeEvent<PointerEvent>) => void;
  onBodyPressMove: (event: ThreeEvent<PointerEvent>) => void;
  onBodyPressEnd: () => void;
  onBodyPressCancel: () => void;
  onFocusBody: (bodyId: string) => void;
  onHoverBody: (bodyId: string) => void;
  onBlurBody: (bodyId: string) => void;
  onSelectBody: (bodyId: string, event: ThreeEvent<MouseEvent | PointerEvent>) => void;
}

export const SystemCelestialLayer: React.FC<SystemCelestialLayerProps> = ({
  stars,
  starGeometry,
  planets,
  orbitMaterial,
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
  onBodyPressStart,
  onBodyPressMove,
  onBodyPressEnd,
  onBodyPressCancel,
  onFocusBody,
  onHoverBody,
  onBlurBody,
  onSelectBody
}) => {
  return (
    <group name="SystemCelestialLayer">
      {stars.map((star) => (
        <group key={star.id} position={star.position}>
          <StarMesh
            radius={star.radius}
            tintColor={star.tintColor}
            surfaceTintColor={star.surfaceTintColor}
            geometry={starGeometry}
            seedKey={star.seedKey}
            spinReferenceRadius={starSpinReferenceRadius}
            enableLensFlare={star.data.role === 'primary'}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocusBody(star.id);
            }}
            onHover={() => onHoverBody(star.id)}
            onBlur={() => onBlurBody(star.id)}
            onSelect={(event) => onSelectBody(star.id, event)}
          />
        </group>
      ))}
      {planets.map(planet => (
        <PlanetOrbitGroup
          key={planet.id}
          planet={planet}
          orbitMaterial={orbitMaterial}
          planetGeometry={planetGeometry}
          planetGeometryHigh={planetGeometryHigh}
          moonGeometry={moonGeometry}
          moonGeometryHigh={moonGeometryHigh}
          planetMaterial={resolvePlanetMaterial(planet)}
          resolveMoonMaterial={resolveMoonMaterial}
          resolveAtmosphereBundle={resolveAtmosphereBundle}
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
          onFocus={onFocusBody}
          onHover={onHoverBody}
          onBlur={onBlurBody}
          onSelect={onSelectBody}
        />
      ))}
    </group>
  );
};
