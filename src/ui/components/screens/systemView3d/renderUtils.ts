import { useEffect, useMemo, type DependencyList } from 'react';
import { BufferAttribute, BufferGeometry, Color, MathUtils, Material, MeshStandardMaterial, Vector3 } from 'three';
import {
  DAY_NIGHT_NIGHT_MIN,
  DAY_NIGHT_TERMINATOR_SOFTNESS,
  MAX_STAR_TEMPERATURE_K,
  MIN_STAR_TEMPERATURE_K,
  SPECTRAL_TINTS,
  STAR_FALLBACK_TINT_STRENGTH,
  STAR_SURFACE_TINT_STRENGTH,
  STAR_TINT_STRENGTH,
  THERMAL_COLD_END_C,
  THERMAL_COLD_START_C,
  THERMAL_HOT_END_C,
  THERMAL_HOT_START_C,
  THERMAL_WARM_END_C,
  THERMAL_WARM_START_C
} from './config';

const THERMAL_TINT_COLD = new Color('#8fb8ff');
const THERMAL_TINT_WARM = new Color('#f3b36a');
const THERMAL_TINT_HOT = new Color('#e37246');
const THERMAL_COLD_STRENGTH = 0.5;
const THERMAL_WARM_STRENGTH = 0.45;
const THERMAL_HOT_STRENGTH = 0.3;

export const useDisposableMemo = <T extends { dispose: () => void }>(
  factory: () => T,
  deps: DependencyList
): T => {
  const resource = useMemo(factory, deps);
  useEffect(() => () => {
    resource.dispose();
  }, [resource]);
  return resource;
};

type CubeSphereFace = {
  normal: Vector3;
  axisU: Vector3;
  axisV: Vector3;
};

const CUBE_SPHERE_FACES: CubeSphereFace[] = [
  { normal: new Vector3(1, 0, 0), axisU: new Vector3(0, 0, -1), axisV: new Vector3(0, 1, 0) },
  { normal: new Vector3(-1, 0, 0), axisU: new Vector3(0, 0, 1), axisV: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 1, 0), axisU: new Vector3(1, 0, 0), axisV: new Vector3(0, 0, -1) },
  { normal: new Vector3(0, -1, 0), axisU: new Vector3(1, 0, 0), axisV: new Vector3(0, 0, 1) },
  { normal: new Vector3(0, 0, 1), axisU: new Vector3(1, 0, 0), axisV: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 0, -1), axisU: new Vector3(-1, 0, 0), axisV: new Vector3(0, 1, 0) }
];

const toSphereUv = (direction: Vector3): [number, number] => {
  const normalized = direction.clone().normalize();
  const u = 0.5 + Math.atan2(normalized.z, normalized.x) / (Math.PI * 2);
  const v = 0.5 - Math.asin(MathUtils.clamp(normalized.y, -1, 1)) / Math.PI;
  return [u, v];
};

