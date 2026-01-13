import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  LinearFilter,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PointsMaterial,
  SRGBColorSpace,
  Vector3
} from 'three';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { hashStringToUnit } from '../systemViewLayout';
import {
  LENS_FLARE_BASE_SIZE_MULTIPLIER,
  LENS_FLARE_BASE_STRENGTH,
  LENS_FLARE_CENTER_FADE_END,
  LENS_FLARE_CENTER_FADE_START,
  LENS_FLARE_INTENSITY_POWER,
  LENS_FLARE_SIZE_MAX_PX,
  LENS_FLARE_SIZE_MIN_PX,
  LENS_FLARE_STAR_DIAMETER_FADE_OUT_END_PX,
  LENS_FLARE_STAR_DIAMETER_FADE_OUT_START_PX,
  LENS_FLARE_STAR_DIAMETER_FULL_PX,
  LENS_FLARE_STAR_DIAMETER_MIN_PX,
  LENS_FLARE_TEXTURE_SIZE,
  STARFIELD_BACKDROP_SIZE,
  STARFIELD_BASE_COLOR,
  STARFIELD_BASE_TINT_STRENGTH,
  STARFIELD_NEBULA_LAYERS,
  STARFIELD_NEBULA_STRENGTH_MAX,
  STARFIELD_NEBULA_STRENGTH_MIN,
  STARFIELD_NEBULA_TINT_MAX,
  STARFIELD_NEBULA_TINT_MIN,
  STARFIELD_POINT_BRIGHT_FRACTION,
  STARFIELD_POINT_COUNT,
  STARFIELD_POINT_SIZE_BRIGHT,
  STARFIELD_POINT_SIZE_DIM,
  STAR_TEXTURE_SIZE
} from './config';
import { createSeededRandom, toRgbaString, useDisposableMemo } from './renderUtils';

const createStarSurfaceTexture = (surfaceTintColor: string, seed: number): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STAR_TEXTURE_SIZE;
  canvas.height = STAR_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const base = new Color('#ffffff');
  const tint = new Color(surfaceTintColor).lerp(base, 0.6);
  const highlight = base.clone().lerp(tint, 0.25);
  const shadow = base.clone().lerp(tint, 0.2).multiplyScalar(0.9);

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
  context.globalAlpha = 0.25;
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
    const tintSpot = base.clone().lerp(tint, 0.15 + rand() * 0.45);
    context.globalAlpha = 0.08 + rand() * 0.18;
    context.fillStyle = tintSpot.getStyle();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  for (let i = 0; i < darkBlobs; i += 1) {
    const radius = STAR_TEXTURE_SIZE * (0.02 + rand() * 0.07);
    const x = rand() * STAR_TEXTURE_SIZE;
    const y = rand() * STAR_TEXTURE_SIZE;
    const shade = base.clone().lerp(tint, 0.35).multiplyScalar(0.6 + rand() * 0.25);
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

const createStarfieldTexture = (seedKey: string, tintColor: string): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STARFIELD_BACKDROP_SIZE;
  canvas.height = STARFIELD_BACKDROP_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }
  context.imageSmoothingEnabled = false;
  const size = STARFIELD_BACKDROP_SIZE;
  const seed = Math.floor(hashStringToUnit(seedKey) * 0xffffffff);
  const rand = createSeededRandom(seed);
  const base = new Color(STARFIELD_BASE_COLOR);
  const tint = new Color(tintColor).lerp(new Color('#0b1020'), 0.92);

  const background = base.clone().lerp(tint, STARFIELD_BASE_TINT_STRENGTH);
  context.fillStyle = background.getStyle();
  context.fillRect(0, 0, size, size);

  context.globalCompositeOperation = 'source-over';
  for (let i = 0; i < STARFIELD_NEBULA_LAYERS; i += 1) {
    const radius = size * (0.18 + rand() * 0.32);
    const x = rand() * size;
    const y = rand() * size;
    const strength = STARFIELD_NEBULA_STRENGTH_MIN
      + rand() * (STARFIELD_NEBULA_STRENGTH_MAX - STARFIELD_NEBULA_STRENGTH_MIN);
    const nebula = base.clone().lerp(
      tint,
      STARFIELD_NEBULA_TINT_MIN + rand() * (STARFIELD_NEBULA_TINT_MAX - STARFIELD_NEBULA_TINT_MIN)
    );
    const cloud = context.createRadialGradient(x, y, 0, x, y, radius);
    cloud.addColorStop(0, toRgbaString(nebula, strength));
    cloud.addColorStop(1, toRgbaString(nebula, 0));
    context.fillStyle = cloud;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  context.globalCompositeOperation = 'source-over';

  texture.needsUpdate = true;
  return texture;
};

