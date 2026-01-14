import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  Color,
  FrontSide,
  MathUtils,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  SphereGeometry,
  type Blending,
  type Side,
  Vector2,
  Vector3
} from 'three';
import type { AtmosphereType } from '../../../../shared/shared';
import { CLOUD_NOISE_SPEED_MIN, DAY_NIGHT_TERMINATOR_SOFTNESS } from './config';

export type AtmosphereLayerBundle = {
  shell: { material: ShaderMaterial; scale: number };
  haze?: { material: ShaderMaterial; scale: number };
  clouds?: { material: ShaderMaterial; scale: number };
};

export type CloudLayerStyle = {
  color: string;
  shadowColor: string;
  baseAltitude: number;
  noiseScale: number;
  threshold: number;
  softness: number;
  opacity: number;
  rimPower: number;
  rimStrength: number;
  bandStrength: number;
  bandFrequency: number;
};

export type AtmosphereComposition = {
  N2: number;
  O2: number;
  CO2: number;
  CH4: number;
  H2: number;
  He: number;
  SO2: number;
  H2O: number;
  NH3: number;
};

export type AtmosphereParams = {
  planetClass: 'terrestrial' | 'gas';
  pressureAtm: number;
  scaleHeightKm: number;
  composition: AtmosphereComposition;
  aerosols: number;
  clouds: number;
  cloudAltitudeKm: number;
  storminess: number;
  albedoBoost: number;
  tintOverride?: Color;
};

export type AtmosphereCoeffs = {
  betaRayleigh: Color;
  betaMie: Color;
  absorption: Color;
  hazeTint: Color;
  mieG: number;
  thickness: number;
  rimPower: number;
  gasStrength: number;
  nightMin: number;
};

type AtmospherePreset = {
  composition: AtmosphereComposition;
  aerosols: number;
  clouds: number;
  storminess: number;
  scaleHeightKm: number;
  pressureAtm: number;
  albedoBoost?: number;
  cloudStyle?: CloudLayerStyle;
};

export const ATMOSPHERE_PRESETS: Record<Exclude<AtmosphereType, 'None'>, AtmospherePreset> = {
  Thin: {
    composition: { N2: 0.85, O2: 0.1, CO2: 0.04, CH4: 0, H2: 0, He: 0, SO2: 0.01, H2O: 0, NH3: 0 },
    aerosols: 0.03,
    clouds: 0.02,
    storminess: 0.03,
    scaleHeightKm: 4.5,
    pressureAtm: 0.18,
    albedoBoost: 0
  },
  Earthlike: {
    composition: { N2: 0.78, O2: 0.21, CO2: 0.01, CH4: 0, H2: 0, He: 0, SO2: 0, H2O: 0.02, NH3: 0 },
    aerosols: 0.25,
    clouds: 0.5,
    storminess: 0.3,
    scaleHeightKm: 8.8,
    pressureAtm: 1,
    albedoBoost: 0.03,
    cloudStyle: {
      color: '#f8fafc',
      shadowColor: '#64748b',
      baseAltitude: 0.006,
      noiseScale: 4.0,
      threshold: 0.56,
      softness: 0.08,
      opacity: 0.36,
      rimPower: 2.1,
      rimStrength: 0.3,
      bandStrength: 0,
      bandFrequency: 0
    }
  },
  CO2: {
    composition: { N2: 0.03, O2: 0, CO2: 0.95, CH4: 0, H2: 0, He: 0, SO2: 0.02, H2O: 0, NH3: 0 },
    aerosols: 0.85,
    clouds: 0.65,
    storminess: 0.2,
    scaleHeightKm: 11,
    pressureAtm: 8,
    albedoBoost: 0.22,
    cloudStyle: {
      color: '#fff7ed',
      shadowColor: '#a16207',
      baseAltitude: 0.009,
      noiseScale: 3.6,
      threshold: 0.6,
      softness: 0.09,
      opacity: 0.32,
      rimPower: 2.05,
      rimStrength: 0.24,
      bandStrength: 0,
      bandFrequency: 0
    }
  },
  H2He: {
    composition: { N2: 0, O2: 0, CO2: 0, CH4: 0.05, H2: 0.84, He: 0.09, SO2: 0, H2O: 0, NH3: 0.02 },
    aerosols: 0.65,
    clouds: 0.72,
    storminess: 0.7,
    scaleHeightKm: 48,
    pressureAtm: 24,
    albedoBoost: 0.12,
    cloudStyle: {
      color: '#f5f3ff',
      shadowColor: '#7c3aed',
      baseAltitude: 0.015,
      noiseScale: 7.6,
      threshold: 0.48,
      softness: 0.1,
      opacity: 0.5,
      rimPower: 1.9,
      rimStrength: 0.22,
      bandStrength: 0.9,
      bandFrequency: 20
    }
  }
};

