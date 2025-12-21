import { logger } from '../tools/devLogger';

// Deterministic Random Number Generator
// Algorithm: Mulberry32

export class RNG {
  private state: number;

  private static readonly GAUSSIAN_EPSILON = 1e-12;

  // Coefficients for Acklam's rational approximation of the probit (inverse normal CDF).
  // Source: https://web.archive.org/web/20150910002615/http://home.online.no/~pjacklam/notes/invnorm/
  private static readonly PROBIT_A = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.38357751867269e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00
  ];

  private static readonly PROBIT_B = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01
  ];

  private static readonly PROBIT_C = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00
  ];

  private static readonly PROBIT_D = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00
  ];

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
  // Deterministic across runtimes thanks to a rational approximation of the inverse CDF (Acklam).
  public gaussian(): number {
    // Clamp the uniform sample to avoid infinities at 0/1 boundaries across runtimes.
    const u = Math.min(
      1 - RNG.GAUSSIAN_EPSILON,
      Math.max(RNG.GAUSSIAN_EPSILON, this.next())
    );
    return this.inverseNormalProbit(u);
  }

  private inverseNormalProbit(p: number): number {
    const plow = 0.02425;
    const phigh = 1 - plow;

    if (p < plow) {
      const q = Math.sqrt(-2 * Math.log(p));
      return this.evaluateProbit(q, RNG.PROBIT_C, RNG.PROBIT_D);
    }

    if (p > phigh) {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -this.evaluateProbit(q, RNG.PROBIT_C, RNG.PROBIT_D);
    }

    const q = p - 0.5;
    const r = q * q;
    return (
      this.evaluateProbit(r, RNG.PROBIT_A, RNG.PROBIT_B) * q
    );
  }

  private evaluateProbit(x: number, numerator: number[], denominator: number[]): number {
    const num =
      (((((numerator[0] * x + numerator[1]) * x + numerator[2]) * x + numerator[3]) * x + numerator[4]) * x + numerator[5]);
    const den =
      (((((denominator[0] * x + denominator[1]) * x + denominator[2]) * x + denominator[3]) * x + (denominator[4] ?? 0)) * x + 1);
    return num / den;
  }
}
