import assert from 'node:assert';
import { getFleetEligibility, isFleetEligibleForMode } from './FleetPicker';
import { CAPTURE_RANGE_SQ } from '../../../content/data/static';
import { Fleet, FleetState, ShipType, StarSystem } from '../../../shared/types';

const buildFleet = (overrides: Partial<Fleet>): Fleet => ({
  id: overrides.id ?? 'f-1',
  factionId: 'blue',
  ships: overrides.ships ?? [],
  position: overrides.position ?? { x: 0, y: 0, z: 0 },
  state: overrides.state ?? FleetState.ORBIT,
  stateStartTurn: 0,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  invasionTargetSystemId: null,
  loadTargetSystemId: null,
  unloadTargetSystemId: null,
  retreating: false,
});

const targetSystem: StarSystem = {
  id: 'target',
  name: 'Target',
  position: { x: 50, y: 0, z: 0 },
  color: '#fff',
  size: 1,
  ownerFactionId: null,
  resourceType: 'none',
  isHomeworld: false,
  planets: []
};
const systems: StarSystem[] = [
  targetSystem,
  {
    ...targetSystem,
    id: 'source',
    name: 'Source',
    position: { x: 0, y: 0, z: 0 }
  }
];

{
  const inRangeFleet = buildFleet({
    id: 'f-near',
    position: { x: targetSystem.position.x - (Math.sqrt(CAPTURE_RANGE_SQ) - 0.1), y: 0, z: 0 }
  });
  assert.strictEqual(
    getFleetEligibility(inRangeFleet, 'MOVE', targetSystem, systems).reason,
    'captureRange',
    'Fleets already within capture range should be flagged for captureRange'
  );
}

{
  const farFleet = buildFleet({
    id: 'f-far',
    position: systems[1].position
  });
  assert.strictEqual(
    isFleetEligibleForMode(farFleet, 'ATTACK', targetSystem, systems),
    true,
    'Fleets outside capture range should be selectable for ATTACK'
  );
}

{
  const transportFleet = buildFleet({
    id: 'f-transport',
    position: { x: targetSystem.position.x - 5, y: 0, z: 0 },
    ships: [{ id: 's1', type: ShipType.TRANSPORTER, hp: 1, maxHp: 1, fuel: 100, carriedArmyId: 'army-1' }],
  });
  assert.strictEqual(
    getFleetEligibility(transportFleet, 'UNLOAD', targetSystem, systems).eligible,
    true,
    'Fleets with transports should be allowed for UNLOAD when in range'
  );
}

{
  const noTransportFleet = buildFleet({
    id: 'f-no-transport',
    ships: [{ id: 's1', type: ShipType.FRIGATE, hp: 1, maxHp: 1, fuel: 50, carriedArmyId: null }],
  });
  assert.strictEqual(
    getFleetEligibility(noTransportFleet, 'LOAD', targetSystem, systems).reason,
    'missingTransport',
    'Fleets without transports should be rejected for LOAD'
  );
}

{
  const lowFuelFleet = buildFleet({
    id: 'f-low-fuel',
    position: { x: 0, y: 0, z: 0 },
    ships: [{ id: 's1', type: ShipType.FRIGATE, hp: 1, maxHp: 1, fuel: 0.05, carriedArmyId: null }],
  });
  assert.strictEqual(
    getFleetEligibility(lowFuelFleet, 'MOVE', targetSystem, systems).reason,
    'insufficientFuel',
    'Fleets without enough fuel should show an insufficientFuel restriction'
  );
}

{
  const distantFleet = buildFleet({
    id: 'f-out-of-range',
    position: { x: targetSystem.position.x + 500, y: 0, z: 0 },
    ships: [{ id: 's1', type: ShipType.TRANSPORTER, hp: 1, maxHp: 1, fuel: 999, carriedArmyId: 'army-1' }],
  });
  assert.strictEqual(
    getFleetEligibility(distantFleet, 'UNLOAD', targetSystem, systems).reason,
    'outOfRange',
    'Fleets beyond jump range should be flagged as outOfRange'
  );
}

console.log('FleetPicker eligibility tests passed');
