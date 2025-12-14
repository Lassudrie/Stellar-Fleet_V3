
/**
 * Recursively freezes an object and its properties.
 * ONLY executes in Development mode. In Production, it simply returns the object.
 * This is used to enforce immutability in the Redux-like state management pattern.
 */
export function deepFreezeDev<T>(obj: T): T {
    // Check for Vite/Env dev mode safely
    if ((import.meta as any).env && (import.meta as any).env.DEV) {
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
    
    return obj;
}
