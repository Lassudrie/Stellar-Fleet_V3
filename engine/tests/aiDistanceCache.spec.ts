import assert from 'node:assert';
import { createDistanceCache } from '../ai';
import { Fleet, FleetState, StarSystem } from '../../types';
import { COLORS } from '../../data/static';

const createFleet = (id: string, position: { x: number; y: number; z: number }): Fleet => ({
  id,
  factionId: 'blue',
  ships: [],
  position,
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

const createSystem = (id: string, position: { x: number; y: number; z: number }): StarSystem => ({
  id,
  name: id,
  position,
  color: COLORS.blue,
  size: 1,
  ownerFactionId: 'blue',
  resourceType: 'none',
  isHomeworld: false,
  planets: [],
});

const run = () => {
  const fleets = [
    createFleet('fleet-1', { x: 0, y: 0, z: 0 }),
    createFleet('fleet-2', { x: 10, y: 0, z: 0 }),
  ];

  const systems = [
    createSystem('sys-a', { x: 0, y: 0, z: 0 }),
    createSystem('sys-b', { x: 5, y: 0, z: 0 }),
  ];

  const cache = createDistanceCache(fleets, systems);

  const firstLookup = cache.getFleetSystemDistanceSq('fleet-1', 'sys-b');
  const statsAfterFirst = cache.getStats();

  assert.strictEqual(firstLookup, 25);
  assert.strictEqual(statsAfterFirst.fleetSystemComputations, 1);

  const secondLookup = cache.getFleetSystemDistanceSq('fleet-1', 'sys-b');
  const statsAfterSecond = cache.getStats();

  assert.strictEqual(secondLookup, 25);
  assert.strictEqual(statsAfterSecond.fleetSystemComputations, 1);

  const systemDistance = cache.getSystemSystemDistanceSq('sys-a', 'sys-b');
  const systemStats = cache.getStats();

  assert.strictEqual(systemDistance, 25);
  assert.strictEqual(systemStats.systemSystemComputations, 1);
};

run();
