
# Scenario Specification (spec.md)

**Version:** 1.0  
**Status:** Approved  
**Target Audience:** Engine Developers, Scenario Designers, Modders  

---

## 1. Introduction

### 1.1 Purpose
The **Scenario** is the single source of truth for initializing a game session in *Stellar Fleet*. It is a static, data-driven configuration file that describes the initial state of the universe, the participating actors, and the rules of engagement.

### 1.2 Architectural Principles
*   **Data-Driven:** A scenario contains **no code**. It is purely declarative (JSON/YAML).
*   **Engine Agnostic:** The scenario defines *what* to load, not *how* to simulate it. The engine consumes the scenario contract, parses it, and instantiates the runtime GameState.
*   **Immutability:** A scenario definition does not change during gameplay. It is a template used to seed the initial mutable GameState.
*   **Decoupled:** The scenario system is unaware of the UI or specific AI implementations. It only references them via string identifiers (IDs).

---

## 2. Schema Versioning

To support long-term backward compatibility and community mods, every scenario file must declare a schema version.

*   **Field:** `schemaVersion` (integer, required).
*   **Current Version:** `1`
*   **Versioning Policy:**
    *   **Minor changes** (adding optional fields) do not require a version bump.
    *   **Breaking changes** (renaming required fields, changing structure) require a version bump.
    *   The Engine must implement migrations or legacy loaders for older schema versions.

---

## 3. Contract Overview

A scenario definition is composed of five primary sections:

```text
ScenarioDefinition
├── meta          (Display info, ID, author)
├── generation    (Map topology, seed, physics constants)
├── setup         (Factions, fleet placements, starting resources)
├── objectives    (Win/Loss conditions, time limits)
└── rules         (Gameplay toggles, mutators)
```

---

## 4. Section: Meta

Metadata used primarily by the Main Menu / Scenario Selector UI to display information to the player before the game starts.

| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `id` | string | Yes | Unique identifier (snake_case). Used for saves and references. |
| `title` | string | Yes | Human-readable title. |
| `description` | string | Yes | Flavor text or tactical briefing. |
| `author` | string | No | Creator name. |
| `version` | string | No | Semantic version of the scenario itself (e.g., "1.2.0"). |
| `difficulty` | integer | Yes | 1 (Easy) to 5 (Impossible). Visual indicator only. |
| `tags` | string[] | No | Filtering keys (e.g., `["duel", "huge_map", "tutorial"]`). |

---

## 5. Section: Generation

Defines how the physical universe (Star Systems) is constructed.

| Field | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `fixedSeed` | integer \| null | Yes | If set, the map is identical every run. If `null`, the Engine generates a random seed. |
| `systemCount` | integer | Yes | Target number of star systems to generate. |
| `radius` | number | Yes | The physical radius of the playable galaxy (game units). |
| `topology` | string | Yes | The algorithm used for star placement. Enum: `spiral`, `cluster`, `ring`, `scattered`. |
| `density` | number | No | Optional modifier for distance between stars (default: 1.0). |

---

## 6. Section: Setup

Defines the political and military state of the galaxy at Turn 0.

### 6.1 Factions
List of participants.

```json
{
  "id": "blue",
  "name": "United Earth Fleet",
  "colorHex": "#3b82f6",
  "isPlayable": true,
  "aiProfile": "defensive" // optional reference to AI behavior tree
}
```

### 6.2 Starting Distribution
Defines how factions are placed relative to the map topology.

*   **Field:** `startingDistribution` (enum).
*   **Values:**
    *   `scattered`: Factions spawn at random points far from each other.
    *   `cluster`: Factions spawn with a guaranteed cluster of safe systems.
    *   `equidistant`: Factions spawn in a perfect circle (competitive).
    *   `none`: No territory ownership at start (Battle Royale).

### 6.3 Initial Fleets
Explicit placement of military assets.

| Field | Type | Description |
| :--- | :--- | :--- |
| `ownerFactionId` | string | Must match a Faction ID defined above. |
| `spawnLocation` | string \| object | Location strategy. <br>`"home_system"`: The faction's capital.<br>`"random"`: Any neutral system.<br>`{x, y, z}`: Specific deep space coordinates. |
| `ships` | string[] | Array of Ship Design IDs (e.g., `["carrier_mk1", "frigate_std"]`). |
| `behavior` | string | (Optional) Initial AI state (e.g., `guard`, `scout`). |

---

## 7. Section: Objectives

Defines how the game ends. The Engine evaluates these conditions at the end of every turn.

### 7.1 Victory Conditions
An array of condition objects. Logic is typically **OR** (meeting any condition triggers victory), unless specified otherwise.

*   **Type:** `elimination`
    *   Description: Destroy all enemy assets.
*   **Type:** `domination`
    *   Param: `percentage` (e.g., 0.75 for 75% of systems).
