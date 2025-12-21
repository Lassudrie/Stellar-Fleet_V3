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
    let u = 0, v = 0;
    while(u === 0) u = this.next();
    while(v === 0) v = this.next();
    return Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
  }
}
