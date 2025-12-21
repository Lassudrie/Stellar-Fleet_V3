import { logger } from '../tools/devLogger';

// Deterministic Random Number Generator
// Algorithm: Mulberry32

export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = this.normalizeState(seed);
  }

  // --- STATE MANAGEMENT ---

  // Retrieve current internal state for serialization
  public getState(): number {
    return this.state;
  }

  // Restore internal state from serialization
  // Normalizes the value to ensure valid 32-bit unsigned integer range
  public setState(state: number): void {
    this.state = this.normalizeState(state);
  }

  // Normalize state to valid 32-bit unsigned integer
  // Handles NaN, Infinity, negatives, and non-integers
  private normalizeState(value: number): number {
    // Handle invalid values
    if (!Number.isFinite(value)) {
      logger.warn('[RNG] Invalid state value, defaulting to 1');
      return 1;
    }
    // Convert to 32-bit unsigned integer (handles negatives and non-integers)
    return (Math.floor(Math.abs(value)) >>> 0) || 1; // Ensure non-zero
  }

  // --- GENERATION ---

  // Returns an unsigned 32-bit integer (0 to 4294967295)
  // This exposes the raw output of the Mulberry32 algorithm
  public nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  // Returns a float between 0 and 1
  public next(): number {
    return this.nextUint32() / 4294967296;
  }

  // Returns a float between min (inclusive) and max (exclusive)
  public range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  // Returns an integer between min (inclusive) and max (inclusive)
  public int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  // Helper for picking array element
  // Returns undefined if array is empty (safe guard against crash)
  public pick<T>(array: T[]): T | undefined {
    if (array.length === 0) {
      logger.debug('[RNG] pick() called on empty array, returning undefined');
      return undefined;
    }
    return array[Math.floor(this.next() * array.length)];
  }

  // Deterministic ID Generator
  // Uses full 32-bit entropy converted to Hex (8 chars) to minimize collisions
  public id(prefix: string): string {
    const hex = this.nextUint32().toString(16).padStart(8, '0');
    return `${prefix}_${hex}`;
  }

  // Gaussian / Normal distribution approximation
  public gaussian(): number {
    // Deterministic inverse-CDF approximation (Acklam, 2003)
    // Avoids platform-dependent trig implementations used in Box-Muller
    // while keeping output stable across runtimes for the same seed.
    const p = Math.min(Math.max(this.next(), Number.EPSILON), 1 - Number.EPSILON);

    // Coefficients for central region approximation
    const a0 = -3.969683028665376e+01;
    const a1 = 2.209460984245205e+02;
    const a2 = -2.759285104469687e+02;
    const a3 = 1.383577518672690e+02;
    const a4 = -3.066479806614716e+01;
    const a5 = 2.506628277459239e+00;

    // Coefficients for tail approximation
    const b0 = -5.447609879822406e+01;
    const b1 = 1.615858368580409e+02;
    const b2 = -1.556989798598866e+02;
    const b3 = 6.680131188771972e+01;
    const b4 = -1.328068155288572e+01;

    const c0 = -7.784894002430293e-03;
    const c1 = -3.223964580411365e-01;
    const c2 = -2.400758277161838e+00;
    const c3 = -2.549732539343734e+00;
    const c4 = 4.374664141464968e+00;
    const c5 = 2.938163982698783e+00;

    const d0 = 7.784695709041462e-03;
    const d1 = 3.224671290700398e-01;
    const d2 = 2.445134137142996e+00;
    const d3 = 3.754408661907416e+00;

    // Breakpoints for rational approximations
    const pLow = 0.02425;
    const pHigh = 1 - pLow;

    if (p < pLow) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
        ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
    }

    if (p > pHigh) {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
        ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
    }

    const q = p - 0.5;
    const r = q * q;
    return (((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q /
      (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
  }
}
