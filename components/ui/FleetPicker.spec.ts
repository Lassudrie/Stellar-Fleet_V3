import assert from 'node:assert';
import { isFleetEligibleForMode } from './FleetPicker';
import { CAPTURE_RANGE_SQ } from '../../data/static';
import { Fleet, FleetState, ShipType } from '../../types';

const buildFleet = (overrides: Partial<Fleet>): Fleet => ({
  id: overrides.id ?? 'f-1',
  name: 'Test Fleet',
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
    ships: [{ id: 's1', name: 'Carrier', type: ShipType.TROOP_TRANSPORT, hp: 1, maxHp: 1, carriedArmyId: 'army-1', missiles: 0, torpedoes: 0, interceptors: 0, pdStrength: 0, damage: 0, evasion: 0, speed: 1, maneuverability: 0, role: 'transport' }],
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
    ships: [{ id: 's1', name: 'Frigate', type: ShipType.FRIGATE, hp: 1, maxHp: 1, carriedArmyId: null, missiles: 0, torpedoes: 0, interceptors: 0, pdStrength: 0, damage: 0, evasion: 0, speed: 1, maneuverability: 0, role: 'screen' }],
  });
  assert.strictEqual(
    isFleetEligibleForMode(noTransportFleet, 'LOAD', targetPosition),
    false,
    'Fleets without transports should not be selectable for LOAD'
  );
}

console.log('FleetPicker eligibility tests passed');
