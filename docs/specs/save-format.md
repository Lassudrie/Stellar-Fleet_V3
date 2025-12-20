# Spécification du format de sauvegarde `SaveFileV3`

**Version :** 1.0  
**Statut :** Brouillon

---

## 1. Objectif et enveloppe
`SaveFileV3` décrit la structure JSON des sauvegardes générées par le moteur. Chaque fichier est sérialisé avec `JSON.stringify(..., 2)` pour rester diffable en contrôle de source.

### 1.1. Conteneur racine
```json
{
  "version": 3,
  "createdAt": "<timestamp ISO 8601>",
  "state": { /* GameStateDTO */ }
}
```

- `version` : entier **obligatoire** fixé à `3` lors de l’écriture.
- `createdAt` : horodatage ISO 8601 généré au moment de la sérialisation.
- `state` : objet `GameStateDTO` complet (voir ci‑dessous).

## 2. Structure `GameStateDTO`
Les champs reprennent l’état jouable sans données dérivées. Les noms des propriétés sont stables entre v2 et v3.

### 2.1. Métadonnées et temporalité
- `scenarioId`, `scenarioTitle` : identifiants de scénario, optionnels.
- `playerFactionId` : identifiant de la faction contrôlée localement.
- `factions` : tableau des factions (`id`, `name`, `color`, etc.).
- `seed` : graine monde **obligatoire** (number) utilisée pour les régénérations.
- `rngState` : état RNG en cours (number). Si absent en lecture, il hérite de `seed`.
- `startYear`, `day` : repères temporels (numbers).
- `rules` : options de gameplay (`fogOfWar`, `aiEnabled`, `useAdvancedCombat`, `totalWar`).

### 2.2. Monde
- `systems` : liste des systèmes stellaires.
  - `id`, `name`, `position` (`{x,y,z}`), `color`, `size`, `resourceType`, `isHomeworld`.
  - `ownerFactionId` : identifiant de propriétaire (migration depuis `owner`).
  - `planets` : données de corps planétaires normalisées.
  - `astro` : bloc astrophysique optionnel (spectral type, seeds par étoile, planètes). Peut être régénéré (voir § 5).

### 2.3. Forces et conflits
- `fleets` : flottes avec position (`Vector3DTO`), état (`FleetState`), cibles, rayon et liste de vaisseaux.
- `armies` : armées embarquées ou déployées (`ArmyState`, force, morale, conteneur).
- `battles` : résolutions spatiales, incluant `winnerFactionId`, `initialShips`, `survivorShipIds`, pertes et compteurs.
- `lasers` : tirs (`start`, `end`, couleur, durée de vie) conservés pour l’animation.
- `logs` : journaux texte.
- `messages` : notifications joueur (payloads arbitraires sérialisables JSON).

### 2.4. IA et objectifs
- `aiState` (hérité) ou `aiStates` (par faction) avec observations et priorités.
- `objectives` : conditions de victoire (`type`, `value?`) et éventuel `maxTurns`.
- `winnerFactionId` : gagnant (`<factionId>`, `'draw'` ou `null`).
- `selectedFleetId` : focus UI facultatif.

## 3. Champs sensibles et validations
- **Références croisées** : `playerFactionId`, `ownerFactionId`, `factionId` (flottes/armées) et `winnerFactionId` doivent appartenir au registre `factions`. Une faction inconnue déclenche une erreur à la désérialisation.
- **Vecteurs** : `position`, `targetPosition`, `start`/`end` des lasers doivent porter des composantes numériques finies (`x`, `y`, `z`). Toute valeur non numérique lève une erreur contextuelle.
- **Seeds et RNG** : `seed` et `rngState` doivent être des nombres finis. Une valeur absente ou non numérique entraîne un rejet du fichier.
- **Points de vie et consommables** : `hp` est clampé à `[0, maxHp]`; les munitions (`offensiveMissiles`, `torpedoes`, `interceptors`) sont remises à leur stock du vaisseau quand la valeur est manquante ou invalide.
- **Kill history & messages** : les entrées sont assainies (`id` par défaut, dates numériques, chaînes forcées) pour éviter les charges arbitraires.

## 4. Politique de migration v2 → v3
- **Compatibilité ascendante** : le chargeur accepte encore les enveloppes v2 (`version: 2`), en traitant `state` comme un `GameStateDTO` identique. La sauvegarde est réécrite en v3 lors de la prochaine sérialisation.
- **Renommages pris en charge** :
  - `owner` → `ownerFactionId` sur les systèmes.
  - `faction` → `factionId` sur les flottes, armées et snapshots de bataille.
  - `winner` → `winnerFactionId` sur les batailles et l’état global.
- **IA héritée** : si seul `aiState` (global) existe, il est re‑mappé vers `aiStates` en utilisant la faction IA principale quand elle est détectée. Les états par faction déjà présents sont conservés en priorité.
- **RNG** : un `rngState` manquant est dérivé de `seed` pour éviter une rupture de génération.
- **Normalisation des couleurs** : une couleur manquante sur un système est remplacée par celle de la faction propriétaire ou par un fallback (`COLORS.star`), avec avertissement console.

## 5. Gestion des champs manquants
- `factions` ou `playerFactionId` absents : injection de factions par défaut (Blue/Red) et sélection du joueur sur la première faction disponible.
- `systems`, `fleets`, `armies`, `lasers`, `battles`, `logs`, `messages` : remplacés par des tableaux vides si absents (mais un type incorrect provoque une erreur explicite).
- `stateStartTurn`, `retreating`, `invasionTargetSystemId`, `loadTargetSystemId`, `unloadTargetSystemId` : valeurs par défaut (`0`, `false`, `null`).
- `maxStrength` et `morale` des armées : dérivés respectivement de `strength` et `1` si omis.
- `objectives` et `rules` : valeurs par défaut si manquantes (`conditions: []`, règles activées).
- **Échecs bloquants** : positions invalides, `seed`/`rngState` non finis ou formats non array (`systems`, `fleets`) interrompent immédiatement le chargement avec un message d’erreur explicite.

## 6. Régénération et dérivations (astro, seeds)
- **Bloc `astro`** : si absent ou invalide, il est régénéré via `generateStellarSystem({ worldSeed: seed, systemId })` à condition de disposer d’une `seed` valide et d’un `id` de système non vide. Sinon, `astro` reste `undefined` et les planètes sont simplement normalisées.
- **Planètes** : toujours passées par `normalizePlanetBodies` avec le contexte système pour garantir la cohérence des références et des types.
- **RNG** : `rngState` hérite de `seed` lorsqu’il manque, assurant une continuité de génération entre anciennes sauvegardes v2 et les réécritures v3.
- **Consommables navals** : les stocks sont recalculés à partir des `SHIP_STATS` lorsque les champs de munitions sont manquants, évitant des vaisseaux bloqués sans armement.

## 7. Bonnes pratiques d’écriture
- Toujours remplir `ownerFactionId` et `factionId` avec des identifiants valides plutôt que de s’appuyer sur les migrations.
- Inclure `astro` pour les systèmes générés procéduralement lorsque c’est possible afin d’éviter une régénération qui pourrait différer légèrement en cas d’évolution de l’algorithme.
- Garder `createdAt` en ISO 8601 pour le tri chronologique et le diagnostic.