*   **Type:** `survival`
    *   Param: `turns` (e.g., 50). Player wins if they exist at turn 50.
*   **Type:** `king_of_the_hill`
    *   Param: `systemId` (Requires static system definition support).
    *   Param: `turnsHeld`.

### 7.2 Constraints
*   `maxTurns`: (integer) Hard limit. If reached without victory, results in Draw or Defeat based on engine logic.

---

## 8. Section: Rules

Global mutators that toggle engine subsystems. Allows for "Arcade" modes or "Hardcore" simulations.

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `fogOfWar` | boolean | `true` | If false, all fleets are visible constantly. |
| `diplomacyEnabled` | boolean | `true` | Enables trading/alliances. |
| `researchEnabled` | boolean | `true` | Enables tech tree progression. |
| `randomEvents` | boolean | `true` | Enables solar flares, space anomalies, etc. |
| `combatModel` | string | `"v1_standard"` | Selects the combat resolution algorithm. |

---

## 9. Validation Constraints

To ensure stability, the Engine's Scenario Loader must enforce:

1.  **Referential Integrity:** All `ownerFactionId` references must match an ID in the `setup.factions` list.
2.  **Ship Validity:** All strings in `ships` arrays must match valid Ship Templates in the Engine's Unit Database.
3.  **Minimums:**
    *   At least 2 factions defined (unless `single_player_sandbox`).
    *   `systemCount` >= `factions.length`.
4.  **Formatting:** `colorHex` must be a valid 6-char hex string (`#RRGGBB`).

---

## 10. Examples

### 10.1 Minimal Example
*A standardized 1v1 skirmish.*

```json
{
  "schemaVersion": 1,
  "id": "skirmish_std_1v1",
  "meta": {
    "title": "Standard Skirmish",
    "description": "A quick 1v1 battle on a small map.",
    "difficulty": 2
  },
  "generation": {
    "fixedSeed": null,
    "systemCount": 40,
    "radius": 100,
    "topology": "cluster"
  },
  "setup": {
    "factions": [
      { "id": "blue", "name": "Player", "colorHex": "#0000FF", "isPlayable": true },
      { "id": "red", "name": "AI", "colorHex": "#FF0000", "isPlayable": false }
    ],
    "startingDistribution": "scattered",
    "initialFleets": [
      {
        "ownerFactionId": "blue",
        "spawnLocation": "home_system",
        "ships": ["carrier_01", "frigate_01", "frigate_01"]
      },
      {
        "ownerFactionId": "red",
        "spawnLocation": "home_system",
        "ships": ["cruiser_01", "destroyer_01"]
      }
    ]
  },
  "objectives": {
    "win": [{ "type": "elimination" }]
  },
  "rules": {
    "fogOfWar": true,
    "useAdvancedCombat": true,
    "aiEnabled": true,
    "totalWar": true
  }
}
```

### 10.2 Advanced Example (Survival)
*A defensive scenario against overwhelming odds.*

```json
{
  "schemaVersion": 1,
  "id": "last_stand",
  "meta": {
    "title": "The Last Stand",
    "description": "Hold the line against the swarm for 20 turns.",
    "difficulty": 5,
    "tags": ["survival", "hard"]
  },
  "generation": {
    "fixedSeed": 99887766,
    "systemCount": 200,
    "radius": 500,
    "topology": "ring"
  },
  "setup": {
    "factions": [
      { "id": "defenders", "name": "Guardians", "colorHex": "#FFFFFF", "isPlayable": true },
      { "id": "swarm", "name": "The Hive", "colorHex": "#00FF00", "isPlayable": false, "aiProfile": "aggressive_swarm" }
    ],
    "startingDistribution": "none",
    "initialFleets": [
      {
        "ownerFactionId": "defenders",
        "spawnLocation": { "x": 0, "y": 0, "z": 0 },
        "ships": ["station_citadel", "carrier_heavy", "carrier_heavy"]
      },
      {
        "ownerFactionId": "swarm",
        "spawnLocation": "random",
        "ships": ["swarmer", "swarmer", "swarmer", "swarmer", "swarmer"]
      }
    ]
  },
  "objectives": {
    "win": [
      { "type": "survival", "value": 20 }
    ]
  },
  "rules": {
    "fogOfWar": false,
    "diplomacyEnabled": false
  }
}
```

---

## 11. Future Evolution

This contract is designed to be extended. Planned evolutions for Schema v2+:

1.  **Scripted Events:** A `scripts` section defining triggers (e.g., "On Turn 10, spawn reinforcement").
2.  **Asset Overrides:** Allowing a scenario to define custom Ship Stats or Unit Models locally, enabling full-conversion mods via a single JSON entry.
3.  **Linked Scenarios:** A `nextScenarioId` field in `objectives` to enable linear campaigns where the state of the winner carries over.