export const ATMOSPHERE_EXAMPLE_PRESETS: Record<string, AtmosphereParams> = {
  earthlike: {
    planetClass: 'terrestrial',
    pressureAtm: 1,
    scaleHeightKm: 8.8,
    composition: { N2: 0.78, O2: 0.21, CO2: 0.01, CH4: 0, H2: 0, He: 0, SO2: 0, H2O: 0.02, NH3: 0 },
    aerosols: 0.25,
    clouds: 0.5,
    cloudAltitudeKm: 12,
    storminess: 0.3,
    albedoBoost: 0.03
  },
  marslike: {
    planetClass: 'terrestrial',
    pressureAtm: 0.1,
    scaleHeightKm: 5.5,
    composition: { N2: 0.03, O2: 0, CO2: 0.95, CH4: 0, H2: 0, He: 0, SO2: 0.02, H2O: 0, NH3: 0 },
    aerosols: 0.65,
    clouds: 0.04,
    cloudAltitudeKm: 8,
    storminess: 0.04,
    albedoBoost: 0.02
  },
  venuslike: {
    planetClass: 'terrestrial',
    pressureAtm: 35,
    scaleHeightKm: 13,
    composition: { N2: 0.03, O2: 0, CO2: 0.96, CH4: 0, H2: 0, He: 0, SO2: 0.01, H2O: 0, NH3: 0 },
    aerosols: 0.95,
    clouds: 0.85,
    cloudAltitudeKm: 22,
    storminess: 0.25,
    albedoBoost: 0.3
  },
  jupiterlike: {
    planetClass: 'gas',
    pressureAtm: 30,
    scaleHeightKm: 50,
    composition: { N2: 0, O2: 0, CO2: 0, CH4: 0.02, H2: 0.86, He: 0.1, SO2: 0, H2O: 0, NH3: 0.02 },
    aerosols: 0.68,
    clouds: 0.75,
    cloudAltitudeKm: 40,
    storminess: 0.75,
    albedoBoost: 0.12
  },
  neptunelike: {
    planetClass: 'gas',
    pressureAtm: 24,
    scaleHeightKm: 55,
    composition: { N2: 0, O2: 0, CO2: 0, CH4: 0.1, H2: 0.8, He: 0.08, SO2: 0, H2O: 0, NH3: 0.02 },
    aerosols: 0.55,
    clouds: 0.6,
    cloudAltitudeKm: 42,
    storminess: 0.6,
    albedoBoost: 0.08
  },
  titanlike: {
    planetClass: 'terrestrial',
    pressureAtm: 1.6,
    scaleHeightKm: 12,
    composition: { N2: 0.9, O2: 0, CO2: 0.02, CH4: 0.08, H2: 0, He: 0, SO2: 0, H2O: 0, NH3: 0 },
    aerosols: 0.8,
    clouds: 0.35,
    cloudAltitudeKm: 25,
    storminess: 0.25,
    albedoBoost: 0.12
  }
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizeComposition = (composition: AtmosphereComposition): AtmosphereComposition => {
  const total =
    composition.N2
    + composition.O2
    + composition.CO2
    + composition.CH4
    + composition.H2
    + composition.He
    + composition.SO2
    + composition.H2O
    + composition.NH3;
  if (total <= 0) {
    return { ...composition, N2: 1 };
  }
  const inv = 1 / total;
  return {
    N2: composition.N2 * inv,
    O2: composition.O2 * inv,
    CO2: composition.CO2 * inv,
    CH4: composition.CH4 * inv,
    H2: composition.H2 * inv,
    He: composition.He * inv,
    SO2: composition.SO2 * inv,
    H2O: composition.H2O * inv,
    NH3: composition.NH3 * inv
  };
};

export const deriveScatteringCoeffs = (params: AtmosphereParams): AtmosphereCoeffs => {
  const composition = normalizeComposition(params.composition);
  const pressure = MathUtils.clamp(params.pressureAtm, 0, 100);
  const scaleHeight = MathUtils.clamp(params.scaleHeightKm, 0.5, 80);
  const pressureNorm = MathUtils.clamp(Math.log10(pressure + 0.1) / 2, 0, 1);
  const scaleNorm = MathUtils.clamp(scaleHeight / 80, 0, 1);
  const gasStrength = params.planetClass === 'gas' ? MathUtils.clamp(0.5 + params.storminess * 0.5, 0.35, 1) : 0;

  const rayleighStrength = MathUtils.clamp(
    (composition.N2 + composition.O2) * 1.1
    + composition.H2 * 0.25
    + composition.He * 0.2
    - (composition.CO2 + composition.CH4 + composition.NH3) * 0.15,
    0.05,
    1.4
  );
  const mieStrength = MathUtils.clamp(
    0.15 + params.aerosols * 1.2 + params.clouds * 0.8 + pressureNorm * 0.8 + gasStrength * 0.4,
    0.1,
    2.5
  );

  const methaneAbsorb = MathUtils.clamp(composition.CH4 * 1.1 + composition.NH3 * 0.7, 0, 1);
  const co2Absorb = MathUtils.clamp(composition.CO2 * 0.9 + params.aerosols * 0.35, 0, 1);
  const so2Absorb = MathUtils.clamp(composition.SO2 * 0.6 + params.aerosols * 0.2, 0, 1);
  const absorbR = MathUtils.clamp(methaneAbsorb * (0.4 + pressureNorm), 0, 1.2);
  const absorbG = MathUtils.clamp(so2Absorb * (0.35 + pressureNorm * 0.6), 0, 1.1);
  const absorbB = MathUtils.clamp(co2Absorb * (0.45 + pressureNorm * 0.6), 0, 1.4);
  const absorption = new Color(absorbR, absorbG, absorbB);

  const rayleighTint = new Color(0.6, 0.75, 1.0)
    .lerp(new Color(1.0, 0.85, 0.7), clamp01(composition.CO2 + composition.SO2 * 0.7))
    .lerp(new Color(0.55, 0.85, 1.0), clamp01(composition.CH4 + composition.NH3));
  const mieTint = new Color(1, 1, 1)
    .lerp(new Color(1.0, 0.86, 0.68), clamp01(composition.CO2 + params.aerosols * 0.6))
    .lerp(new Color(0.7, 0.9, 1.0), clamp01(composition.CH4 + composition.NH3 * 0.5));

  if (params.tintOverride) {
    rayleighTint.copy(params.tintOverride);
  }

  const albedoBoost = 1 + MathUtils.clamp(params.albedoBoost, 0, 1) * 0.4;
  const baseRayleigh = (0.35 + pressureNorm * 0.9) * rayleighStrength * (0.6 + scaleNorm * 0.8) * albedoBoost;
  const baseMie = (0.25 + pressureNorm * 0.8) * mieStrength * (0.5 + scaleNorm * 0.6) * albedoBoost;
  const betaRayleigh = rayleighTint.clone().multiplyScalar(baseRayleigh);
  const betaMie = mieTint.clone().multiplyScalar(baseMie);
  const hazeTint = mieTint.clone().lerp(rayleighTint, 0.35);

  const mieG = MathUtils.clamp(0.6 + params.aerosols * 0.25 + pressureNorm * 0.2 + gasStrength * 0.1, 0.55, 0.92);
  const rimPower = params.planetClass === 'gas'
    ? MathUtils.lerp(1.6, 2.4, 1 - scaleNorm)
    : MathUtils.lerp(2.8, 4.1, 1 - pressureNorm);
  const thicknessBase = 0.01 + pressureNorm * 0.04 + scaleNorm * 0.08;
  const thickness = MathUtils.clamp(thicknessBase * (params.planetClass === 'gas' ? 1.5 : 1), 0.008, 0.25);
  const nightMin = MathUtils.clamp(0.02 + pressureNorm * 0.05 + gasStrength * 0.03, 0.02, 0.12);

  return {
    betaRayleigh,
    betaMie,
    absorption,
    hazeTint,
    mieG,
    thickness,
    rimPower,
    gasStrength,
    nightMin
  };
};

const fallbackAirMassIndex = (atmosphere: AtmosphereType): number => {
  switch (atmosphere) {
    case 'Thin':
      return 0.25;
    case 'Earthlike':
      return 0.6;
    case 'CO2':
      return 0.8;
    case 'H2He':
      return 1.0;
    default:
      return 0;
  }
};

export const resolveAirMassIndex = (
  airMassIndex: number | undefined,
  pressureBar: number | undefined,
  atmosphere: AtmosphereType
): number => {
  if (typeof airMassIndex === 'number' && Number.isFinite(airMassIndex)) {
    return MathUtils.clamp(airMassIndex, 0, 1);
  }

  if (typeof pressureBar === 'number' && Number.isFinite(pressureBar)) {
    const pressure = MathUtils.clamp(pressureBar, 0.01, 50);
    const normalized = (Math.log10(pressure) + 1) / 2;
    return MathUtils.clamp(normalized, 0, 1);
  }

  return fallbackAirMassIndex(atmosphere);
};

export const createAtmosphereShellMaterial = (params: {
  sunColor: Color;
  sunPosition: Vector3;
  coeffs: AtmosphereCoeffs;
  distanceNear: number;
  distanceFar: number;
  boostMax: number;
  hazeBase?: number;
  alphaScale?: number;
  side?: Side;
  blending?: Blending;
}): ShaderMaterial => {
  const side: Side = params.side ?? BackSide;
  const blending: Blending = params.blending ?? AdditiveBlending;
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending,
    side,
    uniforms: {
      uSunColor: { value: params.sunColor },
      uSunPosition: { value: params.sunPosition.clone() },
      uBetaRayleigh: { value: params.coeffs.betaRayleigh },
      uBetaMie: { value: params.coeffs.betaMie },
      uAbsorption: { value: params.coeffs.absorption },
      uHazeTint: { value: params.coeffs.hazeTint },
      uMieG: { value: params.coeffs.mieG },
      uRimPower: { value: params.coeffs.rimPower },
      uGasStrength: { value: params.coeffs.gasStrength },
      uNightMin: { value: params.coeffs.nightMin },
      uCamDist: { value: params.distanceFar },
      uDistParams: { value: new Vector2(params.distanceNear, params.distanceFar) },
      uBoostMax: { value: params.boostMax },
      uTerminatorSoftness: { value: DAY_NIGHT_TERMINATOR_SOFTNESS },
      uHazeBase: { value: params.hazeBase ?? 0 },
      uAlphaScale: { value: params.alphaScale ?? 1 }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunColor;
      uniform vec3 uSunPosition;
      uniform vec3 uBetaRayleigh;
      uniform vec3 uBetaMie;
      uniform vec3 uAbsorption;
      uniform vec3 uHazeTint;
      uniform float uMieG;
      uniform float uRimPower;
      uniform float uGasStrength;
      uniform float uNightMin;
      uniform float uCamDist;
      uniform vec2 uDistParams;
      uniform float uBoostMax;
      uniform float uTerminatorSoftness;
      uniform float uHazeBase;
      uniform float uAlphaScale;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;

      float saturate(float x) { return clamp(x, 0.0, 1.0); }
      float remap(float x, float a, float b, float c, float d) {
        float t = saturate((x - a) / max(b - a, 0.0001));
        return mix(c, d, t);
      }

      void main() {
        vec3 N = normalize(vWorldNormal);
        #ifdef FLIP_SIDED
          N = -N;
        #endif
        vec3 V = normalize(cameraPosition - vWorldPosition);
        vec3 sunVec = uSunPosition - vWorldPosition;
        float sunDistance = length(sunVec);
        vec3 L = sunDistance > 0.000001 ? (sunVec / sunDistance) : vec3(0.0, 0.0, 1.0);

        float NdotV = saturate(dot(N, V));
        float NdotL = saturate(dot(N, L));
        float rim = pow(1.0 - NdotV, uRimPower);

        float distanceBoost = remap(uCamDist, uDistParams.x, uDistParams.y, uBoostMax, 1.0);
        float lat = abs(N.y);
        float gasBand = mix(1.0, 0.8, smoothstep(0.2, 0.9, lat));
        float baseHaze = uHazeBase * (0.3 + 0.7 * NdotL) * (0.35 + 0.65 * NdotV);
        float optical = (rim + baseHaze) * distanceBoost * mix(1.0, gasBand, uGasStrength);

        float cosTheta = clamp(dot(V, L), -1.0, 1.0);
        float g = clamp(uMieG, 0.0, 0.95);
        float g2 = g * g;
        float miePhase = (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 0.0001), 1.5);
        miePhase = min(miePhase, 8.0);

        vec3 rayleigh = uBetaRayleigh * optical;
        vec3 mie = uBetaMie * optical * (0.35 + 0.65 * miePhase);
        vec3 scatter = rayleigh + mie;
        vec3 absorption = exp(-uAbsorption * optical);
        vec3 color = scatter * absorption;
        color = mix(color, color * uHazeTint, 0.35 + uGasStrength * 0.35);

        float terminator = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, NdotL);
        float night = mix(uNightMin, 1.0, terminator);
        color *= night;
        color *= uSunColor;

        float alpha = clamp((scatter.r + scatter.g + scatter.b) / 3.0, 0.0, 1.0);
        alpha *= night;
        alpha *= uAlphaScale;
        if (alpha <= 0.002) discard;

        gl_FragColor = vec4(color, alpha);
      }
    `,
    toneMapped: false
  });
};

export const createCloudLayerMaterial = (params: {
  sunColor: Color;
  sunPosition: Vector3;
  cloudColor: string;
  shadowColor: string;
  opacity: number;
  threshold: number;
  softness: number;
  noiseScale: number;
  seed: number;
  seed2: number;
  bandStrength: number;
  bandFrequency: number;
  bandOffset: number;
  rimPower: number;
  rimStrength: number;
  nightMin: number;
}): ShaderMaterial => {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    side: FrontSide,
    uniforms: {
      uSunColor: { value: params.sunColor },
      uSunPosition: { value: params.sunPosition.clone() },
      uCloudColor: { value: new Color(params.cloudColor) },
      uShadowColor: { value: new Color(params.shadowColor) },
      uOpacity: { value: params.opacity },
      uThreshold: { value: params.threshold },
      uSoftness: { value: params.softness },
      uNoiseScale: { value: params.noiseScale },
      uSeed: { value: params.seed },
      uSeed2: { value: params.seed2 },
      uBandStrength: { value: params.bandStrength },
      uBandFrequency: { value: params.bandFrequency },
      uBandOffset: { value: params.bandOffset },
      uRimPower: { value: params.rimPower },
      uRimStrength: { value: params.rimStrength },
      uNightMin: { value: params.nightMin },
      uTerminatorSoftness: { value: DAY_NIGHT_TERMINATOR_SOFTNESS },
      uTime: { value: 0 }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunColor;
      uniform vec3 uSunPosition;
      uniform vec3 uCloudColor;
      uniform vec3 uShadowColor;
      uniform float uOpacity;
      uniform float uThreshold;
      uniform float uSoftness;
      uniform float uNoiseScale;
      uniform float uSeed;
      uniform float uSeed2;
      uniform float uBandStrength;
      uniform float uBandFrequency;
      uniform float uBandOffset;
      uniform float uRimPower;
      uniform float uRimStrength;
      uniform float uNightMin;
      uniform float uTerminatorSoftness;
      uniform float uTime;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;

      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);

        float n000 = hash(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));

        float nx00 = mix(n000, n100, u.x);
        float nx10 = mix(n010, n110, u.x);
        float nx01 = mix(n001, n101, u.x);
        float nx11 = mix(n011, n111, u.x);
        float nxy0 = mix(nx00, nx10, u.y);
        float nxy1 = mix(nx01, nx11, u.y);
        return mix(nxy0, nxy1, u.z);
      }

      float fbm(vec3 p) {
        float value = 0.0;
        float amplitude = 0.55;
        for (int i = 0; i < 4; i += 1) {
          value += amplitude * noise(p);
          p = p * 2.02 + vec3(19.1, 7.7, 13.5);
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPosition);

        vec3 sunVec = uSunPosition - vWorldPosition;
        float sunDistance = length(sunVec);
        vec3 L = sunDistance > 0.000001 ? (sunVec / sunDistance) : vec3(0.0, 0.0, 1.0);

        float mu = dot(N, L);
        float day = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, mu);
        float daylight = mix(uNightMin, 1.0, day);

        vec3 seedVec = vec3(uSeed * 11.0, uSeed2 * 17.0, uSeed * 23.0);
        vec3 drift = vec3(uTime * 0.08, uTime * 0.04, uTime * 0.06);
        float n1 = fbm(N * uNoiseScale + seedVec + drift);
        float n2 = fbm(N * (uNoiseScale * 1.9) + vec3(uSeed2 * 31.0, uSeed * 37.0, uSeed2 * 41.0) + drift * 1.4);
        float field = mix(n1, n2, 0.35);

        float stripe = 0.5 + 0.5 * sin((N.y + uBandOffset + uTime * 0.02) * uBandFrequency);
        float band = smoothstep(0.25, 0.78, stripe);
        field *= mix(1.0, band, clamp(uBandStrength, 0.0, 1.0));

        float alpha = smoothstep(uThreshold, uThreshold + uSoftness, field) * uOpacity;
        if (alpha <= 0.001) discard;

        float diffuse = clamp(mu * 0.75 + 0.25, 0.0, 1.0);
        float nv = clamp(dot(N, V), 0.0, 1.0);
        float rim = pow(1.0 - nv, uRimPower) * uRimStrength;

        vec3 base = mix(uShadowColor, uCloudColor, diffuse);
        base = mix(base, uCloudColor, rim);
        vec3 color = base * uSunColor * daylight;

        gl_FragColor = vec4(color, alpha);
      }
    `
  });
};