type StarfieldPointsData = {
  dimPositions: Float32Array;
  dimColors: Float32Array;
  brightPositions: Float32Array;
  brightColors: Float32Array;
};

const createStarfieldPointsData = (seedKey: string, tintColor: string): StarfieldPointsData => {
  const seed = Math.floor(hashStringToUnit(`${seedKey}-points`) * 0xffffffff);
  const rand = createSeededRandom(seed);
  const brightCount = Math.max(1, Math.round(STARFIELD_POINT_COUNT * STARFIELD_POINT_BRIGHT_FRACTION));
  const dimCount = Math.max(0, STARFIELD_POINT_COUNT - brightCount);
  const baseStar = new Color('#ffffff');
  const tint = new Color(tintColor).lerp(new Color('#0b1020'), 0.88);

  const makeBuffers = (count: number) => ({
    positions: new Float32Array(count * 3),
    colors: new Float32Array(count * 3)
  });
  const dim = makeBuffers(dimCount);
  const bright = makeBuffers(brightCount);

  const fill = (
    target: { positions: Float32Array; colors: Float32Array },
    minIntensity: number,
    maxIntensity: number
  ) => {
    for (let i = 0; i < target.positions.length; i += 3) {
      const u = rand();
      const v = rand();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const sinPhi = Math.sin(phi);
      const radius = 0.92 + rand() * 0.08;
      const x = Math.cos(theta) * sinPhi * radius;
      const y = Math.cos(phi) * radius;
      const z = Math.sin(theta) * sinPhi * radius;
      target.positions[i] = x;
      target.positions[i + 1] = y;
      target.positions[i + 2] = z;

      const tintMix = rand() * 0.35;
      const intensity = MathUtils.lerp(minIntensity, maxIntensity, Math.pow(rand(), 1.4));
      const r = MathUtils.lerp(baseStar.r, tint.r, tintMix) * intensity;
      const g = MathUtils.lerp(baseStar.g, tint.g, tintMix) * intensity;
      const b = MathUtils.lerp(baseStar.b, tint.b, tintMix) * intensity;
      target.colors[i] = r;
      target.colors[i + 1] = g;
      target.colors[i + 2] = b;
    }
  };

  fill(dim, 0.25, 0.6);
  fill(bright, 0.65, 1.1);

  return {
    dimPositions: dim.positions,
    dimColors: dim.colors,
    brightPositions: bright.positions,
    brightColors: bright.colors
  };
};

const createStarGlowTexture = (tintColor: string): CanvasTexture => {
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

  const base = new Color('#ffffff');
  const tint = new Color(tintColor).lerp(base, 0.55);
  const inner = base.clone().lerp(tint, 0.3);
  const outer = base.clone().lerp(tint, 0.4).multiplyScalar(0.55);
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

const createLensFlareHaloTexture = (): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = LENS_FLARE_TEXTURE_SIZE;
  canvas.height = LENS_FLARE_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const center = LENS_FLARE_TEXTURE_SIZE * 0.5;
  const gradient = context.createRadialGradient(center, center, LENS_FLARE_TEXTURE_SIZE * 0.04, center, center, center);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.75)');
  gradient.addColorStop(0.2, 'rgba(255, 255, 255, 0.28)');
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, LENS_FLARE_TEXTURE_SIZE, LENS_FLARE_TEXTURE_SIZE);

  texture.needsUpdate = true;
  return texture;
};

