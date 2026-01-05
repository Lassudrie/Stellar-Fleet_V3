import fs from 'node:fs/promises';
import path from 'node:path';
import { buildScenario, SCENARIO_TEMPLATES } from '../src/content/scenarios/registry.ts';
import { createWorldgenAuditCollector, generateWorld } from '../src/engine/worldgen/worldGenerator.ts';
import {
  deriveSurfaceParamsFromMoon,
  deriveSurfaceParamsFromPlanet,
  generateSurfaceMapForState,
  getAstroForBody,
  getSurfaceDescriptor,
  summarizeSurfaceMap
} from '../src/engine/planetSurface.ts';
import { computeFluxEarth } from '../src/engine/worldgen/stellarSystem.ts';
import { sorted } from '../src/shared/shared.ts';

const printHelp = () => {
  console.log('Usage: npm run worldgen:audit -- --scenario <id> --seed <seed> [--out <path>]');
  console.log('Options:');
  console.log('  --scenario <id>   Scenario template id');
  console.log('  --seed <seed>     Seed integer (default: 1)');
  console.log('  --out <path>      Output JSON path (default: log/worldgen-audit.json)');
  console.log('  --list            List available scenarios');
  console.log('  --help            Show this help');
};

const parseArgs = (argv) => {
  const options = {
    scenarioId: null,
    seed: 1,
    outPath: 'log/worldgen-audit.json',
    list: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') {
      options.scenarioId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--seed') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error('Missing value for --seed');
      const value = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(value)) {
        throw new Error(`Invalid seed '${raw}', expected integer`);
      }
      options.seed = value;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      options.outPath = argv[i + 1] ?? options.outPath;
      i += 1;
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const listScenarios = () => {
  const ids = SCENARIO_TEMPLATES.map(template => template.id);
  console.log(ids.join('\n'));
};

const createCountRecord = (keys) => {
  const out = {};
  keys.forEach(key => {
    out[key] = 0;
  });
  return out;
};

const addCount = (record, key, value = 1) => {
  record[key] = (record[key] ?? 0) + value;
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.list) {
    listScenarios();
    return;
  }

  if (options.scenarioId) {
    const knownIds = new Set(SCENARIO_TEMPLATES.map(template => template.id));
    if (!knownIds.has(options.scenarioId)) {
      throw new Error(`Unknown scenario id: ${options.scenarioId}`);
    }
  }

  const scenarioId = options.scenarioId ?? SCENARIO_TEMPLATES[0]?.id ?? 'conquest_sandbox';
  const scenario = buildScenario(scenarioId, options.seed);
  const audit = createWorldgenAuditCollector(scenario, 'summary');
  const { state } = generateWorld(scenario, { audit });
  const systemById = new Map(state.systems.map(system => [system.id, system]));

  const bodyRefs = [];
  state.systems.forEach(system => {
    system.planets.forEach(body => {
      if (!body.isSolid) return;
      bodyRefs.push({ systemId: system.id, bodyId: body.id });
    });
  });

  const orderedBodies = sorted(bodyRefs, (a, b) => a.bodyId.localeCompare(b.bodyId));
  const surfaceClassOrder = ['airless', 'icy', 'temperate', 'hot', 'dense', 'unknown'];
  const settlementTypeOrder = ['outpost', 'colony', 'frontierTown', 'city', 'metropolis', 'megalopolis'];
  const surfaceSummary = {
    total: 0,
    bySurfaceClass: createCountRecord(surfaceClassOrder),
    settlementTotals: {
      total: 0,
      byType: createCountRecord(settlementTypeOrder),
      byStatus: { active: 0, ruins: 0 }
    }
  };

  orderedBodies.forEach(({ systemId, bodyId }) => {
    const descriptor = getSurfaceDescriptor(state, bodyId);
    if (!descriptor) {
      audit.emit({
        step: 'surface',
        kind: 'surface_descriptor_missing',
        entityId: bodyId,
        warning: 'missing_descriptor'
      });
      return;
    }

    const astro = getAstroForBody(state, bodyId, descriptor);
    const system = systemById.get(systemId);
    const luminosity = system?.astro?.derived?.luminosityTotalLSun;
    const env = astro?.planetData
      ? deriveSurfaceParamsFromPlanet(astro.planetData)
      : astro?.moonData
      ? deriveSurfaceParamsFromMoon(astro.moonData)
      : null;
    const bodySummary = (() => {
      if (astro?.planetData) {
        const planet = astro.planetData;
        const flux = Number.isFinite(luminosity) ? computeFluxEarth(luminosity, planet.semiMajorAxisAu) : undefined;
        return {
          bodyType: 'planet',
          planetType: planet.type,
          semiMajorAxisAu: planet.semiMajorAxisAu,
          flux,
          teqK: planet.teqK,
          temperatureK: planet.temperatureK,
          massEarth: planet.massEarth,
          radiusEarth: planet.radiusEarth,
          gravityG: planet.gravityG,
          albedo: planet.albedo,
          atmosphere: planet.atmosphere,
          pressureBar: planet.pressureBar,
          climateTag: planet.climateTag
        };
      }
      if (astro?.moonData) {
        const moon = astro.moonData;
        const flux = Number.isFinite(luminosity) && astro?.planetData
          ? computeFluxEarth(luminosity, astro.planetData.semiMajorAxisAu)
          : undefined;
        return {
          bodyType: 'moon',
          moonType: moon.type,
          orbitDistanceRp: moon.orbitDistanceRp,
          flux,
          teqK: moon.teqK,
          temperatureK: moon.temperatureK,
          massEarth: moon.massEarth,
          radiusEarth: moon.radiusEarth,
          gravityG: moon.gravityG,
          albedo: moon.albedo,
          atmosphere: moon.atmosphere,
          pressureBar: moon.pressureBar
        };
      }
      return null;
    })();

    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) {
      audit.emit({
        step: 'surface',
        kind: 'surface_map_missing',
        entityId: bodyId,
        warning: 'missing_surface_map'
      });
      return;
    }

    const summary = summarizeSurfaceMap(map);
    audit.emit({
      step: 'surface',
      kind: 'surface_map_summary',
      entityId: bodyId,
      inputs: {
        systemId: astro?.systemId ?? systemId,
        bodyId,
        ownerFactionId: astro?.ownerFactionId ?? null,
        surfaceClassReason: env?.surfaceClassReason ?? null,
        descriptor: {
          seed: descriptor.seed,
          config: descriptor.config,
          astroRef: descriptor.astroRef,
          settlementConfig: descriptor.settlementConfig
        },
        env,
        bodySummary
      },
      outputs: summary
    });

    surfaceSummary.total += 1;
    addCount(surfaceSummary.bySurfaceClass, env?.surfaceClass ?? 'unknown', 1);
    surfaceSummary.settlementTotals.total += summary.settlements.total;
    settlementTypeOrder.forEach(type => {
      addCount(surfaceSummary.settlementTotals.byType, type, summary.settlements.byType[type] ?? 0);
    });
    surfaceSummary.settlementTotals.byStatus.active += summary.settlements.byStatus?.active ?? 0;
    surfaceSummary.settlementTotals.byStatus.ruins += summary.settlements.byStatus?.ruins ?? 0;
  });

  audit.log.summaries.surfaces = surfaceSummary;

  const outputPath = path.resolve(process.cwd(), options.outPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(audit.log, null, 2)}\n`, 'utf8');
  console.log(`Worldgen audit log written to ${outputPath}`);
};

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
