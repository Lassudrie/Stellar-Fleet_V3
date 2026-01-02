// Stable 32-bit hashing helpers (no dependencies).
// Used for deterministic planet surface generation.

/**
 * FNV-1a 32-bit hash.
 * Returns an unsigned uint32.
 */
export const fnv1a32 = (value: string): number => {
  let hash = 0x811c9dc5; // offset basis
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // hash *= 16777619 (with uint32 overflow)
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export const hashJoin32 = (...parts: Array<string | number | boolean | null | undefined>): number => {
  const s = parts.map(p => (p === null || p === undefined ? '' : String(p))).join('|');
  return fnv1a32(s);
};

