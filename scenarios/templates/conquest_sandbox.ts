import { ShipType } from '../../types';
import { ScenarioDefinitionV1 } from '../schemaV1';

const conquestSandbox: ScenarioDefinitionV1 = {
  id: 'conquest_sandbox',
  name: 'Conquest Sandbox',
  description: 'A sandbox scenario for testing conquest mechanics',
  version: 1,
  initialDay: 0,
  rules: {
    fogOfWar: true,
    useAdvancedCombat: true,
    aiEnabled: true,
    totalWar: true,

    // Deterministic ground combat (attrition guaranteed).
    groundCombat: {
      enabled: true,
      model: 'deterministic_attrition_v1',
      configId: 'default'
    }
  },
  factions: [
    {
      id: 'blue',
      name: 'Terran Federation',
      color: '#4A90E2',
      resources: { metal: 200, crystal: 100, fuel: 300 },
      aiControlled: false
    },
    {
      id: 'red',
      name: 'Zorgon Empire',
      color: '#E74C3C',
      resources: { metal: 200, crystal: 100, fuel: 300 },
      aiControlled: true
    }
  ],
  systems: [
    {
      id: 'sol',
      name: 'Sol',
      position: { x: 0, y: 0, z: 0 },
      ownerFactionId: 'blue',
      population: 10,
      maxPopulation: 20,
      economy: 10,
      defenseLevel: 3,
      resources: { metal: 3, crystal: 2, fuel: 2 }
    },
    {
      id: 'alpha_centauri',
      name: 'Alpha Centauri',
      position: { x: 15, y: 0, z: 0 },
      ownerFactionId: 'red',
      population: 8,
      maxPopulation: 15,
      economy: 8,
      defenseLevel: 2,
      resources: { metal: 2, crystal: 3, fuel: 1 }
    },
    {
      id: 'barnards_star',
      name: "Barnard's Star",
      position: { x: 5, y: 12, z: 0 },
      ownerFactionId: null,
      population: 5,
      maxPopulation: 10,
      economy: 5,
      defenseLevel: 1,
      resources: { metal: 4, crystal: 1, fuel: 3 }
    }
  ],
  fleets: [
    {
      id: 'blue_fleet_1',
      name: '1st Fleet',
      factionId: 'blue',
      position: { x: 0, y: 0, z: 0 },
      fuel: 200,
      ships: [
        { id: 'blue_ship_1', type: ShipType.DESTROYER, hp: 200 },
        { id: 'blue_ship_2', type: ShipType.FRIGATE, hp: 120 },
        { id: 'blue_transport_1', type: ShipType.TROOP_TRANSPORT, hp: 150, carriedArmyId: null }
      ]
    },
    {
      id: 'red_fleet_1',
      name: 'Zorgon Armada',
      factionId: 'red',
      position: { x: 15, y: 0, z: 0 },
      fuel: 200,
      ships: [
        { id: 'red_ship_1', type: ShipType.CRUISER, hp: 300 },
        { id: 'red_ship_2', type: ShipType.DESTROYER, hp: 200 },
        { id: 'red_transport_1', type: ShipType.TROOP_TRANSPORT, hp: 150, carriedArmyId: null }
      ]
    }
  ],
  armies: [
    {
      id: 'blue_army_1',
      factionId: 'blue',
      strength: 15000,
      state: 'deployed',
      containerId: 'sol'
    },
    {
      id: 'red_army_1',
      factionId: 'red',
      strength: 15000,
      state: 'deployed',
      containerId: 'alpha_centauri'
    }
  ]
};

export default conquestSandbox;
