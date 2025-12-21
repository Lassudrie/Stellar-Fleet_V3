import assert from 'node:assert';
import { DistanceCache } from '../ai';
import { Fleet, FleetState, ShipType, StarSystem } from '../../types';

const systems: StarSystem[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    position: { x: 0, y: 0, z: 0 },
    color: '#fff',
    size: 1,
    ownerFactionId: 'blue',
    resourceType: 'none',
    isHomeworld: false,
    planets: []
  },
  {
    id: 'beta',
    name: 'Beta',
    position: { x: 10, y: 0, z: 0 },
    color: '#fff',
    size: 1,
    ownerFactionId: 'red',
    resourceType: 'none',
    isHomeworld: false,
    planets: []
  }
];

const fleets: Fleet[] = [
  {
    id: 'taskforce-1',
    factionId: 'blue',
    ships: [{ id: 's1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }],
    position: { x: 5, y: 0, z: 0 },
    state: FleetState.ORBIT,
    targetSystemId: null,
    targetPosition: null,
    radius: 1,
    stateStartTurn: 0
  }
];

const cache = new DistanceCache(systems, fleets);

const first = cache.getSystemToFleetDistanceSq('alpha', 'taskforce-1');
const second = cache.getSystemToFleetDistanceSq('alpha', 'taskforce-1');

assert.strictEqual(first, second, 'Repeated queries should return identical values');
assert.strictEqual(cache.getStats().computations, 1, 'Distance cache should avoid recomputation for identical pairs');

const reversed = cache.getSystemToSystemDistanceSq('beta', 'alpha');
const forward = cache.getSystemToSystemDistanceSq('alpha', 'beta');
assert.strictEqual(reversed, forward, 'System distance cache should be symmetric');

console.log('AI distance cache tests passed');