const createLensFlareRingTexture = (): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = LENS_FLARE_TEXTURE_SIZE;
  canvas.height = LENS_FLARE_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const center = LENS_FLARE_TEXTURE_SIZE * 0.5;
  context.translate(center, center);
  context.globalCompositeOperation = 'lighter';

  context.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  context.lineWidth = LENS_FLARE_TEXTURE_SIZE * 0.08;
  context.beginPath();
  context.arc(0, 0, LENS_FLARE_TEXTURE_SIZE * 0.22, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  context.lineWidth = LENS_FLARE_TEXTURE_SIZE * 0.028;
  context.beginPath();
  context.arc(0, 0, LENS_FLARE_TEXTURE_SIZE * 0.36, 0, Math.PI * 2);
  context.stroke();

  const haze = context.createRadialGradient(0, 0, 0, 0, 0, LENS_FLARE_TEXTURE_SIZE * 0.5);
  haze.addColorStop(0, 'rgba(255, 255, 255, 0)');
  haze.addColorStop(0.5, 'rgba(255, 255, 255, 0.06)');
  haze.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = haze;
  context.beginPath();
  context.arc(0, 0, LENS_FLARE_TEXTURE_SIZE * 0.5, 0, Math.PI * 2);
  context.fill();

  texture.needsUpdate = true;
  return texture;
};

export const SystemStarfield: React.FC<{ radius: number; seedKey: string; tintColor: string }> = ({
  radius,
  seedKey,
  tintColor
}) => {
  const groupRef = useRef<Group>(null);
  const { camera } = useThree();
  const texture = useMemo(() => createStarfieldTexture(seedKey, tintColor), [seedKey, tintColor]);
  const starGeometries = useMemo(() => {
    const data = createStarfieldPointsData(seedKey, tintColor);
    const dimGeometry = new BufferGeometry();
    dimGeometry.setAttribute('position', new BufferAttribute(data.dimPositions, 3));
    dimGeometry.setAttribute('color', new BufferAttribute(data.dimColors, 3));
    const brightGeometry = new BufferGeometry();
    brightGeometry.setAttribute('position', new BufferAttribute(data.brightPositions, 3));
    brightGeometry.setAttribute('color', new BufferAttribute(data.brightColors, 3));
    return { dimGeometry, brightGeometry };
  }, [seedKey, tintColor]);
  const dimMaterial = useMemo(() => new PointsMaterial({
    size: STARFIELD_POINT_SIZE_DIM,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false
  }), []);
  const brightMaterial = useMemo(() => new PointsMaterial({
    size: STARFIELD_POINT_SIZE_BRIGHT,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    toneMapped: false
  }), []);

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.copy(camera.position);
    }
  });

  useEffect(() => {
    return () => {
      texture.dispose();
      starGeometries.dimGeometry.dispose();
      starGeometries.brightGeometry.dispose();
      dimMaterial.dispose();
      brightMaterial.dispose();
    };
  }, [brightMaterial, dimMaterial, starGeometries, texture]);

  const starScale = radius * 0.98;

  return (
    <group ref={groupRef} frustumCulled={false} renderOrder={-20} raycast={() => null}>
      <mesh renderOrder={-20} raycast={() => null}>
        <sphereGeometry args={[radius, 48, 32]} />
        <meshBasicMaterial map={texture} side={BackSide} depthWrite={false} toneMapped={false} />
      </mesh>
      <points
        geometry={starGeometries.dimGeometry}
        material={dimMaterial}
        scale={[starScale, starScale, starScale]}
        renderOrder={-19}
        frustumCulled={false}
        raycast={() => null}
      />
      <points
        geometry={starGeometries.brightGeometry}
        material={brightMaterial}
        scale={[starScale, starScale, starScale]}
        renderOrder={-18}
        frustumCulled={false}
        raycast={() => null}
      />
    </group>
  );
};

export const SystemRimLight: React.FC<{
  intensity: number;
  color: string;
  distance: number;
  target: [number, number, number];
}> = ({ intensity, color, distance, target }) => {
  const lightRef = useRef<DirectionalLight>(null);
  const targetObject = useMemo(() => new Object3D(), []);
  const { camera } = useThree();
  const targetVec = useMemo(() => new Vector3(), []);
  const viewDir = useMemo(() => new Vector3(), []);
  const rightDir = useMemo(() => new Vector3(), []);
  const upDir = useMemo(() => new Vector3(), []);

  useEffect(() => {
    if (lightRef.current) {
      lightRef.current.target = targetObject;
    }
  }, [targetObject]);

  useFrame(() => {
    const light = lightRef.current;
    if (!light) return;
    targetVec.set(target[0], target[1], target[2]);
    viewDir.copy(targetVec).sub(camera.position).normalize();
    rightDir.crossVectors(viewDir, camera.up).normalize();
    upDir.copy(camera.up).normalize();
    light.position
      .copy(targetVec)
      .addScaledVector(viewDir, distance)
      .addScaledVector(rightDir, distance * 0.08)
      .addScaledVector(upDir, distance * 0.04);
    targetObject.position.copy(targetVec);
    targetObject.updateMatrixWorld();
  });

  return (
    <>
      <directionalLight ref={lightRef} intensity={intensity} color={color} castShadow={false} />
      <primitive object={targetObject} raycast={() => null} />
    </>
  );
};

