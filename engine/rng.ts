import { logger } from '../tools/devLogger';

// Deterministic Random Number Generator
// Algorithm: Mulberry32

const PROBIT_A = [
  -3.969683028665376e+01,
  2.209460984245205e+02,
  -2.759285104469687e+02,
  1.383577518672690e+02,
  -3.066479806614716e+01,
  2.506628277459239e+00
];

const PROBIT_B = [
  -5.447609879822406e+01,
  1.615858368580409e+02,
  -1.556989798598866e+02,
  6.680131188771972e+01,
  -1.328068155288572e+01
];

const PROBIT_C = [
  -7.784894002430293e-03,
  -3.223964580411365e-01,
  -2.400758277161838e+00,
  -2.549732539343734e+00,
  4.374664141464968e+00,
  2.938163982698783e+00
];

const PROBIT_D = [
  7.784695709041462e-03,
  3.224671290700398e-01,
  2.445134137142996e+00,
  3.754408661907416e+00
];

const PROBIT_C_TAIL_DENOMINATOR = [...PROBIT_D, 1];
const PROBIT_B_CENTRAL_DENOMINATOR = [...PROBIT_B, 1];
const PROBIT_P_LOW = 0.02425;
const PROBIT_P_HIGH = 1 - PROBIT_P_LOW;

const evaluatePolynomial = (coefficients: number[], x: number): number =>
  coefficients.reduce((accumulator, coefficient) => (accumulator * x) + coefficient, 0);

const evaluateTail = (q: number): number =>
  evaluatePolynomial(PROBIT_C, q) / evaluatePolynomial(PROBIT_C_TAIL_DENOMINATOR, q);

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

  private inverseStandardNormal(probability: number): number {
    const p = Math.min(Math.max(probability, Number.EPSILON), 1 - Number.EPSILON);

    if (p < PROBIT_P_LOW) {
      const q = Math.sqrt(-2 * Math.log(p));
      return evaluateTail(q);
    }

    if (p > PROBIT_P_HIGH) {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -evaluateTail(q);
    }

    const q = p - 0.5;
    const r = q * q;
    const numerator = evaluatePolynomial(PROBIT_A, r);
    const denominator = evaluatePolynomial(PROBIT_B_CENTRAL_DENOMINATOR, r);
    return (numerator / denominator) * q;
  }

  // Gaussian / Normal distribution approximation
  public gaussian(): number {
    // Deterministic inverse-CDF approximation (Acklam, 2003)
    // Avoids platform-dependent trig implementations used in Box-Muller
    // while keeping output stable across runtimes for the same seed.
    return this.inverseStandardNormal(this.next());
  }
}
