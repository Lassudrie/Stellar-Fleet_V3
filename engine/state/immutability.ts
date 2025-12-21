
const isDevOrTestEnv = () => {
  const metaEnv = (import.meta as any)?.env;

  if (metaEnv?.DEV || metaEnv?.MODE === 'test') {
    return true;
  }

  if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'test') {
    return true;
  }

  return false;
};

/**
 * Recursively freezes an object and its properties.
 * ONLY executes in Development or Test modes. In Production, it simply returns the object.
 * This is used to enforce immutability in the Redux-like state management pattern.
 */
export function deepFreezeDev<T>(obj: T): T {
  if (!isDevOrTestEnv()) {
    return obj;
  }

  // Basic type check
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // If already frozen, return
  if (Object.isFrozen(obj)) {
    return obj;
  }

  // Retrieve the property names defined on object
  const propNames = Object.getOwnPropertyNames(obj);

  // Freeze properties before freezing self
  for (const name of propNames) {
    const value = (obj as any)[name];
    deepFreezeDev(value);
  }

  return Object.freeze(obj);
}
