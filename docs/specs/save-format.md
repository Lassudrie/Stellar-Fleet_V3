# Spécification du format de sauvegarde `SaveFileV7`

**Version :** 1.0  
**Statut :** Brouillon

---

## 1. Objectif et enveloppe
`SaveFileV7` décrit la structure JSON des sauvegardes générées par le moteur. Chaque fichier est sérialisé avec `JSON.stringify(..., 2)` pour rester diffable en contrôle de source.

### 1.1. Conteneur racine
```json
{
  "version": 7,
  "createdAt": "<timestamp ISO 8601>",
  "state": { /* GameStateDTO */ }
}
```

- `version` : entier **obligatoire** fixé à `7` lors de l’écriture.
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
- `idRngState` : état RNG dédié aux identifiants (number). Si absent en lecture, il hérite de `rngState`.
- `startYear`, `timeMs` : repères temporels (numbers).
- `rules` : options de gameplay (`fogOfWar`, `aiEnabled`, `useAdvancedCombat`, `totalWar`).

### 2.2. Monde
- `systems` : liste des systèmes stellaires.
  - `id`, `name`, `position` (`{x,y,z}`), `color`, `size`, `resourceType`, `isHomeworld`.
  - `ownerFactionId` : identifiant de propriétaire (migration depuis `owner`).
  - `planets` : données de corps planétaires normalisées.
  - `astro` : bloc astrophysique optionnel (spectral type, étoiles, planètes). Peut être régénéré (voir § 5).
    - `stars[]` : la primaire en premier, suivie des compagnons. Les compagnons peuvent inclure un `orbit` avec `semiMajorAxisAu`, `periodDays`, `phaseDeg`, `inclinationDeg`, `ascendingNodeDeg`, `eccentricity`, `argPeriapsisDeg`, `meanAnomalyAtEpochDeg`.
    - Les planètes/lunes dans `astro` peuvent inclure des champs orbitaux (`orbitInclinationDeg`, `orbitAscendingNodeDeg`, `argPeriapsisDeg`, `meanAnomalyAtEpochDeg`, `axialTiltDeg`, `orbitEccentricity`) et climatiques (`greenhouseK`, `climateK`, `airMassIndex`, `seasonalDeltaK`) recalculés si absents.

### 2.3. Forces et conflits
- `fleets` : flottes avec position (`Vector3DTO`), état (`FleetState`), cibles, rayon et liste de vaisseaux.
- `stations`: structures orbitales (id, systemId, factionId, type, anchorBodyId?, slotIndex?).
- `armies` : unités terrestres embarquées ou déployées (`ArmyState`, profil strict, conteneur, `surfacePos` optionnelle avec `tileId` et éventuels `q/r` legacy, ordres persistants, `landingOrder`, `lastDeployedTimeMs`/`lastCombatTimeMs`, morale/fatigue, ranges, projection).
- `groundBuildings` : bâtiments persistés en surface (type, position, tags, anti‑orbital, `surfacePos` avec `tileId` et éventuellement `q/r` pour les surfaces rectangulaires legacy).
- `settlementControl` : contrôle persisté des settlements (factionId + lastCaptureTimeMs).
- `bombardedTilesByBodyId` : tuiles bombardées au tick courant, indexées par `bodyId` (liste de `tileId`).
- `battles` : résolutions spatiales, incluant `winnerFactionId`, `initialShips`, `survivorShipIds`, pertes et compteurs.
- `logs` : journaux texte.
- `messages` : notifications joueur (payloads arbitraires sérialisables JSON).

### 2.4. IA et objectifs
- `aiState` (hérité) ou `aiStates` (par faction) avec observations et priorités.
- `objectives` : conditions de victoire (`type`, `value?`) et éventuel `maxTimeMs`.
- `winnerFactionId` : gagnant (`<factionId>`, `'draw'` ou `null`).

