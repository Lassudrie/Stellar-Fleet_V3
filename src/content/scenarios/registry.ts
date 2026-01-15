import { ShipType, devError, devWarn, sorted } from '../../shared/shared';
import { GameScenario, ScenarioTemplate } from './schema';
import { templatesToLoad } from './templates';

/**
 * Scenario registry + builder.
 *
 * Important design goal:
 * - Scenario *data* must live only in per-scenario files under ./templates.
 * - This file contains runtime logic: loading, validation, sorting, and buildScenario().
 */

/**
 * Validates a raw JSON object against the ScenarioTemplate V1 schema.
 * Performs structural checks and basic referential integrity checks.
 */
function validateScenarioV1(data: unknown, fileName: string): ScenarioTemplate | null {
  try {
    if (typeof data !== 'object' || data === null) throw new Error('Not a JSON object');
    const s = data as any;

    // 1. Root fields
    if (s.schemaVersion !== 1) throw new Error(`Unsupported schemaVersion: ${s.schemaVersion}`);
    if (typeof s.id !== 'string' || !s.id) throw new Error("Missing or invalid 'id'");

    // 2. Meta
    if (!s.meta || typeof s.meta !== 'object') throw new Error("Missing 'meta'");
    if (typeof s.meta.title !== 'string') throw new Error("Missing 'meta.title'");
    if (typeof s.meta.description !== 'string') throw new Error("Missing 'meta.description'");

    // 3. Generation
    if (!s.generation || typeof s.generation !== 'object') throw new Error("Missing 'generation'");
    if (typeof s.generation.systemCount !== 'number') throw new Error("Missing 'generation.systemCount'");
    if (typeof s.generation.radius !== 'number') throw new Error("Missing 'generation.radius'");
    if (typeof s.generation.topology !== 'string') throw new Error("Missing 'generation.topology'");

    // 3b. Optional Generation Constraints
    if (s.generation.minimumSystemSpacingLy !== undefined && s.generation.minimumSystemSpacingLy !== null) {
      if (typeof s.generation.minimumSystemSpacingLy !== 'number' || !Number.isFinite(s.generation.minimumSystemSpacingLy)) {
        throw new Error("Invalid 'generation.minimumSystemSpacingLy' (expected a finite number)");
      }
      if (s.generation.minimumSystemSpacingLy < 0) {
        throw new Error("Invalid 'generation.minimumSystemSpacingLy' (must be >= 0; use 0 to disable)");
      }
    }

    // 3c. Optional Settlement Config
    if (s.generation.settlements !== undefined && s.generation.settlements !== null) {
      const sc = s.generation.settlements as any;
      if (typeof sc !== 'object') throw new Error("Invalid 'generation.settlements' (expected an object)");
      if (sc.neutralOutpostChance !== undefined && sc.neutralOutpostChance !== null) {
        if (typeof sc.neutralOutpostChance !== 'number' || !isFinite(sc.neutralOutpostChance) || sc.neutralOutpostChance < 0 || sc.neutralOutpostChance > 1) {
          throw new Error("Invalid 'generation.settlements.neutralOutpostChance' (expected 0..1)");
        }
      }
      if (sc.neutralOutpostRuinsChance !== undefined && sc.neutralOutpostRuinsChance !== null) {
        if (typeof sc.neutralOutpostRuinsChance !== 'number' || !isFinite(sc.neutralOutpostRuinsChance) || sc.neutralOutpostRuinsChance < 0 || sc.neutralOutpostRuinsChance > 1) {
          throw new Error("Invalid 'generation.settlements.neutralOutpostRuinsChance' (expected 0..1)");
        }
      }
      if (sc.developmentBias !== undefined && sc.developmentBias !== null) {
        if (typeof sc.developmentBias !== 'number' || !isFinite(sc.developmentBias) || sc.developmentBias < -1 || sc.developmentBias > 1) {
          throw new Error("Invalid 'generation.settlements.developmentBias' (expected -1..1)");
        }
      }
    }

    // 4. Setup
    if (!s.setup || typeof s.setup !== 'object') throw new Error("Missing 'setup'");
    if (!Array.isArray(s.setup.factions) || s.setup.factions.length === 0) throw new Error("Missing or empty 'setup.factions'");
    if (!Array.isArray(s.setup.initialFleets)) throw new Error("Missing 'setup.initialFleets'");

    // 5. Rules & Objectives
    if (!s.rules || typeof s.rules !== 'object') throw new Error("Missing 'rules'");
    if (!s.objectives || !Array.isArray(s.objectives.win)) throw new Error("Missing 'objectives.win'");

    // 5b. Optional View (presentation defaults)
    if (s.view !== undefined && s.view !== null) {
      if (typeof s.view !== 'object') throw new Error("Invalid 'view' (expected an object)");
      const view = s.view as any;

      if (view.focus !== undefined && view.focus !== null) {
        if (typeof view.focus !== 'object') throw new Error("Invalid 'view.focus' (expected an object)");
        const focus = view.focus as any;
        if (focus.mode !== undefined && focus.mode !== null) {
          const allowedModes = new Set(['player_homeworld', 'system_id', 'first_system']);
          if (typeof focus.mode !== 'string' || !allowedModes.has(focus.mode)) {
            throw new Error("Invalid 'view.focus.mode' (expected player_homeworld | system_id | first_system)");
          }
        }
        if (focus.systemId !== undefined && focus.systemId !== null && typeof focus.systemId !== 'string') {
          throw new Error("Invalid 'view.focus.systemId' (expected string)");
        }
        if (focus.planetId !== undefined && focus.planetId !== null && typeof focus.planetId !== 'string') {
          throw new Error("Invalid 'view.focus.planetId' (expected string)");
        }
        if (focus.mode === 'system_id' && (!focus.systemId || typeof focus.systemId !== 'string')) {
          throw new Error("Invalid 'view.focus.systemId' (required when mode=system_id)");
        }
      }

      if (view.camera !== undefined && view.camera !== null) {
        if (typeof view.camera !== 'object') throw new Error("Invalid 'view.camera' (expected an object)");
        const camera = view.camera as any;
        if (camera.startScale !== undefined && camera.startScale !== null) {
          const allowedScales = new Set(['galaxy', 'system', 'planet']);
          if (typeof camera.startScale !== 'string' || !allowedScales.has(camera.startScale)) {
            throw new Error("Invalid 'view.camera.startScale' (expected galaxy | system | planet)");
          }
        }
        if (camera.distanceMeters !== undefined && camera.distanceMeters !== null) {
          if (typeof camera.distanceMeters !== 'number' || !Number.isFinite(camera.distanceMeters)) {
            throw new Error("Invalid 'view.camera.distanceMeters' (expected finite number)");
          }
          if (camera.distanceMeters <= 0) {
            throw new Error("Invalid 'view.camera.distanceMeters' (must be > 0)");
          }
        }
        if (camera.yawRad !== undefined && camera.yawRad !== null) {
          if (typeof camera.yawRad !== 'number' || !Number.isFinite(camera.yawRad)) {
            throw new Error("Invalid 'view.camera.yawRad' (expected finite number)");
          }
        }
        if (camera.pitchRad !== undefined && camera.pitchRad !== null) {
          if (typeof camera.pitchRad !== 'number' || !Number.isFinite(camera.pitchRad)) {
            throw new Error("Invalid 'view.camera.pitchRad' (expected finite number)");
          }
        }
      }
    }

    // 6. Referential Integrity (Faction IDs)
    const factionIds = new Set<string>();
    for (const f of s.setup.factions) {
      if (typeof f.id !== 'string') throw new Error('Invalid faction ID');
      factionIds.add(f.id);
    }

    // 6b. Optional Territory Allocation Validation
    if (s.setup.territoryAllocation !== undefined && s.setup.territoryAllocation !== null) {
      const ta = s.setup.territoryAllocation as any;
      if (ta.type !== 'percentages') throw new Error('Unsupported setup.territoryAllocation.type');
      if (!ta.byFactionId || typeof ta.byFactionId !== 'object') throw new Error('Missing setup.territoryAllocation.byFactionId');

      let sum = 0;
      for (const [fid, share] of Object.entries(ta.byFactionId)) {
        if (!factionIds.has(fid)) throw new Error(`territoryAllocation references unknown factionId: '${fid}'`);
        if (typeof share !== 'number' || !isFinite(share) || share < 0 || share > 1) {
          throw new Error(`Invalid territoryAllocation share for '${fid}'`);
        }
        sum += share;
      }

      if (ta.neutralShare !== undefined && ta.neutralShare !== null) {
        if (typeof ta.neutralShare !== 'number' || !isFinite(ta.neutralShare) || ta.neutralShare < 0 || ta.neutralShare > 1) {
          throw new Error('Invalid territoryAllocation.neutralShare');
        }
        sum += ta.neutralShare;
      }

      // Allow small floating errors
      if (sum > 1.00001) throw new Error(`territoryAllocation shares sum to > 1.0 (${sum})`);
    }

    const knownShipTypes = new Set<string>(Object.values(ShipType));
    for (const fleet of s.setup.initialFleets) {
      if (!factionIds.has(fleet.ownerFactionId)) {
        throw new Error(`Fleet definition references unknown faction ID: '${fleet.ownerFactionId}'`);
      }
      if (!Array.isArray(fleet.ships) || fleet.ships.length === 0) {
        throw new Error(`Fleet definition for '${fleet.ownerFactionId}' has no ships`);
      }
      if (fleet.ships.some((t: any) => typeof t !== 'string' || t.trim() === '')) {
        throw new Error('Fleet definition contains invalid ship type strings');
      }

      fleet.ships.forEach((t: string) => {
        if (!knownShipTypes.has(t)) {
          devWarn(
            `[ScenarioRegistry] Fleet '${fleet.ownerFactionId}' declares unknown ship type '${t}'. ` +
              'It will be replaced with a fallback during world generation.'
          );
        }
      });
    }

    return s as ScenarioTemplate;
  } catch (e) {
    devWarn(`[ScenarioRegistry] Failed to load scenario '${fileName}': ${(e as Error).message}`);
    return null;
  }
}