interface StarMeshProps {
  radius: number;
  tintColor: string;
  surfaceTintColor: string;
  geometry: BufferGeometry;
  seedKey: string;
  spinReferenceRadius: number;
  enableLensFlare?: boolean;
  lensFlareStrength?: number;
  onDoubleClick?: (event: ThreeEvent<MouseEvent | PointerEvent>) => void;
  onHover?: () => void;
  onBlur?: () => void;
  onSelect?: (event: ThreeEvent<MouseEvent | PointerEvent>) => void;
}

export const StarMesh: React.FC<StarMeshProps> = ({
  radius,
  tintColor,
  surfaceTintColor,
  geometry,
  seedKey,
  spinReferenceRadius: _spinReferenceRadius,
  enableLensFlare = true,
  lensFlareStrength = LENS_FLARE_BASE_STRENGTH,
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
    () => createStarSurfaceTexture(surfaceTintColor, seed),
    [seed, surfaceTintColor]
  );
  const glowTexture = useDisposableMemo(
    () => createStarGlowTexture(tintColor),
    [tintColor]
  );
  const coreMaterial = useDisposableMemo(
    () => {
      const coreColor = new Color('#ffffff')
        .lerp(new Color(tintColor), 0.25)
        .multiplyScalar(0.85);
      return new MeshBasicMaterial({
        color: coreColor,
        map: surfaceTexture,
        toneMapped: true
      });
    },
    [surfaceTexture, tintColor]
  );
  const innerGlowMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: new Color('#ffffff').lerp(new Color(tintColor), 0.25),
      map: glowTexture,
      transparent: true,
      opacity: 0.08,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    }),
    [glowTexture, tintColor]
  );
  const outerGlowMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: new Color('#ffffff').lerp(new Color(tintColor), 0.2),
      map: glowTexture,
      transparent: true,
      opacity: 0.025,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    }),
    [glowTexture, tintColor]
  );
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;

  const scale = useMemo<[number, number, number]>(() => [radius, radius, radius], [radius]);
  const innerGlowScale = useMemo<[number, number, number]>(
    () => [radius * 1.08, radius * 1.08, radius * 1.08],
    [radius]
  );
  const outerGlowScale = useMemo<[number, number, number]>(
    () => [radius * 1.28, radius * 1.28, radius * 1.28],
    [radius]
  );
  const groupRef = useRef<Group | null>(null);
  const coreRef = useRef<Mesh | null>(null);
  const lensFlareState = useMemo(() => {
    if (!enableLensFlare || lensFlareStrength <= 0) return null;

    const lensflare = new Lensflare();
    lensflare.raycast = () => null;

    const haloTexture = createLensFlareHaloTexture();
    const ghostTexture = createLensFlareHaloTexture();
    const ringTexture = createLensFlareRingTexture();

    const base = new Color('#ffffff');
    const tint = new Color(tintColor);
    const haloBaseColor = base.clone().lerp(tint, 0.5);
    const ringBaseColor = base.clone().lerp(tint, 0.35);
    const ghostBaseColor = base.clone().lerp(tint, 0.25);

    const halo = new LensflareElement(haloTexture, 256, 0, haloBaseColor.clone());
    const ring = new LensflareElement(ringTexture, 180, 0.08, ringBaseColor.clone());
    const ghost = new LensflareElement(ghostTexture, 96, 0.62, ghostBaseColor.clone());

    lensflare.addElement(halo);
    lensflare.addElement(ring);
    lensflare.addElement(ghost);

    return {
      lensflare,
      elements: [halo, ring, ghost],
      baseColors: [haloBaseColor, ringBaseColor, ghostBaseColor],
      sizeScales: [1, 0.75, 0.42],
      intensityScales: [1, 0.85, 0.65],
      haloTexture,
      ghostTexture,
      ringTexture,
      smoothed: {
        intensity: 0,
        baseSizePx: LENS_FLARE_SIZE_MIN_PX
      },
      scratch: {
        starWorld: new Vector3(),
        lensWorld: new Vector3(),
        lensLocal: new Vector3(),
        projected: new Vector3(),
        toCamera: new Vector3()
      }
    };
  }, [enableLensFlare, lensFlareStrength, tintColor]);

  useEffect(() => {
    return () => {
      if (!lensFlareState) return;
      lensFlareState.lensflare.dispose();
      lensFlareState.haloTexture.dispose();
      lensFlareState.ghostTexture.dispose();
      lensFlareState.ringTexture.dispose();
    };
  }, [lensFlareState]);

  useFrame((state, delta) => {
    if (!coreRef.current) return;
    const group = groupRef.current;
    const lensflare = lensFlareState?.lensflare ?? null;
    if (!group || !lensflare || !lensFlareState) return;

    const { scratch, elements, baseColors, sizeScales, intensityScales, smoothed } = lensFlareState;
    group.getWorldPosition(scratch.starWorld);
    scratch.toCamera.copy(state.camera.position).sub(scratch.starWorld);
    const distanceToCamera = scratch.toCamera.length();
    if (!Number.isFinite(distanceToCamera) || distanceToCamera < 0.001) {
      smoothed.intensity = MathUtils.damp(smoothed.intensity, 0, 10, delta);
      lensflare.visible = false;
      return;
    }

    const viewportHeightPx = state.size.height * state.gl.getPixelRatio();
    const fovRad = (state.camera as PerspectiveCamera).isPerspectiveCamera
      ? MathUtils.degToRad((state.camera as PerspectiveCamera).fov)
      : MathUtils.degToRad(55);
    const starDiameterPx = (radius / distanceToCamera) * (viewportHeightPx / Math.tan(fovRad * 0.5));
    const targetBaseSizePx = MathUtils.clamp(
      starDiameterPx * LENS_FLARE_BASE_SIZE_MULTIPLIER,
      LENS_FLARE_SIZE_MIN_PX,
      LENS_FLARE_SIZE_MAX_PX
    );

    scratch.toCamera.divideScalar(distanceToCamera);
    scratch.lensWorld.copy(scratch.starWorld).addScaledVector(scratch.toCamera, radius * 1.02);
    scratch.lensLocal.copy(scratch.lensWorld);
    group.worldToLocal(scratch.lensLocal);
    lensflare.position.copy(scratch.lensLocal);

    scratch.projected.copy(scratch.lensWorld).project(state.camera);
    const onScreen = scratch.projected.z > -1
      && scratch.projected.z < 1
      && Math.abs(scratch.projected.x) <= 1.15
      && Math.abs(scratch.projected.y) <= 1.15;

    const centerDist = Math.sqrt(scratch.projected.x * scratch.projected.x + scratch.projected.y * scratch.projected.y);
    const centerFactor = MathUtils.smoothstep(centerDist, LENS_FLARE_CENTER_FADE_START, LENS_FLARE_CENTER_FADE_END);
    const sizeFactor = MathUtils.smoothstep(starDiameterPx, LENS_FLARE_STAR_DIAMETER_MIN_PX, LENS_FLARE_STAR_DIAMETER_FULL_PX);
    const closeFactor = 1 - MathUtils.smoothstep(
      starDiameterPx,
      LENS_FLARE_STAR_DIAMETER_FADE_OUT_START_PX,
      LENS_FLARE_STAR_DIAMETER_FADE_OUT_END_PX
    );
    const targetIntensity = onScreen
      ? MathUtils.clamp(Math.pow(centerFactor, LENS_FLARE_INTENSITY_POWER) * sizeFactor * closeFactor * lensFlareStrength, 0, 1)
      : 0;

    smoothed.intensity = MathUtils.damp(smoothed.intensity, targetIntensity, 12, delta);
    smoothed.baseSizePx = MathUtils.damp(smoothed.baseSizePx, targetBaseSizePx, 12, delta);

    const shouldShow = onScreen && smoothed.intensity > 0.01;
    lensflare.visible = shouldShow;
    if (!shouldShow) return;

    const baseSizePx = smoothed.baseSizePx;

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      element.size = baseSizePx * sizeScales[index];
      element.color.copy(baseColors[index]).multiplyScalar(smoothed.intensity * intensityScales[index]);
    }
  });

  return (
    <group ref={groupRef}>
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
          onSelect?.(event);
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
      {lensFlareState?.lensflare && (
        <primitive object={lensFlareState.lensflare} dispose={null} />
      )}
    </group>
  );
};