## 3. Champs sensibles et validations
- **Références croisées** : `playerFactionId`, `ownerFactionId`, `factionId` (flottes/armées) et `winnerFactionId` doivent appartenir au registre `factions`. Une faction inconnue déclenche une erreur à la désérialisation.
- **Vecteurs** : `position` et `targetPosition` doivent porter des composantes numériques finies (`x`, `y`, `z`). Toute valeur non numérique lève une erreur contextuelle.
- **Seeds et RNG** : `seed` et `rngState` doivent être des nombres finis. `idRngState` doit être fini lorsqu’il est présent (sinon il hérite de `rngState`).
- **Points de vie et consommables** : `hp` est clampé à `[0, maxHp]`; les munitions (`offensiveMissiles`, `torpedoes`, `interceptors`) sont remises à leur stock du vaisseau quand la valeur est manquante ou invalide.
- **Kill history & messages** : les entrées sont assainies (`id` par défaut, dates numériques, chaînes forcées) pour éviter les charges arbitraires.

## 4. Politique de compatibilité V7

- **Lecture tolérante** : les versions `2` à `7` sont acceptées et migrées vers le runtime courant.
- **Écriture stricte** : toute version différente de `7` est rejetée à l’écriture.
- Les champs absents ou invalides sont assainis pour préserver le déterminisme.

## 5. Gestion des champs manquants
- `factions` ou `playerFactionId` absents : injection de factions par défaut (Blue/Red) et sélection du joueur sur la première faction disponible.
- `systems`, `fleets`, `armies`, `battles`, `logs`, `messages` : remplacés par des tableaux vides si absents (mais un type incorrect provoque une erreur explicite).
- `stateStartTimeMs`, `retreating`, `invasionTargetSystemId`, `loadTargetSystemId`, `unloadTargetSystemId` : valeurs par défaut (`0`, `false`, `null`).
- `idRngState` : hérite de `rngState` si absent.
- `members/maxMembers/condition/morale/fatigue` : valeurs clampées ou défauts issus des stats d’unité si absentes.
- `lastDeployedTimeMs` / `lastCombatTimeMs` : optionnels, ignorés si absents ou invalides.
- `bombardedTilesByBodyId` : valeur par défaut `{}` si absente. Le legacy `bombardedHexesByBodyId` est accepté en lecture et converti en `tileId`.
- `objectives` et `rules` : valeurs par défaut si manquantes (`conditions: []`, règles activées).
- **Échecs bloquants** : positions invalides, `seed`/`rngState` non finis (ou `idRngState` non fini s’il est fourni) ou formats non array (`systems`, `fleets`) interrompent immédiatement le chargement avec un message d’erreur explicite.

## 6. Régénération et dérivations (astro, seeds)
- **Bloc `astro`** : si absent ou invalide, il est régénéré via `generateStellarSystem({ worldSeed: seed, systemId, systemPosition, galacticRadius })` quand ces infos sont disponibles, à condition de disposer d’une `seed` valide et d’un `id` de système non vide. Sinon, `astro` reste `undefined` et les planètes sont simplement normalisées.
- **Planètes** : toujours passées par `normalizePlanetBodies` avec le contexte système pour garantir la cohérence des références et des types.
- **RNG** : `rngState` hérite de `seed` lorsqu’il manque, et `idRngState` hérite de `rngState` pour préserver la continuité des identifiants.
- **Consommables navals** : les stocks sont recalculés à partir des `SHIP_STATS` lorsque les champs de munitions sont manquants, évitant des vaisseaux bloqués sans armement.

## 7. Bonnes pratiques d’écriture
- Toujours remplir `ownerFactionId` et `factionId` avec des identifiants valides plutôt que de s’appuyer sur les migrations.
- Inclure `astro` pour les systèmes générés procéduralement lorsque c’est possible afin d’éviter une régénération qui pourrait différer légèrement en cas d’évolution de l’algorithme.
- Garder `createdAt` en ISO 8601 pour le tri chronologique et le diagnostic.