const loadedScenarios: ScenarioTemplate[] = [];
let failedCount = 0;

for (const { data, name } of templatesToLoad) {
  const validated = validateScenarioV1(data, name);
  if (validated) {
    loadedScenarios.push(validated);
  } else {
    failedCount++;
  }
}

if (failedCount > 0) {
  devError(`[ScenarioRegistry] ${failedCount} scenario(s) failed to load. Check warnings above for details.`);
}

const SCENARIO_REGISTRY = sorted(loadedScenarios, (a, b) => {
  const diff = (a.meta.difficulty || 0) - (b.meta.difficulty || 0);
  if (diff !== 0) return diff;
  return a.meta.title.localeCompare(b.meta.title);
});

export interface ScenarioBuildOptions {
  rules?: Partial<ScenarioTemplate['rules']>;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = SCENARIO_REGISTRY;

export const buildScenario = (templateId: string, seed: number, options?: ScenarioBuildOptions): GameScenario => {
  const template = SCENARIO_TEMPLATES.find(t => t.id === templateId) || SCENARIO_TEMPLATES[0];

  if (!template) {
    throw new Error('No scenarios available in registry.');
  }

  const finalSeed =
    template.generation.fixedSeed !== undefined && template.generation.fixedSeed !== null ? template.generation.fixedSeed : seed;

  return {
    ...template,
    rules: {
      ...template.rules,
      ...(options?.rules ?? {})
    },
    seed: finalSeed
  };
};
