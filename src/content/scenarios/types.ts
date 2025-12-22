
import { ScenarioDefinitionV1 } from './schemaV1';

// The runtime scenario object includes the resolved seed
export type GameScenario = ScenarioDefinitionV1 & { seed: number };

// The static template definition (from JSON or code)
export type ScenarioTemplate = ScenarioDefinitionV1;
