// Compatibility barrel for scenario types + registry.
//
// Goal: keep the public import path stable (../content/scenarios)
// while ensuring scenario *data* lives in per-scenario files.

export * from './scenarios/schema';
export * from './scenarios/registry';
