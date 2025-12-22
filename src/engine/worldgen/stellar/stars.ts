import { RNG } from '../../rng';
import { SpectralType, StarData } from '../../../shared/types';
import { MULTIPLICITY_PROBABILITY, STELLAR_CLASS_BOUNDS } from './constants';
import { clamp } from './random';

export function typeFromMassSun(massSun: number): SpectralType {
  if (massSun < 0.45) return 'M';
  if (massSun < 0.8) return 'K';
  if (massSun < 1.04) return 'G';
  if (massSun < 1.4) return 'F';
  if (massSun < 2.1) return 'A';
  if (massSun < 16) return 'B';
  return 'O';
}

export function drawStarCount(rng: RNG, primaryType: SpectralType): number {
  const pMulti = MULTIPLICITY_PROBABILITY[primaryType];
  if (rng.next() > pMulti) return 1;
  return rng.next() < 0.85 ? 2 : 3;
}

export function drawCompanionMasses(rng: RNG, primaryMassSun: number, count: number): number[] {
  const masses: number[] = [];
  for (let i = 0; i < count; i++) {
    const q = rng.range(0.1, 1.0);
    const m = clamp(q * primaryMassSun, 0.08, 60);
    masses.push(m);
  }
  return masses;
}

export function computeLuminositySun(massSun: number): number {
  if (massSun <= 0.43) return 0.23 * Math.pow(massSun, 2.3);
  if (massSun <= 2) return 1.0 * Math.pow(massSun, 3.9);
  return 1.5 * Math.pow(massSun, 3.5);
}

export function computeRadiusSun(massSun: number): number {
  if (massSun <= 1) return Math.pow(massSun, 0.8);
  return Math.pow(massSun, 0.57);
}

export function refineStar(rng: RNG, type: SpectralType, massSun: number, role: 'primary' | 'companion'): StarData {
  const bounds = STELLAR_CLASS_BOUNDS[type];
  const m = clamp(massSun, bounds.massSun[0], bounds.massSun[1]);
  const luminositySun = computeLuminositySun(m);
  const radiusSun = computeRadiusSun(m);
  const teffK = rng.range(bounds.teffK[0], bounds.teffK[1]);

  return {
    role,
    spectralType: type,
    massSun: m,
    radiusSun,
    luminositySun,
    teffK
  };
}
