
/**
 * Recursively freezes an object and its properties.
 * ONLY executes in Development mode. In Production, it simply returns the object.
 * This is used to enforce immutability in the Redux-like state management pattern.
 */
export function deepFreezeDev<T>(obj: T): T {
    const importMetaEnv = (import.meta as any)?.env;
    const isDevEnv = Boolean(importMetaEnv?.DEV);
    const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
    const isTestEnv = nodeEnv === 'test';
    const shouldFreeze = isDevEnv || isTestEnv;

    if (!shouldFreeze) {
        return obj;
    }

    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Object.isFrozen(obj)) {
        return obj;
    }

    const propNames = Object.getOwnPropertyNames(obj);

    for (const name of propNames) {
        const value = (obj as any)[name];
        deepFreezeDev(value);
    }

    return Object.freeze(obj);
}
