import assert from 'node:assert';
import { resolveSurfaceContext } from './surfaceNavigation';
import { StarSystem } from '../../shared/types';

const makeSystem = (id: string, planets: Array<Partial<StarSystem['planets'][number]>>): StarSystem => ({
  id,
  name: id.toUpperCase(),
  position: { x: 0, y: 0, z: 0 },
  color: '#fff',
  size: 1,
  ownerFactionId: null,
  resourceType: 'none',
  isHomeworld: false,
  planets: planets.map((planet, index) => ({
    id: planet.id ?? `${id}-planet-${index + 1}`,
    systemId: id,
    name: planet.name ?? `${id} Planet ${index + 1}`,
    bodyType: planet.bodyType ?? 'planet',
    class: planet.class ?? 'solid',
    ownerFactionId: planet.ownerFactionId ?? null,
    size: planet.size ?? 1,
    isSolid: planet.isSolid ?? true
  })),
});

const systems: StarSystem[] = [
  makeSystem('alpha', [
    { id: 'alpha-gas', class: 'gas_giant', isSolid: false }
  ]),
  makeSystem('beta', [
    { id: 'beta-one', class: 'solid', isSolid: true }
  ]),
  makeSystem('gamma', [
    { id: 'gamma-a', class: 'solid', isSolid: true }
  ])
];

{
  const context = resolveSurfaceContext({ systems, bodyId: 'beta-one' });
  assert.ok(context, 'Context should be resolved for explicit solid planet');
  assert.strictEqual(context?.body.id, 'beta-one');
  assert.strictEqual(context?.system.id, 'beta');
}

{
  const context = resolveSurfaceContext({ systems, bodyId: 'alpha-gas', preferredSystemId: 'gamma' });
  assert.ok(context, 'Preferred system should be used when body is invalid');
  assert.strictEqual(context?.system.id, 'gamma');
  assert.strictEqual(context?.body.isSolid, true);
}

{
  const barrenSystems: StarSystem[] = [
    makeSystem('void', [
      { id: 'void-1', class: 'gas_giant', isSolid: false }
    ])
  ];
  const context = resolveSurfaceContext({ systems: barrenSystems, bodyId: 'void-1' });
  assert.strictEqual(context, null, 'No surface context when no solid planets exist');
}

console.log('surfaceNavigation navigation tests passed');
