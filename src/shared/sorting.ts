export const sorted = <T>(items: readonly T[], compareFn?: (a: T, b: T) => number): T[] => {
  // eslint-disable-next-line no-restricted-syntax -- the copy ensures callers keep immutability
  return [...items].sort(compareFn);
};