export const buildCubeSphereGeometry = (segments: number): BufferGeometry => {
  const safeSegments = Math.max(2, Math.floor(segments));
  const faceVertexCount = (safeSegments + 1) * (safeSegments + 1);
  const totalVertices = faceVertexCount * CUBE_SPHERE_FACES.length;
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const indices = new Uint32Array(CUBE_SPHERE_FACES.length * safeSegments * safeSegments * 6);

  let vertexOffset = 0;
  let uvOffset = 0;
  let indexOffset = 0;
  let baseVertex = 0;

  CUBE_SPHERE_FACES.forEach((face) => {
    for (let y = 0; y <= safeSegments; y += 1) {
      const v = y / safeSegments;
      const vCoord = v * 2 - 1;
      for (let x = 0; x <= safeSegments; x += 1) {
        const u = x / safeSegments;
        const uCoord = u * 2 - 1;
        const point = new Vector3()
          .copy(face.normal)
          .addScaledVector(face.axisU, uCoord)
          .addScaledVector(face.axisV, vCoord)
          .normalize();
        positions[vertexOffset] = point.x;
        positions[vertexOffset + 1] = point.y;
        positions[vertexOffset + 2] = point.z;
        normals[vertexOffset] = point.x;
        normals[vertexOffset + 1] = point.y;
        normals[vertexOffset + 2] = point.z;
        const [uTex, vTex] = toSphereUv(point);
        uvs[uvOffset] = uTex;
        uvs[uvOffset + 1] = vTex;
        vertexOffset += 3;
        uvOffset += 2;
      }
    }

    for (let y = 0; y < safeSegments; y += 1) {
      for (let x = 0; x < safeSegments; x += 1) {
        const a = baseVertex + y * (safeSegments + 1) + x;
        const b = baseVertex + (y + 1) * (safeSegments + 1) + x;
        const c = baseVertex + (y + 1) * (safeSegments + 1) + (x + 1);
        const d = baseVertex + y * (safeSegments + 1) + (x + 1);
        indices[indexOffset] = a;
        indices[indexOffset + 1] = b;
        indices[indexOffset + 2] = d;
        indices[indexOffset + 3] = b;
        indices[indexOffset + 4] = c;
        indices[indexOffset + 5] = d;
        indexOffset += 6;
      }
    }

    baseVertex += faceVertexCount;
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('uv2', new BufferAttribute(uvs.slice(), 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
};

export const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

export const toRgbaString = (color: Color, alpha: number): string => {
  const r = Math.round(MathUtils.clamp(color.r, 0, 1) * 255);
  const g = Math.round(MathUtils.clamp(color.g, 0, 1) * 255);
  const b = Math.round(MathUtils.clamp(color.b, 0, 1) * 255);
  const a = MathUtils.clamp(alpha, 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const resolveThermalTint = (temperatureK: number | undefined): Color | null => {
  if (!Number.isFinite(temperatureK)) return null;
  const tempC = (temperatureK as number) - 273.15;
  const coldWeight = 1 - smoothstep(THERMAL_COLD_START_C, THERMAL_COLD_END_C, tempC);
  const warmWeight = smoothstep(THERMAL_WARM_START_C, THERMAL_WARM_END_C, tempC);
  const hotWeight = smoothstep(THERMAL_HOT_START_C, THERMAL_HOT_END_C, tempC);
  const tint = new Color('#ffffff');
  if (coldWeight > 0) {
    tint.lerp(THERMAL_TINT_COLD, coldWeight * THERMAL_COLD_STRENGTH);
  }
  if (warmWeight > 0) {
    tint.lerp(THERMAL_TINT_WARM, warmWeight * THERMAL_WARM_STRENGTH);
  }
  if (hotWeight > 0) {
    tint.lerp(THERMAL_TINT_HOT, hotWeight * THERMAL_HOT_STRENGTH);
  }
  return tint;
};

export const resolveThermalTints = (
  baseColor: string,
  temperatureK: number | undefined
): { baseColor: string; surfaceTint: string } => {
  const tint = resolveThermalTint(temperatureK);
  if (!tint) {
    return { baseColor, surfaceTint: '#ffffff' };
  }
  const tintedBase = new Color(baseColor).multiply(tint);
  return { baseColor: tintedBase.getStyle(), surfaceTint: tint.getStyle() };
};

export const linearToSrgb = (value: number): number => {
  if (value <= 0.0031308) return 12.92 * value;
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
};

export const linearToSrgbByte = (value: number): number =>
  Math.round(MathUtils.clamp(linearToSrgb(value), 0, 1) * 255);

export const getSpectralTint = (spectralType: string | undefined, fallback?: string): string => {
  const key = spectralType?.trim().charAt(0).toUpperCase();
  const tint = key ? SPECTRAL_TINTS[key] : undefined;
  const base = new Color('#ffffff');
  if (tint) {
    return base.clone().lerp(new Color(tint), STAR_TINT_STRENGTH).getStyle();
  }
  if (fallback) {
    return base.clone().lerp(new Color(fallback), STAR_FALLBACK_TINT_STRENGTH).getStyle();
  }
  return base.getStyle();
};

export const temperatureToColor = (temperatureK: number | undefined): Color | null => {
  if (!Number.isFinite(temperatureK)) return null;
  const clampedK = MathUtils.clamp(temperatureK, MIN_STAR_TEMPERATURE_K, MAX_STAR_TEMPERATURE_K);
  const temp = clampedK / 100;
  let red = 255;
  let green = 0;
  let blue = 255;

  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }

  const clampChannel = (value: number) => MathUtils.clamp(value, 0, 255) / 255;
  return new Color(clampChannel(red), clampChannel(green), clampChannel(blue));
};

export const getSurfaceTintFromTemperature = (temperatureK: number | undefined, fallback: string): string => {
  const tempColor = temperatureToColor(temperatureK);
  if (!tempColor) {
    return fallback;
  }
  return new Color('#ffffff').lerp(tempColor, STAR_SURFACE_TINT_STRENGTH).getStyle();
};

export const applyDayNightTerminator = (
  material: MeshStandardMaterial,
  options?: { nightMin?: number; terminatorSoftness?: number; sunPosition?: Vector3 | [number, number, number] }
) => {
  const sunPosition = options?.sunPosition
    ? options.sunPosition instanceof Vector3
      ? options.sunPosition
      : new Vector3(...options.sunPosition)
    : new Vector3(0, 0, 0);
  if (material.userData.dayNightTerminatorApplied) {
    if (options) {
      material.userData.dayNightNightMin = options.nightMin ?? DAY_NIGHT_NIGHT_MIN;
      material.userData.dayNightTerminatorSoftness = options.terminatorSoftness ?? DAY_NIGHT_TERMINATOR_SOFTNESS;
      material.userData.dayNightSunPosition = sunPosition;
      const uniforms = material.userData.dayNightUniforms as {
        nightMin?: { value: number };
        softness?: { value: number };
        sunPosition?: { value: Vector3 };
      } | undefined;
      if (uniforms?.nightMin) {
        uniforms.nightMin.value = material.userData.dayNightNightMin;
      }
      if (uniforms?.softness) {
        uniforms.softness.value = material.userData.dayNightTerminatorSoftness;
      }
      if (uniforms?.sunPosition) {
        uniforms.sunPosition.value.copy(material.userData.dayNightSunPosition);
      }
    }
    return;
  }
  material.userData.dayNightTerminatorApplied = true;
  material.userData.dayNightNightMin = options?.nightMin ?? DAY_NIGHT_NIGHT_MIN;
  material.userData.dayNightTerminatorSoftness = options?.terminatorSoftness ?? DAY_NIGHT_TERMINATOR_SOFTNESS;
  material.userData.dayNightSunPosition = sunPosition;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNightMin = { value: material.userData.dayNightNightMin };
    shader.uniforms.uTerminatorSoftness = { value: material.userData.dayNightTerminatorSoftness };
    shader.uniforms.uSunPosition = { value: material.userData.dayNightSunPosition.clone() };
    material.userData.dayNightUniforms = {
      nightMin: shader.uniforms.uNightMin,
      softness: shader.uniforms.uTerminatorSoftness,
      sunPosition: shader.uniforms.uSunPosition
    };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 sfWorldPosition = modelMatrix * vec4(transformed, 1.0);
vWorldPosition = sfWorldPosition.xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
uniform float uNightMin;
uniform float uTerminatorSoftness;
uniform vec3 uSunPosition;`
      )
      .replace(
        '#include <opaque_fragment>',
        `vec3 sunVec = uSunPosition - vWorldPosition;
float sunDistance = length(sunVec);
vec3 sunDir = sunDistance > 0.000001 ? (sunVec / sunDistance) : vec3(0.0, 0.0, 1.0);
float nDotL = dot(normalize(vWorldNormal), sunDir);
float terminator = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, nDotL);
float nightMask = 1.0 - terminator;
vec3 emissiveRadiance = totalEmissiveRadiance;
vec3 lit = outgoingLight - emissiveRadiance;
vec3 nightFill = diffuseColor.rgb * uNightMin;
lit = mix(nightFill, lit, terminator);
outgoingLight = lit + emissiveRadiance * nightMask;
#include <opaque_fragment>`
      );
  };

  material.customProgramCacheKey = () => 'sf_day_night_terminator_v3';
  material.needsUpdate = true;
};

export const applyMaterialOpacity = (material: Material | Material[], opacity: number) => {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((mat) => {
    mat.opacity = opacity;
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.toneMapped = false;
  });
};
