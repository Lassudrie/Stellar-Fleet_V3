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
import {
  ATMOSPHERE_PRESSURE_BAR,
  MOON_ATMOSPHERE_PRESSURE_BAR,
  canHoldAtmosphere,
  computeFluxEarth,
  computeGravityG,
  computeMoonClimate,
  computePlanetClimate,
  computeTeqK
} from '../src/engine/worldgen/stellarSystem.ts';
import { sorted } from '../src/shared/shared.ts';

const printHelp = () => {
  console.log('Usage: npm run worldgen:audit -- --scenario <id> --seed <seed> [--out <path>] [--mode <summary|climate|surface>]');
  console.log('Options:');
  console.log('  --scenario <id>   Scenario template id');
  console.log('  --seed <seed>     Seed integer (default: 1)');
  console.log('  --out <path>      Output JSON path (default: log/worldgen-audit.json)');
  console.log('  --mode <mode>     Audit mode: summary, climate, or surface (default: summary)');
  console.log('  --list            List available scenarios');
  console.log('  --help            Show this help');
};

const parseArgs = (argv) => {
  const options = {
    scenarioId: null,
    seed: 1,
    outPath: 'log/worldgen-audit.json',
    mode: 'summary',
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
    if (arg === '--mode') {
      const raw = argv[i + 1];
      if (!raw) throw new Error('Missing value for --mode');
      const mode = raw.toLowerCase();
      if (mode !== 'summary' && mode !== 'climate' && mode !== 'surface') {
        throw new Error(`Invalid mode '${raw}', expected summary, climate, or surface`);
      }
      options.mode = mode;
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

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const RIVER_FEATURE_BIT = 1 << 0;

const CLIMATE_TOLERANCES = {
  teqK: 0.5,
  greenhouseK: 0.5,
  climateK: 0.5,
  airMassIndex: 0.01,
  gravityG: 1e-3,
  temperatureK: 0.5
};

const MIN_LIQUID_WATER_PRESSURE_BAR = 0.08;
const FREEZE_POINT_BASE_K = 273.15;
const FREEZE_POINT_MIN_PRESSURE_K = 276;

const computeEffectiveFreezingPointK = (pressureBar) => {
  const normalized = Math.max(0, Math.min(1, (pressureBar - MIN_LIQUID_WATER_PRESSURE_BAR) / (1 - MIN_LIQUID_WATER_PRESSURE_BAR)));
  return FREEZE_POINT_MIN_PRESSURE_K + (FREEZE_POINT_BASE_K - FREEZE_POINT_MIN_PRESSURE_K) * normalized;
};

const resolveHydrologyMode = ({ atmosphere, pressureBar, climateK }) => {
  if (!atmosphere || atmosphere === 'None') return 'none';
  if (!isFiniteNumber(pressureBar) || pressureBar < MIN_LIQUID_WATER_PRESSURE_BAR) return 'none';
  if (!isFiniteNumber(climateK)) return 'none';
  const freezePointK = computeEffectiveFreezingPointK(pressureBar);
  return climateK < freezePointK ? 'frozen' : 'liquid';
};

const withPressurePadding = (range) => ({
  min: range[0] * 0.2,
  max: range[1] * 2.0
});

const buildPlanetClimateCheck = ({ system, planet, planetIndex }) => {
  const systemId = system.id;
  const systemName = system.name;
  const bodyId = `planet-${systemId}-${planetIndex + 1}`;
  const luminosity = system.astro?.derived?.luminosityTotalLSun;
  const fluxEarth = isFiniteNumber(luminosity) ? computeFluxEarth(luminosity, planet.semiMajorAxisAu) : null;
  const teqExpected = fluxEarth !== null ? computeTeqK(fluxEarth, planet.albedo) : null;
  const expectedClimate = computePlanetClimate({
    teqK: planet.teqK,
    atmosphere: planet.atmosphere,
    pressureBar: planet.pressureBar
  });
  const expectedGravity = computeGravityG(planet.massEarth, planet.radiusEarth);
  const pressureRange = withPressurePadding(ATMOSPHERE_PRESSURE_BAR[planet.atmosphere]);
  const hasPressure = isFiniteNumber(planet.pressureBar);

  const deltas = {
    teqK: teqExpected !== null ? planet.teqK - teqExpected : null,
    greenhouseK: planet.greenhouseK - expectedClimate.greenhouseK,
    climateK: planet.climateK - expectedClimate.climateK,
    airMassIndex: planet.airMassIndex - expectedClimate.airMassIndex,
    gravityG: planet.gravityG - expectedGravity,
    temperatureK: planet.temperatureK - planet.climateK
  };

  const isAirless = planet.atmosphere === 'None';
  const checks = {
    teqKMatchesFlux: teqExpected !== null ? Math.abs(deltas.teqK) <= CLIMATE_TOLERANCES.teqK : null,
    greenhouseMatches: Math.abs(deltas.greenhouseK) <= CLIMATE_TOLERANCES.greenhouseK,
    climateMatches: Math.abs(deltas.climateK) <= CLIMATE_TOLERANCES.climateK,
    airMassMatches: Math.abs(deltas.airMassIndex) <= CLIMATE_TOLERANCES.airMassIndex,
    gravityMatches: Math.abs(deltas.gravityG) <= CLIMATE_TOLERANCES.gravityG,
    temperatureMatches: Math.abs(deltas.temperatureK) <= CLIMATE_TOLERANCES.temperatureK,
    pressurePresent: isAirless ? !hasPressure : hasPressure,
    pressureRangeOk: isAirless
      ? !hasPressure
      : hasPressure
        ? planet.pressureBar >= pressureRange.min && planet.pressureBar <= pressureRange.max
        : false,
    canHoldAtmosphere: canHoldAtmosphere(planet.massEarth, planet.gravityG) || isAirless
  };

  const warnings = [];
  if (checks.teqKMatchesFlux === false) warnings.push('teqk_mismatch');
  if (!checks.greenhouseMatches) warnings.push('greenhouse_mismatch');
  if (!checks.climateMatches) warnings.push('climate_mismatch');
  if (!checks.airMassMatches) warnings.push('airmass_mismatch');
  if (!checks.gravityMatches) warnings.push('gravity_mismatch');
  if (!checks.temperatureMatches) warnings.push('temperature_mismatch');
  if (checks.pressurePresent === false) warnings.push('pressure_missing_or_unexpected');
  if (checks.pressureRangeOk === false) warnings.push('pressure_out_of_range');
  if (!checks.canHoldAtmosphere) warnings.push('atmosphere_unstable_for_mass');
  if (!isFiniteNumber(planet.albedo) || planet.albedo < 0 || planet.albedo > 1) warnings.push('albedo_out_of_range');

  return {
    input: {
      systemId,
      systemName,
      bodyId,
      bodyType: 'planet',
      planetIndex,
      planetType: planet.type,
      semiMajorAxisAu: planet.semiMajorAxisAu,
      eccentricity: planet.eccentricity,
      massEarth: planet.massEarth,
      radiusEarth: planet.radiusEarth,
      gravityG: planet.gravityG,
      albedo: planet.albedo,
      atmosphere: planet.atmosphere,
      pressureBar: planet.pressureBar,
      teqK: planet.teqK,
      greenhouseK: planet.greenhouseK,
      climateK: planet.climateK,
      airMassIndex: planet.airMassIndex,
      temperatureK: planet.temperatureK,
      climateTag: planet.climateTag ?? null,
      fluxEarth
    },
    expected: {
      teqKFromFlux: teqExpected,
      climateFromAtmosphere: expectedClimate,
      gravityFromMassRadius: expectedGravity,
      pressureRangeBar: pressureRange
    },
    deltas,
    checks,
    warnings
  };
};

const buildMoonClimateCheck = ({ system, planet, planetIndex, moon, moonIndex }) => {
  const systemId = system.id;
  const systemName = system.name;
  const bodyId = `moon-${systemId}-${planetIndex + 1}-${moonIndex + 1}`;
  const luminosity = system.astro?.derived?.luminosityTotalLSun;
  const fluxEarth = isFiniteNumber(luminosity) ? computeFluxEarth(luminosity, planet.semiMajorAxisAu) : null;
  const teqExpected = fluxEarth !== null ? computeTeqK(fluxEarth, moon.albedo) : null;
  const expectedClimate = computeMoonClimate({
    teqK: moon.teqK,
    atmosphere: moon.atmosphere,
    pressureBar: moon.pressureBar,
    tidalBonusK: moon.tidalBonusK
  });
  const expectedGravity = computeGravityG(moon.massEarth, moon.radiusEarth);
  const rawPressureRange = MOON_ATMOSPHERE_PRESSURE_BAR[moon.atmosphere];
  const pressureRange = rawPressureRange ? withPressurePadding(rawPressureRange) : null;
  const hasPressure = isFiniteNumber(moon.pressureBar);

  const deltas = {
    teqK: teqExpected !== null ? moon.teqK - teqExpected : null,
    greenhouseK: moon.greenhouseK - expectedClimate.greenhouseK,
    climateK: moon.climateK - expectedClimate.climateK,
    airMassIndex: moon.airMassIndex - expectedClimate.airMassIndex,
    gravityG: moon.gravityG - expectedGravity,
    temperatureK: moon.temperatureK - moon.climateK
  };

  const isAirless = moon.atmosphere === 'None';
  const checks = {
    teqKMatchesFlux: teqExpected !== null ? Math.abs(deltas.teqK) <= CLIMATE_TOLERANCES.teqK : null,
    greenhouseMatches: Math.abs(deltas.greenhouseK) <= CLIMATE_TOLERANCES.greenhouseK,
    climateMatches: Math.abs(deltas.climateK) <= CLIMATE_TOLERANCES.climateK,
    airMassMatches: Math.abs(deltas.airMassIndex) <= CLIMATE_TOLERANCES.airMassIndex,
    gravityMatches: Math.abs(deltas.gravityG) <= CLIMATE_TOLERANCES.gravityG,
    temperatureMatches: Math.abs(deltas.temperatureK) <= CLIMATE_TOLERANCES.temperatureK,
    pressurePresent: isAirless ? !hasPressure : hasPressure,
    pressureRangeOk: isAirless
      ? !hasPressure
      : hasPressure && pressureRange
        ? moon.pressureBar >= pressureRange.min && moon.pressureBar <= pressureRange.max
        : false
  };

  const warnings = [];
  if (checks.teqKMatchesFlux === false) warnings.push('teqk_mismatch');
  if (!checks.greenhouseMatches) warnings.push('greenhouse_mismatch');
  if (!checks.climateMatches) warnings.push('climate_mismatch');
  if (!checks.airMassMatches) warnings.push('airmass_mismatch');
  if (!checks.gravityMatches) warnings.push('gravity_mismatch');
  if (!checks.temperatureMatches) warnings.push('temperature_mismatch');
  if (checks.pressurePresent === false) warnings.push('pressure_missing_or_unexpected');
  if (checks.pressureRangeOk === false) warnings.push('pressure_out_of_range');
  if (moon.atmosphere === 'H2He') warnings.push('moon_h2he_atmosphere_invalid');
  if (!isFiniteNumber(moon.albedo) || moon.albedo < 0 || moon.albedo > 1) warnings.push('albedo_out_of_range');

  return {
    input: {
      systemId,
      systemName,
      bodyId,
      bodyType: 'moon',
      planetIndex,
      moonIndex,
      planetType: planet.type,
      hostSemiMajorAxisAu: planet.semiMajorAxisAu,
      orbitDistanceRp: moon.orbitDistanceRp,
      massEarth: moon.massEarth,
      radiusEarth: moon.radiusEarth,
      gravityG: moon.gravityG,
      albedo: moon.albedo,
      atmosphere: moon.atmosphere,
      pressureBar: moon.pressureBar,
      teqK: moon.teqK,
      tidalBonusK: moon.tidalBonusK,
      greenhouseK: moon.greenhouseK,
      climateK: moon.climateK,
      airMassIndex: moon.airMassIndex,
      temperatureK: moon.temperatureK,
      fluxEarth
    },
    expected: {
      teqKFromFlux: teqExpected,
      climateFromAtmosphere: expectedClimate,
      gravityFromMassRadius: expectedGravity,
      pressureRangeBar: pressureRange
    },
    deltas,
    checks,
    warnings
  };
};

const buildSurfaceCoherence = ({ descriptor, env, summary, map, bodySummary }) => {
  const tileCount = summary.tileCount;
  const expectedTileCount = descriptor.config.w * descriptor.config.h;
  const avgTempC = summary.tileStats.tempC2.avg / 2;
  const avgTempK = avgTempC + 273.15;
  const maxTempC = summary.tileStats.tempC2.max / 2;
  const climateK = isFiniteNumber(bodySummary?.climateK)
    ? bodySummary.climateK
    : isFiniteNumber(bodySummary?.temperatureK)
    ? bodySummary.temperatureK
    : null;
  const hydrologyMode = resolveHydrologyMode({
    atmosphere: bodySummary?.atmosphere,
    pressureBar: bodySummary?.pressureBar,
    climateK
  });
  const expectedWaterFraction =
    hydrologyMode === 'none'
      ? 0
      : isFiniteNumber(env?.waterFraction)
      ? env.waterFraction
      : null;
  const waterTiles = hydrologyMode === 'none'
    ? 0
    : map.tiles.reduce((count, tile) => count + (tile.elev <= map.seaLevelElev ? 1 : 0), 0);
  const waterFraction = tileCount > 0 ? waterTiles / tileCount : 0;
  const waterDelta = expectedWaterFraction !== null ? waterFraction - expectedWaterFraction : null;
  const tempDelta = climateK !== null ? avgTempK - climateK : null;
  const landFraction = Math.max(0, 1 - waterFraction);
  const riverTiles = map.tiles.reduce(
    (count, tile) => count + ((tile.featureBits & RIVER_FEATURE_BIT) !== 0 ? 1 : 0),
    0
  );
  const riverRatio = tileCount > 0 ? riverTiles / tileCount : 0;
  const riverExpectation = env
    ? hydrologyMode === 'liquid' && env.riversEnabled && landFraction > 0.15 && maxTempC > 0
    : null;

  const checks = {
    tileCountMatches: tileCount === expectedTileCount,
    waterFractionClose:
      expectedWaterFraction !== null
        ? expectedWaterFraction === 0
          ? waterFraction === 0
          : Math.abs(waterDelta) <= 0.08
        : null,
    avgTempCloseToClimate: climateK !== null ? Math.abs(tempDelta) <= 60 : null,
    riversMatchExpectation: riverExpectation !== null ? (riverExpectation ? riverTiles > 0 : riverTiles === 0) : null
  };

  const warnings = [];
  if (!checks.tileCountMatches) warnings.push('tile_count_mismatch');
  if (checks.waterFractionClose === false) warnings.push('water_fraction_mismatch');
  if (checks.avgTempCloseToClimate === false) warnings.push('avg_temp_far_from_climate');
  if (env?.surfaceClass === 'airless' && waterFraction > 0.08) warnings.push('airless_has_water');
  if (env?.surfaceClass === 'icy' && avgTempK > 270) warnings.push('icy_too_warm');
  if (env?.surfaceClass === 'hot' && avgTempK < 295) warnings.push('hot_too_cold');
  if (riverExpectation && riverTiles === 0) warnings.push('rivers_expected_missing');
  if (riverExpectation === false && riverTiles > 0) warnings.push('rivers_unexpected');

  return {
    observed: {
      tileCount,
      expectedTileCount,
      waterTiles,
      waterFraction,
      avgTempC,
      avgTempK,
      riverTiles,
      riverRatio,
      tempStats: summary.tileStats.tempC2
    },
    expected: {
      surfaceClass: env?.surfaceClass ?? null,
      surfaceClassReason: env?.surfaceClassReason ?? null,
      waterFraction: expectedWaterFraction,
      riversEnabled: env?.riversEnabled ?? null,
      climateK,
      hydrologyMode,
      freezePointK: isFiniteNumber(bodySummary?.pressureBar)
        ? computeEffectiveFreezingPointK(bodySummary.pressureBar)
        : null
    },
    deltas: {
      waterFraction: waterDelta,
      avgTempK: tempDelta,
      tileCount: tileCount - expectedTileCount
    },
    checks,
    warnings
  };
};

const summarizeMoonClimate = (moon) => ({
  type: moon.type,
  orbitDistanceRp: moon.orbitDistanceRp,
  atmosphere: moon.atmosphere,
  pressureBar: moon.pressureBar,
  teqK: moon.teqK,
  tidalBonusK: moon.tidalBonusK,
  greenhouseK: moon.greenhouseK,
  climateK: moon.climateK,
  airMassIndex: moon.airMassIndex,
  temperatureK: moon.temperatureK
});

const summarizePlanetClimate = (planet) => ({
  type: planet.type,
  semiMajorAxisAu: planet.semiMajorAxisAu,
  atmosphere: planet.atmosphere,
  pressureBar: planet.pressureBar,
  teqK: planet.teqK,
  greenhouseK: planet.greenhouseK,
  climateK: planet.climateK,
  airMassIndex: planet.airMassIndex,
  temperatureK: planet.temperatureK,
  climateTag: planet.climateTag ?? null,
  moons: planet.moons?.map(summarizeMoonClimate) ?? []
});

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
  const audit = createWorldgenAuditCollector(scenario, options.mode);
  const { state } = generateWorld(scenario, { audit });
  const orderedSystems = sorted(state.systems, (a, b) => a.id.localeCompare(b.id));
  const systemById = new Map(orderedSystems.map(system => [system.id, system]));

  const includeClimateChecks = options.mode === 'climate';
  const includeSurfaceChecks = options.mode === 'surface';
  const includeSurfaceMaps = options.mode === 'summary' || options.mode === 'surface';
  const includeClimateDetail = options.mode === 'climate' || options.mode === 'surface';

  const bodyRefs = [];
  if (includeSurfaceMaps) {
    orderedSystems.forEach(system => {
      system.planets.forEach(body => {
        if (!body.isSolid) return;
        bodyRefs.push({ systemId: system.id, bodyId: body.id });
      });
    });
  }

  const orderedBodies = includeSurfaceMaps ? sorted(bodyRefs, (a, b) => a.bodyId.localeCompare(b.bodyId)) : [];
  const surfaceClassOrder = ['airless', 'icy', 'temperate', 'hot', 'dense', 'unknown'];
  const settlementTypeOrder = ['outpost', 'colony', 'frontierTown', 'city', 'metropolis', 'megalopolis'];
  const surfaceSummary = includeSurfaceMaps
    ? {
        total: 0,
        bySurfaceClass: createCountRecord(surfaceClassOrder),
        settlementTotals: {
          total: 0,
          byType: createCountRecord(settlementTypeOrder),
          byStatus: { active: 0, ruins: 0 }
        }
      }
    : null;

  if (includeClimateChecks) {
    orderedSystems.forEach(system => {
      if (!system.astro) return;
      audit.emit({
        step: 'astro',
        kind: 'astro_climate_snapshot',
        entityId: system.id,
        outputs: {
          primarySpectralType: system.astro.primarySpectralType,
          starCount: system.astro.starCount,
          planetCount: system.astro.planets.length,
          planets: system.astro.planets.map(summarizePlanetClimate)
        }
      });
      system.astro.planets.forEach((planet, planetIndex) => {
        const planetCheck = buildPlanetClimateCheck({ system, planet, planetIndex });
        audit.emit({
          step: 'astro',
          kind: 'climate_coherence_check',
          entityId: planetCheck.input.bodyId,
          inputs: planetCheck.input,
          outputs: {
            expected: planetCheck.expected,
            deltas: planetCheck.deltas,
            checks: planetCheck.checks,
            warnings: planetCheck.warnings
          }
        });
        planet.moons?.forEach((moon, moonIndex) => {
          const moonCheck = buildMoonClimateCheck({ system, planet, planetIndex, moon, moonIndex });
          audit.emit({
            step: 'astro',
            kind: 'climate_coherence_check',
            entityId: moonCheck.input.bodyId,
            inputs: moonCheck.input,
            outputs: {
              expected: moonCheck.expected,
              deltas: moonCheck.deltas,
              checks: moonCheck.checks,
              warnings: moonCheck.warnings
            }
          });
        });
      });
    });
  }

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
    const isMoon = descriptor.astroRef.moonIndex !== undefined;
    const env = isMoon
      ? astro?.moonData
        ? deriveSurfaceParamsFromMoon(astro.moonData)
        : null
      : astro?.planetData
      ? deriveSurfaceParamsFromPlanet(astro.planetData)
      : astro?.moonData
      ? deriveSurfaceParamsFromMoon(astro.moonData)
      : null;
    const bodySummary = (() => {
      if (isMoon) {
        if (!astro?.moonData) return null;
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
          greenhouseK: includeClimateDetail ? moon.greenhouseK : undefined,
          climateK: includeClimateDetail ? moon.climateK : undefined,
          airMassIndex: includeClimateDetail ? moon.airMassIndex : undefined,
          temperatureK: moon.temperatureK,
          massEarth: moon.massEarth,
          radiusEarth: moon.radiusEarth,
          gravityG: moon.gravityG,
          albedo: moon.albedo,
          atmosphere: moon.atmosphere,
          pressureBar: moon.pressureBar
        };
      }
      if (astro?.planetData) {
        const planet = astro.planetData;
        const flux = Number.isFinite(luminosity) ? computeFluxEarth(luminosity, planet.semiMajorAxisAu) : undefined;
        return {
          bodyType: 'planet',
          planetType: planet.type,
          semiMajorAxisAu: planet.semiMajorAxisAu,
          flux,
          teqK: planet.teqK,
          greenhouseK: includeClimateDetail ? planet.greenhouseK : undefined,
          climateK: includeClimateDetail ? planet.climateK : undefined,
          airMassIndex: includeClimateDetail ? planet.airMassIndex : undefined,
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
          greenhouseK: includeClimateDetail ? moon.greenhouseK : undefined,
          climateK: includeClimateDetail ? moon.climateK : undefined,
          airMassIndex: includeClimateDetail ? moon.airMassIndex : undefined,
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
    const coherence = includeSurfaceChecks
      ? buildSurfaceCoherence({
          descriptor,
          env,
          summary,
          map,
          bodySummary
        })
      : null;
    const outputs = includeSurfaceChecks ? { summary, coherence } : summary;
    audit.emit({
      step: 'surface',
      kind: includeSurfaceChecks ? 'surface_coherence_check' : 'surface_map_summary',
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
      outputs
    });

    if (surfaceSummary) {
      surfaceSummary.total += 1;
      addCount(surfaceSummary.bySurfaceClass, env?.surfaceClass ?? 'unknown', 1);
      surfaceSummary.settlementTotals.total += summary.settlements.total;
      settlementTypeOrder.forEach(type => {
        addCount(surfaceSummary.settlementTotals.byType, type, summary.settlements.byType[type] ?? 0);
      });
      surfaceSummary.settlementTotals.byStatus.active += summary.settlements.byStatus?.active ?? 0;
      surfaceSummary.settlementTotals.byStatus.ruins += summary.settlements.byStatus?.ruins ?? 0;
    }
  });

  if (surfaceSummary) {
    audit.log.summaries.surfaces = surfaceSummary;
  }

  const outputPath = path.resolve(process.cwd(), options.outPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(audit.log, null, 2)}\n`, 'utf8');
  console.log(`Worldgen audit log written to ${outputPath}`);
};

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
