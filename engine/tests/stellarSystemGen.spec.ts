import assert from 'node:assert';
import { generateStellarSystem } from '../../services/world/stellar';

interface TestCase {
  name: string;
  run: () => void;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

const tests: TestCase[] = [
  {
    name: 'Stellar system generation is deterministic for same inputs',
    run: () => {
      const a = generateStellarSystem({ worldSeed: 42, systemId: 'sys_test_1' });
      const b = generateStellarSystem({ worldSeed: 42, systemId: 'sys_test_1' });
      assert.deepStrictEqual(a, b);
    }
  },
  {
    name: 'Per-system astro generation is isolated from call order',
    run: () => {
      const a1 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_A' });
      const b1 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_B' });

      const b2 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_B' });
      const a2 = generateStellarSystem({ worldSeed: 123, systemId: 'sys_A' });

      assert.deepStrictEqual(a1, a2);
      assert.deepStrictEqual(b1, b2);
    }
  },
  {
    name: 'Generated astro payload respects basic numeric invariants',
    run: () => {
      for (let seed = 1; seed <= 50; seed++) {
        const sys = generateStellarSystem({ worldSeed: seed, systemId: `sys_${seed}` });

        assert.ok(isFiniteNumber(sys.seed));
        assert.ok(sys.starCount >= 1 && sys.starCount <= 3);
        assert.ok(Array.isArray(sys.stars) && sys.stars.length >= 1);
        assert.ok(Array.isArray(sys.planets));
        assert.ok(sys.planets.length <= 10);

        assert.ok(isFiniteNumber(sys.derived.luminosityTotalLSun) && sys.derived.luminosityTotalLSun > 0);
        assert.ok(isFiniteNumber(sys.derived.snowLineAu) && sys.derived.snowLineAu >= 0);
        assert.ok(isFiniteNumber(sys.derived.hzInnerAu) && sys.derived.hzInnerAu >= 0);
        assert.ok(isFiniteNumber(sys.derived.hzOuterAu) && sys.derived.hzOuterAu >= sys.derived.hzInnerAu);

        for (const star of sys.stars) {
          assert.ok(isFiniteNumber(star.massSun) && star.massSun > 0);
          assert.ok(isFiniteNumber(star.radiusSun) && star.radiusSun > 0);
          assert.ok(isFiniteNumber(star.luminositySun) && star.luminositySun > 0);
          assert.ok(isFiniteNumber(star.teffK) && star.teffK > 0);
        }

        let lastA = 0;
        for (const planet of sys.planets) {
          assert.ok(isFiniteNumber(planet.semiMajorAxisAu));
          assert.ok(planet.semiMajorAxisAu >= 0.03 && planet.semiMajorAxisAu <= 60);
          assert.ok(planet.semiMajorAxisAu >= lastA);
          lastA = planet.semiMajorAxisAu;

          assert.ok(isFiniteNumber(planet.massEarth) && planet.massEarth > 0);
          assert.ok(isFiniteNumber(planet.radiusEarth) && planet.radiusEarth > 0);
          assert.ok(isFiniteNumber(planet.gravityG) && planet.gravityG > 0);

          const expectedG = planet.massEarth / (planet.radiusEarth * planet.radiusEarth);
          assert.ok(Math.abs(planet.gravityG - expectedG) < 1e-9);

          assert.ok(isFiniteNumber(planet.temperatureK));
          assert.ok(planet.temperatureK >= 30 && planet.temperatureK <= 2000);

          for (const moon of planet.moons) {
            assert.ok(isFiniteNumber(moon.orbitDistanceRp));
            assert.ok(moon.orbitDistanceRp >= 6 && moon.orbitDistanceRp <= 400);
            assert.ok(isFiniteNumber(moon.massEarth) && moon.massEarth >= 0);
            assert.ok(isFiniteNumber(moon.radiusEarth) && moon.radiusEarth > 0);
            assert.ok(isFiniteNumber(moon.gravityG) && moon.gravityG >= 0);
            assert.ok(isFiniteNumber(moon.temperatureK));
            assert.ok(moon.temperatureK >= 30 && moon.temperatureK <= 2000);
          }
        }
      }
    }
  }
];

const results: { name: string; success: boolean; error?: Error }[] = [];

for (const test of tests) {
  try {
    test.run();
    results.push({ name: test.name, success: true });
  } catch (error) {
    results.push({ name: test.name, success: false, error: error as Error });
  }
}

const successes = results.filter(result => result.success).length;
const failures = results.length - successes;

results.forEach(result => {
  if (result.success) {
    console.log(`✅ ${result.name}`);
  } else {
    console.error(`❌ ${result.name}`);
    console.error(result.error);
  }
});

if (failures > 0) {
  console.error(`Tests failed: ${failures}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`All tests passed (${successes}/${results.length}).`);
}
