import type { MoonType, PlanetType } from '../../../../shared/shared';

export const KM_PER_AU = 149_597_870.7;
export const EARTH_RADIUS_KM = 6_371;
export const SOLAR_RADIUS_KM = 695_700;
export const KM_TO_SCENE_SCALE = 1 / 10_000_000;
export const RADIUS_VISIBILITY_BONUS = 25;
export const MIN_PLANET_RADIUS = 0.12;
export const MIN_STAR_RADIUS = 0.5;
export const ORBIT_THICKNESS = 0.012;
export const DEFAULT_ORBIT_INNER_KM = 55_000_000;
export const DEFAULT_ORBIT_STEP_KM = 35_000_000;

export const STAR_TEXTURE_SIZE = 256;
export const STARFIELD_BACKDROP_SIZE = 1024;
export const STARFIELD_POINT_COUNT = 3200;
export const STARFIELD_POINT_BRIGHT_FRACTION = 0.12;
export const STARFIELD_POINT_SIZE_DIM = 1.15;
export const STARFIELD_POINT_SIZE_BRIGHT = 2.1;
export const STARFIELD_NEBULA_LAYERS = 4;
export const STARFIELD_BASE_COLOR = '#04060c';
export const STARFIELD_BASE_TINT_STRENGTH = 0.08;
export const STARFIELD_NEBULA_STRENGTH_MIN = 0.015;
export const STARFIELD_NEBULA_STRENGTH_MAX = 0.045;
export const STARFIELD_NEBULA_TINT_MIN = 0.2;
export const STARFIELD_NEBULA_TINT_MAX = 0.45;

export const BODY_SPIN_SPEED_MIN = 0.0035;
export const BODY_SPIN_SPEED_MAX = 0.011;
export const BODY_SPIN_SPEED_MULTIPLIER = 2;
export const SPIN_SCALE_EXPONENT = 0.6;
export const PLANET_SPIN_SCALE_MIN = 0.6;
export const PLANET_SPIN_SCALE_MAX = 2.4;
export const MOON_SPIN_SCALE_MIN = 0.7;
export const MOON_SPIN_SCALE_MAX = 2.6;
export const STAR_SPIN_SCALE_MIN = 0.55;
export const STAR_SPIN_SCALE_MAX = 1.8;
export const PLANET_SPIN_REFERENCE_RADIUS_FACTOR = 2.4;
export const MOON_SPIN_REFERENCE_RADIUS_FACTOR = 2.8;
export const STAR_SPIN_REFERENCE_RADIUS_FACTOR = 3.0;
export const CLOUD_SPIN_MULTIPLIER_MIN = 1.2;
export const CLOUD_SPIN_MULTIPLIER_MAX = 1.6;
export const CLOUD_NOISE_SPEED_MIN = 0.015;
export const CLOUD_NOISE_SPEED_MAX = 0.045;

export const LENS_FLARE_TEXTURE_SIZE = 128;
export const LENS_FLARE_BASE_STRENGTH = 0.32;
export const LENS_FLARE_CENTER_FADE_START = 0.12;
export const LENS_FLARE_CENTER_FADE_END = 0.65;
export const LENS_FLARE_INTENSITY_POWER = 2.4;
export const LENS_FLARE_STAR_DIAMETER_MIN_PX = 8;
export const LENS_FLARE_STAR_DIAMETER_FULL_PX = 48;
export const LENS_FLARE_STAR_DIAMETER_FADE_OUT_START_PX = 380;
export const LENS_FLARE_STAR_DIAMETER_FADE_OUT_END_PX = 720;
export const LENS_FLARE_BASE_SIZE_MULTIPLIER = 2.0;
export const LENS_FLARE_SIZE_MIN_PX = 18;
export const LENS_FLARE_SIZE_MAX_PX = 220;

export const STAR_TINT_STRENGTH = 0.18;
export const STAR_FALLBACK_TINT_STRENGTH = 0.08;
export const STAR_SURFACE_TINT_STRENGTH = 0.2;
export const MIN_STAR_TEMPERATURE_K = 1000;
export const MAX_STAR_TEMPERATURE_K = 40000;

export const DAYS_PER_YEAR = 365.25;
export const MIN_PLANET_ORBIT_INCLINATION_DEG = 0.35;
export const MAX_PLANET_ORBIT_INCLINATION_DEG = 10;
export const MIN_MOON_ORBIT_INCLINATION_DEG = 0.25;
export const MAX_MOON_ORBIT_INCLINATION_DEG = 14;

export const MAX_DPR_MOBILE = 1.25;
export const MAX_DPR_DESKTOP = 2;
export const POST_FX_MSAA_SAMPLES_DESKTOP = 4;
export const POST_FX_MSAA_SAMPLES_MOBILE = 2;

export const SYSTEM_VIEW_CAMERA_MAX_DISTANCE_FACTOR = 5.5;
export const SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR = 1.06;

export const SURFACE_NORMAL_SCALE = 0.85;
export const SURFACE_AO_INTENSITY = 0.6;
export const SURFACE_DISPLACEMENT_SCALE = 0.02;
export const SURFACE_DISPLACEMENT_BIAS = -0.01;

export const DAY_NIGHT_TERMINATOR_SOFTNESS = 0.22;
export const DAY_NIGHT_NIGHT_MIN = 0.12;

export const THERMAL_COLD_START_C = -80;
export const THERMAL_COLD_END_C = -5;
export const THERMAL_WARM_START_C = 20;
export const THERMAL_WARM_END_C = 160;
export const THERMAL_HOT_START_C = 220;
export const THERMAL_HOT_END_C = 900;

export const PLANET_TYPE_COLORS: Record<PlanetType, string> = {
  Terrestrial: '#22c55e',
  SubNeptune: '#38bdf8',
  IceGiant: '#7dd3fc',
  GasGiant: '#c084fc',
  Dwarf: '#94a3b8'
};

export const MOON_TYPE_COLORS: Record<MoonType, string> = {
  Regular: '#9ca3af',
  Icy: '#cbd5f5',
  Volcanic: '#f97316',
  Eden: '#22c55e',
  Irregular: '#f59e0b'
};

export const SPECTRAL_TINTS: Record<string, string> = {
  O: '#9bb0ff',
  B: '#aabfff',
  A: '#cad7ff',
  F: '#f8f7ff',
  G: '#fff1d6',
  K: '#ffd2a1',
  M: '#ffcc6f'
};
