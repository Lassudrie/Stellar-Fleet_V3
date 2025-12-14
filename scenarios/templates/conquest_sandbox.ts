
import { ScenarioDefinitionV1 } from '../schemaV1';

const conquestSandbox: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: "conquest_sandbox",
  meta: {
    title: "Conquest Sandbox",
    description: "An open-ended sandbox scenario with a Ring topology and a central Galactic Core.",
    difficulty: 2,
    tags: ["Sandbox", "Ring"]
  },
  generation: {
    systemCount: 80,
    radius: 120,
    topology: "ring",
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
    startingDistribution: "cluster", // Should grant 1 Home + 4 Neighbors
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
    totalWar: true
  }
};

export default conquestSandbox;
