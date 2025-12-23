import assert from 'node:assert';
import { deserializeGameState, serializeGameState } from '../serialization';
import { SAVE_VERSION } from '../saveFormat';
import { ArmyState, FleetState, FactionState, GameState, ShipType, StarSystem, Fleet, ShipEntity, PlanetBody } from '../../shared/types';
import { quantizeFuel } from '../logistics/fuel';

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }
];

const createPlanet = (systemId: string): PlanetBody => ({
  id: `planet-${systemId}-1`,
  systemId,
  name: `${systemId} I`,
  bodyType: 'planet',
  class: 'solid',
  ownerFactionId: 'blue',
  size: 1,
  isSolid: true
});

const createSystem = (id: string): StarSystem => ({
  id,
  name: id,
  position: { x: 0, y: 0, z: 0 },
  color: '#ffffff',
  size: 1,
  ownerFactionId: 'blue',
  resourceType: 'none',
  isHomeworld: false,
  planets: [createPlanet(id)]
});

const createFleet = (id: string, system: StarSystem): Fleet => {
  const ship: ShipEntity = {
    id: `${id}-ship`,
    type: ShipType.FRIGATE,
    hp: 50,
    maxHp: 50,
    fuel: 50,
    carriedArmyId: null
  };

  return {
    id,
    factionId: 'blue',
    ships: [ship],
    position: { ...system.position },
    state: FleetState.ORBIT,
    targetSystemId: null,
    targetPosition: null,
    radius: 1,
    stateStartTurn: 0
  };
};

const createBaseState = (): GameState => {
  const system = createSystem('sys-1');
  const fleet = createFleet('fleet-1', system);
  return {
    scenarioId: 'test',
    scenarioTitle: 'Test',
    playerFactionId: 'blue',
    factions,
    seed: 42,
    rngState: 42,
    startYear: 0,
    day: 0,
    systems: [system],
    fleets: [fleet],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: [],
    selectedFleetId: null,
    winnerFactionId: null,
    objectives: { conditions: [] },
    rules: { fogOfWar: false, aiEnabled: true, useAdvancedCombat: true, totalWar: false, unlimitedFuel: false }
  };
};

{
  const base = createBaseState();
  const save = JSON.parse(serializeGameState(base));
  save.version = SAVE_VERSION + 1;

  assert.throws(
    () => deserializeGameState(JSON.stringify(save)),
    /newer than supported/,
    'Future save versions should be rejected'
  );
}

{
  const base = createBaseState();
  const save = JSON.parse(serializeGameState(base));
  const planetId = base.systems[0].planets[0].id;

  save.state.armies = [
    {
      id: 'army-bad',
      factionId: 'blue',
      strength: 'bad',
      maxStrength: 'bad',
      morale: 1,
      state: ArmyState.DEPLOYED,
      containerId: planetId
    }
  ];

  const restored = deserializeGameState(JSON.stringify(save));
  assert.strictEqual(restored.armies.length, 0, 'Invalid armies should be dropped during deserialization');
}

{
  const base = createBaseState();
  const save = JSON.parse(serializeGameState(base));
  const systemId = base.systems[0].id;
  const fleetId = base.fleets[0].id;

  save.state.battles = [
    {
      id: 'battle-bad',
      systemId,
      turnCreated: 0,
      status: 'unknown',
      involvedFleetIds: [fleetId],
      logs: []
    }
  ];

  const restored = deserializeGameState(JSON.stringify(save));
  assert.strictEqual(restored.battles.length, 0, 'Invalid battles should be dropped during deserialization');
}

{
  const base = createBaseState();
  const save = JSON.parse(serializeGameState(base));

  save.state.logs = Array.from({ length: 6000 }, (_, i) => ({
    id: `log-${i}`,
    day: i,
    text: 'test',
    type: 'info'
  }));

  save.state.messages = Array.from({ length: 1500 }, (_, i) => ({
    id: `message-${i}`,
    day: i,
    type: 'generic',
    priority: 0,
    title: 'Test',
    subtitle: '',
    lines: ['line'],
    payload: {},
    read: false,
    dismissed: false,
    createdAtTurn: i
  }));

  const restored = deserializeGameState(JSON.stringify(save));
  assert.ok(restored.logs.length < 6000, 'Logs should be truncated on load to prevent overload');
  assert.ok(restored.messages.length < 1500, 'Messages should be truncated on load to prevent overload');
}

{
  const base = createBaseState();
  const save = JSON.parse(serializeGameState(base));
  const ship = save.state.fleets[0].ships[0];

  ship.maxHp = 200;
  ship.hp = -10;
  ship.fuel = 1499.99994;
  ship.consumables = { offensiveMissiles: -1, torpedoes: 3.7, interceptors: 'bad' };

  const restored = deserializeGameState(JSON.stringify(save));
  const restoredShip = restored.fleets[0].ships[0];

  assert.strictEqual(restoredShip.hp, 0, 'Negative hp should clamp to zero');
  assert.strictEqual(restoredShip.maxHp, 200, 'Valid maxHp should be preserved');
  assert.strictEqual(
    restoredShip.fuel,
    quantizeFuel(1500),
    'Fuel should be clamped to capacity then quantized'
  );
  assert.strictEqual(
    restoredShip.consumables.offensiveMissiles,
    4,
    'Invalid consumables should fall back to stock'
  );

  const roundTripped = JSON.parse(serializeGameState(restored));
  const persistedShip = roundTripped.state.fleets[0].ships[0];

  assert.strictEqual(
    persistedShip.fuel,
    restoredShip.fuel,
    'Round-trip serialization should preserve sanitized fuel'
  );
}

console.log('serialization robustness tests passed');
