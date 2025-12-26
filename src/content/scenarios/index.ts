
import { GameScenario, ScenarioTemplate } from './types';
import { SCENARIO_REGISTRY } from './registry';

export type { ScenarioTemplate };

export interface ScenarioBuildOptions {
  rules?: Partial<ScenarioTemplate['rules']>;
}

// Export the list of available templates for the UI
export const SCENARIO_TEMPLATES: ScenarioTemplate[] = SCENARIO_REGISTRY;

// Helper to hydrate a template into a full playable scenario
export const buildScenario = (templateId: string, seed: number, options?: ScenarioBuildOptions): GameScenario => {
  // Find template or fallback to first available
  const template = SCENARIO_TEMPLATES.find(t => t.id === templateId) || SCENARIO_TEMPLATES[0];
  
  if (!template) {
      throw new Error("No scenarios available in registry.");
  }

  // Determine Final Seed
  // If the scenario enforces a fixed seed (e.g. for a specific challenge), use it.
  // Otherwise use the provided runtime seed.
  const finalSeed = (template.generation.fixedSeed !== undefined && template.generation.fixedSeed !== null)
      ? template.generation.fixedSeed
      : seed;

  return {
    ...template,
    rules: {
      ...template.rules,
      ...(options?.rules ?? {})
    },
    seed: finalSeed
  };
};
