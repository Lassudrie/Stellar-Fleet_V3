import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FleetPicker from '../ui/FleetPicker';
import { I18nProvider } from '../../i18n';
import { Fleet, FleetState, ShipType, StarSystem } from '../../types';

const targetSystem: StarSystem = {
  id: 'sys-1',
  name: 'Target',
  position: { x: 0, y: 0, z: 0 },
  color: '#ffffff',
  size: 1,
  ownerFactionId: 'blue',
  resourceType: 'none',
  isHomeworld: false,
  planets: []
};

const baseFleet: Omit<Fleet, 'id' | 'position'> = {
  factionId: 'blue',
  ships: [{ id: 'ship-1', type: ShipType.CRUISER, hp: 100, maxHp: 100, carriedArmyId: null }],
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
};

const fleets: Fleet[] = [
  { ...baseFleet, id: 'fleet_near', position: { x: 0, y: 0, z: 0 } },
  { ...baseFleet, id: 'fleet_far', position: { x: 20, y: 0, z: 0 } }
];

const renderedText = renderToStaticMarkup(
  <I18nProvider>
    <FleetPicker
      mode="MOVE"
      targetSystem={targetSystem}
      blueFleets={fleets}
      onSelectFleet={() => undefined}
      onClose={() => undefined}
    />
  </I18nProvider>
);

assert.ok(renderedText.includes('FLEET FAR'), 'Distant fleet should be rendered');
assert.ok(!renderedText.includes('FLEET NEAR'), 'Fleet already in orbit should be filtered out');

console.log('FleetPicker distance threshold test passed');
