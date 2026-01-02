import { StarSystem } from '../../shared/types';

const MIN_PRIMARY_RADIUS_SUN = 0.2;
const MAX_PRIMARY_RADIUS_SUN = 5;

// Controls how much the physical stellar radius influences the map marker size.
// Kept below 1 to keep visuals close to the previous fixed size while still expressing variety.
export const STAR_RADIUS_INFLUENCE = 0.35;
export const STAR_ICON_BASE_SCALE = 1.5;
export const STAR_HITBOX_BASE_SCALE = 1;

/**
 * Returns a relative scale for a system marker based on its stellar data.
 *
 * We rely on the primary star radius so the visual stays anchored to the dominant body;
 * summing/averaging companions would overweight binaries and inflate icons without
 * changing gameplay. Missing or invalid astro data falls back to 1 to preserve the
 * previous default size.
 */
export function getSystemStarScale(system: StarSystem): number {
  const stars = system.astro?.stars;
  if (!stars || stars.length === 0) return 1;

  const primary = stars.find((star) => star.role === 'primary') ?? stars[0];
  if (!Number.isFinite(primary.radiusSun)) return 1;

  const clampedRadius = Math.min(Math.max(primary.radiusSun, MIN_PRIMARY_RADIUS_SUN), MAX_PRIMARY_RADIUS_SUN);
  return 1 + (clampedRadius - 1) * STAR_RADIUS_INFLUENCE;
}
