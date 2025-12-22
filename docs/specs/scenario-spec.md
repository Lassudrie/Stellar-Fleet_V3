
# Spécification des scénarios (ScenarioDefinitionV1)

**Version :** 1.0  
**Statut :** Approved  
**Public cible :** Développeurs moteur, concepteurs de scénarios, moddeurs  

---

## 1. Introduction

### 1.1 Objet
Le **ScenarioDefinitionV1** est la source unique pour initialiser une partie de *Stellar Fleet*. Le format est pensé pour :

* **Templates TypeScript** dans `src/content/scenarios/templates/*.ts` (export d'un `const` typé `ScenarioDefinitionV1`).
* **JSON sérialisable** sans logique (même forme que le template, utilisable par des mods ou des outils).

Le moteur consomme ces données, instancie l'état initial et ne dépend d'aucune fonction définie dans le scénario.

### 1.2 Principes
* **Data-driven :** aucune fonction, uniquement des valeurs sérialisables.
* **Immutabilité :** la définition sert à ensemencer le GameState mutable, mais ne change pas en cours de partie.
* **Découplage :** le scénario ne connaît pas l'UI ni les implémentations IA, seulement des identifiants (IDs).

---

## 2. Versionnage de schéma

* **Champ :** `schemaVersion` (entier, requis).  
* **Version actuelle :** `1`.  
* **Politique :**
  * Ajouts optionnels : pas de bump.
  * Ruptures (renommage de champs requis, changement de structure) : bump obligatoire + loader rétrocompatible.

---

## 3. Vue d'ensemble du contrat

```text
ScenarioDefinitionV1
├── schemaVersion (1)
├── id            (identifiant racine du scénario)
├── meta          (titre, description, auteur, difficulté, tags)
├── generation    (topologie, seed fixe, placement statique éventuel)
├── setup         (factions, répartition initiale, flottes de départ)
├── objectives    (conditions de victoire/défaite)
└── rules         (toggles de gameplay)
```

---

## 4. Racine

| Champ | Type | Requis | Description |
| :--- | :--- | :---: | :--- |
| `schemaVersion` | `1` | Oui | Version du contrat. |
| `id` | string | Oui | Identifiant unique du scénario (snake_case recommandé). |

Tous les autres champs sont regroupés par section (`meta`, `generation`, `setup`, `objectives`, `rules`).

---

## 5. Section `meta`

| Champ | Type | Requis | Description |
| :--- | :--- | :---: | :--- |
| `title` | string | Oui | Nom affiché. |
| `description` | string | Oui | Texte court ou briefing. |
| `author` | string | Non | Crédit ou source du mod. |
| `difficulty` | number | Oui | 1 (facile) à 5 (très difficile). Indicateur UI. |
| `tags` | string[] | Non | Filtres (ex. `["Spiral", "Sandbox"]`). |

---

## 6. Section `generation`

| Champ | Type | Requis | Description |
| :--- | :--- | :---: | :--- |
| `fixedSeed` | number | Non | Si défini, génération déterministe. Si omis, seed aléatoire. |
| `systemCount` | number | Oui | Nombre cible de systèmes stellaires. |
| `radius` | number | Oui | Rayon logique de la galaxie. |
| `topology` | `"spiral" \| "cluster" \| "ring" \| "scattered"` | Oui | Algorithme de placement. |
| `minimumSystemSpacingLy` | number | Non | Distance minimale entre systèmes. Défaut : `5`. Mettre `0` pour désactiver. |
| `staticSystems` | array | Non | Points fixes injectés dans la carte. |

### 6.1 `staticSystems` (optionnel)
```ts
{
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
  resourceType: "gas" | "none";
  planets?: Array<{
    id?: string;
    name?: string;
    bodyType: "planet" | "moon";
    class: "solid" | "gas_giant" | "ice_giant";
    size?: number;
    ownerFactionId?: string | null;
  }>;
}
```

---

## 7. Section `setup`

### 7.1 Factions (`factions`)

```ts
{
  id: string;
  name: string;
  colorHex: string;          // "#RRGGBB"
  isPlayable: boolean;       // Sélectionnable par le joueur ?
  aiProfile?: "aggressive" | "defensive" | "balanced";
}
```

### 7.2 Distribution initiale

| Champ | Type | Requis | Description |
| :--- | :--- | :---: | :--- |
| `startingDistribution` | `"scattered" \| "cluster" \| "none"` | Oui | Logique de placement initial (systèmes maison isolés, groupés, ou aucun territoire). |
| `territoryAllocation` | object | Non | Cible de répartition lors de la génération. |

`territoryAllocation` (si présent) suit la forme :
```ts
{
  type: "percentages";
  byFactionId: Record<string, number>; // parts 0..1
  neutralShare?: number;               // part neutre (défaut : reste)
  contiguity?: "clustered";            // défaut : "clustered"
}
```

### 7.3 Flottes initiales (`initialFleets`)

| Champ | Type | Requis | Description |
| :--- | :--- | :---: | :--- |
| `ownerFactionId` | string | Oui | Doit référencer une faction déclarée. |
| `spawnLocation` | `"home_system" \| "random" \| {x:number,y:number,z:number}` | Oui | Point d'apparition. |
| `ships` | string[] | Oui | IDs de modèles de vaisseaux (base de données moteur). |
| `withArmies` | boolean | Non | Si `true`, des armées embarquées sont créées sur les transports. |

---

## 8. Section `objectives`

Structure :
```ts
{
  win: Array<{
    type: "elimination" | "domination" | "survival" | "king_of_the_hill";
    value?: number | string;
  }>;
  maxTurns?: number;
}
```

### 8.1 Sémantique runtime

* **OR logique :** une seule condition de `win` suffit. Si la liste est vide, l'élimination sert de fallback par faction.
* **`domination` :** `value` attendu en pourcentage 0..100 (défaut 50). Le moteur compare la part de systèmes possédés.  
* **`king_of_the_hill` :** `value` doit être l'ID d'un système existant (idéalement défini dans `staticSystems`).  
* **`survival` :** se combine avec `maxTurns`. Quand `day >= maxTurns`, la victoire revient à la faction du joueur si elle a encore présence (sinon `draw`). La condition ne se déclenche pas avant cette limite.
* **`maxTurns` :** borne dure. Sans `survival`, la résolution dépend de la possession de systèmes (égalité possible).

---

## 9. Section `rules`

| Champ | Type | Requis | Description |
| :--- | :--- | :---: | :--- |
| `fogOfWar` | boolean | Oui | Brouillard de guerre actif ? |
| `useAdvancedCombat` | boolean | Oui | Modèle de combat V1 (true) ou simplifié V0 (false). |
| `aiEnabled` | boolean | Oui | Active l'IA. |
| `totalWar` | boolean | Oui | Désactive diplomatie/échanges (guerre totale). |

---

## 10. Contraintes de validation

1. **Intégrité référentielle :** `ownerFactionId` des flottes et des planètes statiques doit correspondre à une faction déclarée (ou `null` pour neutre).  
2. **Règles de base :** au moins deux factions pour un mode compétitif ; `systemCount` ≥ `factions.length`.  
3. **Formats :** `colorHex` = `#RRGGBB`; `minimumSystemSpacingLy` ≥ 0.  
4. **Conditions :** `domination.value` en pourcentage, `king_of_the_hill.value` pointe un système existant, `survival` doit être accompagné d'un `maxTurns` cohérent.

---

## 11. Exemples compatibles runtime

### 11.1 Template TypeScript minimal (1v1)

```ts
import { ScenarioDefinitionV1 } from "../schemaV1";

const skirmishStd1v1: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: "skirmish_std_1v1",
  meta: {
    title: "Escarmouche Standard",
    description: "Un affrontement rapide sur une petite carte.",
    difficulty: 2
  },
  generation: {
    systemCount: 40,
    radius: 100,
    topology: "cluster"
  },
  setup: {
    factions: [
      { id: "blue", name: "Joueur", colorHex: "#0000FF", isPlayable: true },
      { id: "red", name: "IA", colorHex: "#FF0000", isPlayable: false }
    ],
    startingDistribution: "scattered",
    initialFleets: [
      { ownerFactionId: "blue", spawnLocation: "home_system", ships: ["carrier", "frigate", "frigate"] },
      { ownerFactionId: "red", spawnLocation: "home_system", ships: ["cruiser", "destroyer"] }
    ]
  },
  objectives: { win: [{ type: "elimination" }] },
  rules: { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: true }
};

export default skirmishStd1v1;
```

### 11.2 JSON équivalent (modding)

```json
{
  "schemaVersion": 1,
  "id": "skirmish_std_1v1",
  "meta": {
    "title": "Escarmouche Standard",
    "description": "Un affrontement rapide sur une petite carte.",
    "difficulty": 2
  },
  "generation": { "systemCount": 40, "radius": 100, "topology": "cluster" },
  "setup": {
    "factions": [
      { "id": "blue", "name": "Joueur", "colorHex": "#0000FF", "isPlayable": true },
      { "id": "red", "name": "IA", "colorHex": "#FF0000", "isPlayable": false }
    ],
    "startingDistribution": "scattered",
    "initialFleets": [
      { "ownerFactionId": "blue", "spawnLocation": "home_system", "ships": ["carrier", "frigate", "frigate"] },
      { "ownerFactionId": "red", "spawnLocation": "home_system", "ships": ["cruiser", "destroyer"] }
    ]
  },
  "objectives": { "win": [{ "type": "elimination" }] },
  "rules": { "fogOfWar": true, "useAdvancedCombat": true, "aiEnabled": true, "totalWar": true }
}
```

### 11.3 Exemple avancé (statique + domination)

```ts
import { ScenarioDefinitionV1 } from "../schemaV1";

const spiralConvergence: ScenarioDefinitionV1 = {
  schemaVersion: 1,
  id: "spiral_convergence",
  meta: {
    title: "Convergence Spiralée",
    description: "Deux coalitions convergent vers le noyau.",
    difficulty: 3,
    tags: ["Spiral", "Conquest"]
  },
  generation: {
    systemCount: 72,
    radius: 140,
    topology: "spiral",
    minimumSystemSpacingLy: 6,
    staticSystems: [
      { id: "aurora_gate", name: "Aurora Gate", position: { x: -18, y: 6, z: 0 }, resourceType: "gas" },
      { id: "ember_core", name: "Ember Core", position: { x: 18, y: -6, z: 0 }, resourceType: "gas" }
    ]
  },
  setup: {
    factions: [
      { id: "aurora", name: "Aurora Coalition", colorHex: "#38bdf8", isPlayable: true },
      { id: "ember", name: "Ember Dominion", colorHex: "#f97316", isPlayable: false, aiProfile: "balanced" }
    ],
    startingDistribution: "cluster",
    territoryAllocation: {
      type: "percentages",
      byFactionId: { aurora: 0.12, ember: 0.12 },
      neutralShare: 0.76,
      contiguity: "clustered"
    },
    initialFleets: [
      { ownerFactionId: "aurora", spawnLocation: "home_system", ships: ["carrier", "cruiser", "destroyer", "destroyer", "frigate", "fighter"], withArmies: false },
      { ownerFactionId: "aurora", spawnLocation: "random", ships: ["troop_transport", "destroyer", "frigate"], withArmies: true },
      { ownerFactionId: "ember", spawnLocation: "home_system", ships: ["carrier", "cruiser", "destroyer", "destroyer", "frigate", "bomber"], withArmies: false },
      { ownerFactionId: "ember", spawnLocation: "random", ships: ["troop_transport", "destroyer", "frigate"], withArmies: true }
    ]
  },
  objectives: {
    win: [
      { type: "elimination" },
      { type: "domination", value: 65 }
    ]
  },
  rules: { fogOfWar: true, useAdvancedCombat: true, aiEnabled: true, totalWar: true }
};

export default spiralConvergence;
```

Ces exemples respectent le contrat `ScenarioDefinitionV1` et sont sérialisables en JSON sans logique.
