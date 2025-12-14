import { ScenarioDefinitionV1 } from '../schemaV1';

const conquestSandbox: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: "conquest_sandbox",
  meta: {
    title: "Conquest Sandbox",
    description: "An open-ended sandbox conquest scenario with a Spiral galaxy. 30% Blue, 30% Red, the rest Neutral.",
    difficulty: 2,
    tags: ["Sandbox", "Spiral", "Conquest"]
  },
  generation: {
    systemCount: 50,
    radius: 110,
    topology: "spiral",
    staticSystems: [
      {
        id: "galactic_core",
        name: "Galactic Core",
        position: { x: 0, y: 0, z: 0 },
        resourceType: "gas"
      }
    ]
  },
  setup: {
    factions: [
      { id: "blue", name: "United Earth Fleet", colorHex: "#3b82f6", isPlayable: true },
      { id: "red", name: "Martian Syndicate", colorHex: "#ef4444", isPlayable: false, aiProfile: "aggressive" }
    ],
    startingDistribution: "cluster",

    // Target ownership split at game start (total includes static systems; static systems remain neutral).
    // 50 systems total -> Blue 15, Red 15, Neutral 20.
    territoryAllocation: {
      type: 'percentages',
      byFactionId: { red: 0.3, blue: 0.3 },
      neutralShare: 0.4,
      contiguity: 'clustered'
    },
    initialFleets: [
      {
        ownerFactionId: "blue",
        spawnLocation: "home_system",
        ships: ["carrier", "cruiser", "cruiser", "destroyer", "destroyer", "frigate", "frigate", "fighter", "fighter", "fighter"],
        withArmies: false
      },
      {
        ownerFactionId: "blue",
        spawnLocation: "home_system",
        ships: ["troop_transport", "troop_transport", "troop_transport", "troop_transport", "troop_transport", "destroyer", "frigate"],
        withArmies: true
      },
      {
        ownerFactionId: "red",
        spawnLocation: "home_system",
        ships: ["carrier", "cruiser", "cruiser", "destroyer", "destroyer", "frigate", "frigate", "bomber", "bomber", "fighter"],
        withArmies: false
      },
      {
        ownerFactionId: "red",
        spawnLocation: "home_system",
        ships: ["troop_transport", "troop_transport", "troop_transport", "troop_transport", "troop_transport", "destroyer", "frigate"],
        withArmies: true
      }
    ]
  },
  objectives: {
    win: [{ type: "elimination" }]
  },
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
  }
};

export default conquestSandbox;
