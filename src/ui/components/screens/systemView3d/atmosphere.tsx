import React, { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  BackSide,
  Color,
  FrontSide,
  MathUtils,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  SphereGeometry
} from 'three';
import type { AtmosphereType } from '../../../../shared/shared';
import { CLOUD_NOISE_SPEED_MIN, DAY_NIGHT_TERMINATOR_SOFTNESS } from './config';

export type AtmosphereLayerBundle = {
  lower: { material: ShaderMaterial; scale: number };
  haze: { material: ShaderMaterial; scale: number };
  clouds?: { material: ShaderMaterial; scale: number };
};

type CloudLayerStyle = {
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

type AtmosphereLayerStyle = {
  rayleighColor: string;
  mieColor: string;
  sunsetColor: string;
  baseThickness: number;
  mieG: number;
  lower: {
    intensity: number;
    density: number;
    rimPower: number;
    miePower: number;
    mieStrength: number;
    sunsetStrength: number;
    nightMin: number;
  };
  haze: {
    intensity: number;
    density: number;
    rimPower: number;
    miePower: number;
    mieStrength: number;
    sunsetStrength: number;
    nightMin: number;
    thicknessMultiplier: number;
  };
  clouds?: CloudLayerStyle;
};

export const ATMOSPHERE_STYLE: Record<Exclude<AtmosphereType, 'None'>, AtmosphereLayerStyle> = {
  Thin: {
    rayleighColor: '#a5f3fc',
    mieColor: '#ffffff',
    sunsetColor: '#ffd7aa',
    baseThickness: 0.02,
    mieG: 0.55,
    lower: {
      intensity: 0.32,
      density: 0.75,
      rimPower: 2.6,
      miePower: 10,
      mieStrength: 0.18,
      sunsetStrength: 0.55,
      nightMin: 0.08
    },
    haze: {
      intensity: 0.16,
      density: 0.5,
      rimPower: 3.2,
      miePower: 9,
      mieStrength: 0.12,
      sunsetStrength: 0.45,
      nightMin: 0.06,
      thicknessMultiplier: 1.85
    }
  },
  Earthlike: {
    rayleighColor: '#38bdf8',
    mieColor: '#f8fafc',
    sunsetColor: '#ffb36b',
    baseThickness: 0.035,
    mieG: 0.68,
    lower: {
      intensity: 0.4,
      density: 0.9,
      rimPower: 2.45,
      miePower: 11,
      mieStrength: 0.26,
      sunsetStrength: 0.9,
      nightMin: 0.09
    },
    haze: {
      intensity: 0.2,
      density: 0.6,
      rimPower: 3.15,
      miePower: 10,
      mieStrength: 0.18,
      sunsetStrength: 0.75,
      nightMin: 0.07,
      thicknessMultiplier: 1.9
    },
    clouds: {
      color: '#f8fafc',
      shadowColor: '#64748b',
      baseAltitude: 0.006,
      noiseScale: 4.2,
      threshold: 0.58,
      softness: 0.08,
      opacity: 0.34,
      rimPower: 2.2,
      rimStrength: 0.28,
      bandStrength: 0,
      bandFrequency: 0
    }
  },
  CO2: {
    rayleighColor: '#fb923c',
    mieColor: '#fff7ed',
    sunsetColor: '#ff6b3d',
    baseThickness: 0.048,
    mieG: 0.86,
    lower: {
      intensity: 0.45,
      density: 1.0,
      rimPower: 2.35,
      miePower: 11,
      mieStrength: 0.22,
      sunsetStrength: 1.05,
      nightMin: 0.1
    },
    haze: {
      intensity: 0.24,
      density: 0.7,
      rimPower: 3.05,
      miePower: 10,
      mieStrength: 0.16,
      sunsetStrength: 0.9,
      nightMin: 0.08,
      thicknessMultiplier: 1.95
    },
    clouds: {
      color: '#fff7ed',
      shadowColor: '#a16207',
      baseAltitude: 0.008,
      noiseScale: 3.8,
      threshold: 0.62,
      softness: 0.09,
      opacity: 0.28,
      rimPower: 2.15,
      rimStrength: 0.22,
      bandStrength: 0,
      bandFrequency: 0
    }
  },
  H2He: {
    rayleighColor: '#a78bfa',
    mieColor: '#f5f3ff',
    sunsetColor: '#fbcfe8',
    baseThickness: 0.09,
    mieG: 0.9,
    lower: {
      intensity: 0.6,
      density: 1.15,
      rimPower: 2.15,
      miePower: 9,
      mieStrength: 0.35,
      sunsetStrength: 0.5,
      nightMin: 0.12
    },
    haze: {
      intensity: 0.32,
      density: 0.9,
      rimPower: 2.8,
      miePower: 8,
      mieStrength: 0.28,
      sunsetStrength: 0.35,
      nightMin: 0.1,
      thicknessMultiplier: 2.05
    },
    clouds: {
      color: '#f5f3ff',
      shadowColor: '#7c3aed',
      baseAltitude: 0.014,
      noiseScale: 7.2,
      threshold: 0.5,
      softness: 0.1,
      opacity: 0.45,
      rimPower: 2.0,
      rimStrength: 0.2,
      bandStrength: 0.85,
      bandFrequency: 18
    }
  }
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

export const createAtmosphereLayerMaterial = (params: {
  sunColor: Color;
  rayleighColor: string;
  mieColor: string;
  sunsetColor: string;
  intensity: number;
  density: number;
  rimPower: number;
  miePower: number;
  mieStrength: number;
  mieG: number;
  sunsetStrength: number;
  nightMin: number;
}): ShaderMaterial => {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
    uniforms: {
      uSunColor: { value: params.sunColor },
      uRayleighColor: { value: new Color(params.rayleighColor) },
      uMieColor: { value: new Color(params.mieColor) },
      uSunsetColor: { value: new Color(params.sunsetColor) },
      uIntensity: { value: params.intensity },
      uDensity: { value: params.density },
      uRimPower: { value: params.rimPower },
      uMiePower: { value: params.miePower },
      uMieStrength: { value: params.mieStrength },
      uMieG: { value: params.mieG },
      uSunsetStrength: { value: params.sunsetStrength },
      uNightMin: { value: params.nightMin },
      uTerminatorSoftness: { value: DAY_NIGHT_TERMINATOR_SOFTNESS }
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
      uniform vec3 uRayleighColor;
      uniform vec3 uMieColor;
      uniform vec3 uSunsetColor;
      uniform float uIntensity;
      uniform float uDensity;
      uniform float uRimPower;
      uniform float uMiePower;
      uniform float uMieStrength;
      uniform float uMieG;
      uniform float uSunsetStrength;
      uniform float uNightMin;
      uniform float uTerminatorSoftness;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;

      void main() {
        vec3 N = normalize(vWorldNormal);
        #ifdef FLIP_SIDED
          N = -N;
        #endif
        vec3 V = normalize(cameraPosition - vWorldPosition);

        float sunDistance = length(vWorldPosition);
        vec3 L = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);

        float mu = dot(N, L);
        float g = clamp(uMieG, 0.0, 0.92);
        float g2 = g * g;
        float terminatorSoftness = uTerminatorSoftness * mix(1.0, 1.6, smoothstep(0.5, 0.9, g));
        float day = smoothstep(-terminatorSoftness, terminatorSoftness, mu);
        float daylight = mix(uNightMin, 1.0, day);

        float nv = clamp(dot(N, V), 0.0, 1.0);
        float opticalDepth = clamp(1.0 - nv, 0.0, 1.0);
        float density = 1.0 - exp(-uDensity * opticalDepth * 2.2);
        float limb = pow(opticalDepth, uRimPower);
        float depth = limb * density;

        float cosTheta = clamp(dot(V, L), -1.0, 1.0);
        float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);
        float miePhase = (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 0.0001), 1.5);
        float miePhaseScale = 0.25 + 0.015 * uMiePower;
        miePhase = min(miePhase * miePhaseScale, 6.0);
        float mieAnisotropyDamp = mix(1.0, 0.65, smoothstep(0.6, 0.9, g));
        float rayleigh = depth * rayleighPhase;
        float mie = miePhase * depth * uMieStrength * mieAnisotropyDamp;

        float terminatorBand = 1.0 - smoothstep(0.0, terminatorSoftness * 2.5, abs(mu));
        float twilight = terminatorBand * (0.35 + 0.65 * rayleighPhase);
        float sunset = twilight * depth * uSunsetStrength;

        float scatter = rayleigh + mie + sunset;
        if (scatter <= 0.00001) discard;

        vec3 scatterColor = (uRayleighColor * rayleigh + uMieColor * mie + uSunsetColor * sunset) / max(scatter, 0.0001);
        float alphaScatter = min(scatter, 1.15);
        float alpha = clamp(alphaScatter * uIntensity * daylight, 0.0, 1.0);
        vec3 color = uSunColor * scatterColor;

        gl_FragColor = vec4(color, alpha);
      }
    `,
    toneMapped: false
  });
};

export const createCloudLayerMaterial = (params: {
  sunColor: Color;
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

        float sunDistance = length(vWorldPosition);
        vec3 L = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);

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
}> = ({ geometry, radius, bundle, cloudSpinSpeed, cloudNoiseSpeed }) => {
  const cloudRadius = bundle.clouds ? radius * bundle.clouds.scale : 0;
  const lowerRadius = radius * bundle.lower.scale;
  const hazeRadius = radius * bundle.haze.scale;
  const cloudMeshRef = useRef<Mesh>(null);
  const cloudTimeRef = useRef(0);

  useEffect(() => {
    cloudTimeRef.current = 0;
    if (bundle.clouds?.material.uniforms.uTime) {
      bundle.clouds.material.uniforms.uTime.value = 0;
    }
  }, [bundle.clouds?.material]);

  useFrame((_, delta) => {
    if (!bundle.clouds) return;
    if (cloudMeshRef.current && typeof cloudSpinSpeed === 'number') {
      cloudMeshRef.current.rotation.y += delta * cloudSpinSpeed;
    }
    if (bundle.clouds.material.uniforms.uTime) {
      const speed = cloudNoiseSpeed ?? CLOUD_NOISE_SPEED_MIN;
      cloudTimeRef.current += delta * speed;
      bundle.clouds.material.uniforms.uTime.value = cloudTimeRef.current;
    }
  });

  return (
    <group raycast={() => null}>
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
        material={bundle.lower.material}
        scale={[lowerRadius, lowerRadius, lowerRadius]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled
        raycast={() => null}
        renderOrder={4}
      />
      <mesh
        geometry={geometry}
        material={bundle.haze.material}
        scale={[hazeRadius, hazeRadius, hazeRadius]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled
        raycast={() => null}
        renderOrder={5}
      />
    </group>
  );
};