export const AtmosphereStack: React.FC<{
  geometry: SphereGeometry;
  radius: number;
  bundle: AtmosphereLayerBundle;
  cloudSpinSpeed?: number;
  cloudNoiseSpeed?: number;
  sunPosition: Vector3;
}> = ({ geometry, radius, bundle, cloudSpinSpeed, cloudNoiseSpeed, sunPosition }) => {
  const { camera } = useThree();
  const shellMeshRef = useRef<Mesh>(null);
  const cloudRadius = bundle.clouds ? radius * bundle.clouds.scale : 0;
  const shellRadius = radius * bundle.shell.scale;
  const hazeRadius = bundle.haze ? radius * bundle.haze.scale : 0;
  const cloudMeshRef = useRef<Mesh>(null);
  const hazeMeshRef = useRef<Mesh>(null);
  const cloudTimeRef = useRef(0);
  const shellWorldRef = useRef(new Vector3());
  const cameraWorldRef = useRef(new Vector3());

  useEffect(() => {
    cloudTimeRef.current = 0;
    if (bundle.clouds?.material.uniforms.uTime) {
      bundle.clouds.material.uniforms.uTime.value = 0;
    }
  }, [bundle.clouds?.material]);
  useEffect(() => {
    if (bundle.shell.material.uniforms.uSunPosition) {
      bundle.shell.material.uniforms.uSunPosition.value.copy(sunPosition);
    }
    if (bundle.haze?.material.uniforms.uSunPosition) {
      bundle.haze.material.uniforms.uSunPosition.value.copy(sunPosition);
    }
    if (bundle.clouds?.material.uniforms.uSunPosition) {
      bundle.clouds.material.uniforms.uSunPosition.value.copy(sunPosition);
    }
  }, [bundle.clouds?.material, bundle.haze?.material, bundle.shell.material, sunPosition]);

  useFrame((_, delta) => {
    if (bundle.clouds) {
      if (cloudMeshRef.current && typeof cloudSpinSpeed === 'number') {
        cloudMeshRef.current.rotation.y += delta * cloudSpinSpeed;
      }
      if (bundle.clouds.material.uniforms.uTime) {
        const speed = cloudNoiseSpeed ?? CLOUD_NOISE_SPEED_MIN;
        cloudTimeRef.current += delta * speed;
        bundle.clouds.material.uniforms.uTime.value = cloudTimeRef.current;
      }
    }
    if (shellMeshRef.current) {
      camera.getWorldPosition(cameraWorldRef.current);
      shellMeshRef.current.getWorldPosition(shellWorldRef.current);
      const camDist = cameraWorldRef.current.distanceTo(shellWorldRef.current);
      if (bundle.shell.material.uniforms.uCamDist) {
        bundle.shell.material.uniforms.uCamDist.value = camDist;
      }
      if (bundle.haze?.material.uniforms.uCamDist) {
        bundle.haze.material.uniforms.uCamDist.value = camDist;
      }
    }
  });

  return (
    <group raycast={() => null}>
      {bundle.haze && (
        <mesh
          geometry={geometry}
          material={bundle.haze.material}
          scale={[hazeRadius, hazeRadius, hazeRadius]}
          castShadow={false}
          receiveShadow={false}
          frustumCulled
          raycast={() => null}
          renderOrder={3.2}
          ref={hazeMeshRef}
        />
      )}
      {bundle.clouds && (
        <mesh
          geometry={geometry}
          material={bundle.clouds.material}
          scale={[cloudRadius, cloudRadius, cloudRadius]}
          castShadow={false}
          receiveShadow={false}
          frustumCulled
          raycast={() => null}
          renderOrder={3.5}
          ref={cloudMeshRef}
        />
      )}
      <mesh
        geometry={geometry}
        material={bundle.shell.material}
        scale={[shellRadius, shellRadius, shellRadius]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled
        raycast={() => null}
        renderOrder={4}
        ref={shellMeshRef}
      />
    </group>
  );
};
