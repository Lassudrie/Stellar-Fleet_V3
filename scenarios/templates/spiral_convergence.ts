import { ScenarioDefinitionV1 } from '../schemaV1';

const spiralConvergence: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: "spiral_convergence",
  meta: {
    title: "Spiral Convergence",
    description: "Rival coalitions converge along a tightening spiral arm, racing to seize the core while defending their expanding frontier.",
    difficulty: 3,
    tags: ["Spiral", "Conquest"]
  },
  generation: {
    systemCount: 72,
    radius: 140,
    topology: "spiral",
    minimumSystemSpacingLy: 6,
    staticSystems: [
      {
        id: "aurora_gate",
        name: "Aurora Gate",
        position: { x: -18, y: 6, z: 0 },
        resourceType: "gas"
      },
      {
        id: "ember_core",
        name: "Ember Core",
        position: { x: 18, y: -6, z: 0 },
        resourceType: "gas"
      }
    ]
  },
  setup: {
    factions: [
      { id: "aurora", name: "Aurora Coalition", colorHex: "#38bdf8", isPlayable: true },
      { id: "ember", name: "Ember Dominion", colorHex: "#f97316", isPlayable: false, aiProfile: "balanced" }
    ],
    // Cohesive starting territory instead of isolated starts.
    startingDistribution: "cluster",
    // Grow contiguous territory from each homeworld toward target shares.
    territoryAllocation: {
      type: "percentages",
      byFactionId: { aurora: 0.12, ember: 0.12 },
      neutralShare: 0.76,
      contiguity: "clustered"
    },
    initialFleets: [
      {
        ownerFactionId: "aurora",
        spawnLocation: "home_system",
        ships: ["carrier", "cruiser", "cruiser", "destroyer", "destroyer", "frigate", "bomber", "fighter", "fighter"],
        withArmies: false
      },
      {
        ownerFactionId: "aurora",
        spawnLocation: "home_system",
        ships: ["troop_transport", "troop_transport", "troop_transport", "destroyer", "frigate"],
        withArmies: true
      },
      {
        ownerFactionId: "aurora",
        spawnLocation: "random",
        ships: ["cruiser", "destroyer", "frigate", "fighter", "fighter"],
        withArmies: false
      },
      {
        ownerFactionId: "aurora",
        spawnLocation: "random",
        ships: ["troop_transport", "troop_transport", "destroyer", "frigate"],
        withArmies: true
      },
      {
        ownerFactionId: "ember",
        spawnLocation: "home_system",
        ships: ["carrier", "cruiser", "cruiser", "destroyer", "destroyer", "frigate", "bomber", "fighter", "fighter"],
        withArmies: false
      },
      {
        ownerFactionId: "ember",
        spawnLocation: "home_system",
        ships: ["troop_transport", "troop_transport", "troop_transport", "destroyer", "frigate"],
        withArmies: true
      },
      {
        ownerFactionId: "ember",
        spawnLocation: "random",
        ships: ["cruiser", "destroyer", "destroyer", "frigate", "fighter"],
        withArmies: false
      },
      {
        ownerFactionId: "ember",
        spawnLocation: "random",
        ships: ["troop_transport", "troop_transport", "destroyer", "frigate"],
        withArmies: true
      }
    ]
  },
  objectives: {
    win: [
      { type: "elimination" },
      // Domination expects a 0..100 percentage in the current engine implementation.
      { type: "domination", value: 65 }
    ]
  },
  rules: {
    fogOfWar: true,
    useAdvancedCombat: true,
    aiEnabled: true,
    totalWar: true
  }
};

export default spiralConvergence;
