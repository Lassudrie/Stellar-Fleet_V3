import assert from 'node:assert';
import { isFleetEligibleForMode } from './FleetPicker';
import { CAPTURE_RANGE_SQ } from '../../../content/data/static';
import { Fleet, FleetState, ShipType } from '../../../shared/types';

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

const targetPosition = { x: 0, y: 0, z: 0 };

{
  const inRangeFleet = buildFleet({
    id: 'f-near',
    position: { x: Math.sqrt(CAPTURE_RANGE_SQ) - 0.1, y: 0, z: 0 }
  });
  assert.strictEqual(
    isFleetEligibleForMode(inRangeFleet, 'MOVE', targetPosition),
    false,
    'Fleets already within capture range should not be selectable for MOVE'
  );
}

{
  const farFleet = buildFleet({
    id: 'f-far',
    position: { x: Math.sqrt(CAPTURE_RANGE_SQ) + 1, y: 0, z: 0 }
  });
  assert.strictEqual(
    isFleetEligibleForMode(farFleet, 'ATTACK', targetPosition),
    true,
    'Fleets outside capture range should be selectable for ATTACK'
  );
}

{
  const transportFleet = buildFleet({
    id: 'f-transport',
    ships: [{ id: 's1', type: ShipType.TROOP_TRANSPORT, hp: 1, maxHp: 1, fuel: 100, carriedArmyId: 'army-1' }],
  });
  assert.strictEqual(
    isFleetEligibleForMode(transportFleet, 'UNLOAD', targetPosition),
    true,
    'Fleets with transports should be allowed for UNLOAD'
  );
}

{
  const noTransportFleet = buildFleet({
    id: 'f-no-transport',
    ships: [{ id: 's1', type: ShipType.FRIGATE, hp: 1, maxHp: 1, fuel: 50, carriedArmyId: null }],
  });
  assert.strictEqual(
    isFleetEligibleForMode(noTransportFleet, 'LOAD', targetPosition),
    false,
    'Fleets without transports should not be selectable for LOAD'
  );
}

console.log('FleetPicker eligibility tests passed');
