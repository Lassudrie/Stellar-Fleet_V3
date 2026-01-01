import assert from 'node:assert';
import { Fleet, FleetState, StarSystem } from '../../../shared/types';
import { vec3 } from '../../../engine/math/vec3';
import { getSystemFleets, hashStringToAngle, layoutTacticalRing } from './systemViewLayout';

const createSystem = (): StarSystem => ({
  id: 'sys-1',
  name: 'Test',
  position: vec3(0, 0, 0),
  color: '#ffffff',
  size: 1,
  ownerFactionId: null,
  resourceType: 'none',
  isHomeworld: false,
  planets: []
});

const createFleet = (id: string, x: number, z: number): Fleet => ({
  id,
  factionId: 'blue',
  ships: [],
  position: vec3(x, 0, z),
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

{
  const angleA = hashStringToAngle('fleet-alpha');
  const angleB = hashStringToAngle('fleet-alpha');
  const angleC = hashStringToAngle('fleet-beta');
  assert.strictEqual(angleA, angleB, 'hashStringToAngle should be deterministic');
  assert.notStrictEqual(angleA, angleC, 'hashStringToAngle should vary across ids');
}

{
  const system = createSystem();
  const fleetNear = createFleet('fleet-near', 0, 0);
  const fleetFar = createFleet('fleet-far', 100, 0);
  const fleets = getSystemFleets(system, [fleetFar, fleetNear]);
  assert.deepStrictEqual(
    fleets.map((fleet) => fleet.id),
    ['fleet-near'],
    'getSystemFleets should filter by orbit proximity'
  );
}

{
  const fleetA = createFleet('a-fleet', 0, 0);
  const fleetB = createFleet('b-fleet', 0, 0);
  const layout = layoutTacticalRing([fleetB, fleetA], {
    baseRadius: 5,
    ringSpacing: 2,
    maxPerRing: 1,
    yOffset: 0.1,
    rotationSpeed: 0
  });

  assert.strictEqual(layout[0].entity.id, 'a-fleet', 'layout should sort entities by id');
  assert.strictEqual(layout[0].ringIndex, 0, 'first entity should be in ring 0');
  assert.strictEqual(layout[1].ringIndex, 1, 'second entity should roll into ring 1');
  assert.strictEqual(layout[1].radius, 7, 'ring radius should include spacing offset');
}

console.log('system view layout tests passed');
