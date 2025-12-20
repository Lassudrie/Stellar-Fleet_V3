# Spécification : Brouillard de guerre & Renseignement

**Version :** 1.0  
**Statut :** Validé

---

## 1. Objectifs et périmètre
Cette spécification décrit la manière dont Stellar Fleet gère la visibilité des entités (systèmes et flottes), la production de renseignements sous forme de **sightings** (observations ennemies), leur dégradation temporelle, ainsi que la représentation UI des contacts fantômes ("ghosts"). Elle précise également comment l'IA exploite le brouillard de guerre et la mémoire des sightings (omniscience vs perception limitée).

---

## 2. Règles de visibilité (applyFogOfWar)
Le brouillard de guerre s'applique quand `rules.fogOfWar` est `true` **et** que le mode développeur "God Eyes" est désactivé. La fonction `applyFogOfWar` retourne une copie filtrée du `GameState` pour la faction observatrice (player ou IA).

### 2.1. Observation des systèmes
Un système est considéré comme **observé** si l'une des conditions est remplie :
1. Le système appartient à la faction observatrice.
2. Au moins une flotte de la faction observatrice est à portée `CAPTURE_RANGE` du système.

Les systèmes observés servent ensuite aux règles de visibilité des flottes (cf. 2.2).

### 2.2. Visibilité des flottes
Pour chaque flotte, la visibilité par la faction observatrice est évaluée dans l'ordre :
1. **Alliés toujours visibles** : les flottes de la faction observatrice ne sont jamais masquées.
2. **Capteurs directs** : toute flotte ennemie à portée `SENSOR_RANGE` d'au moins une flotte observatrice est visible (rencontres en espace profond).
3. **Surveillance de système** : une flotte située dans `CAPTURE_RANGE` d'un système **observé** est visible.
4. **Surveillance territoriale** : une flotte située dans le territoire contrôlé de la faction observatrice (via `getTerritoryOwner`) est visible.

Seules les flottes qui ne remplissent aucune condition sont retirées du `GameState` filtré.

### 2.3. Invariants d'affichage
* Les systèmes (propriété, couleur territoriale) restent toujours présents dans l'état filtré afin de conserver les frontières et informations de possession, même si la zone n'est plus observée.
* Les flottes alliées restent toujours visibles.
* Une flotte ennemie masquée peut provoquer la désélection automatique côté UI si elle était sélectionnée.

---

## 3. Cycle de vie des sightings côté joueur
Les sightings stockent les dernières positions connues des flottes ennemies visibles pour le joueur.

### 3.1. Création / rafraîchissement
Lors du recalcul de la vue :
* Chaque flotte ennemie visible génère (ou remplace) un sighting avec :
  - `fleetId`, `factionId`, `position` (copie de la position actuelle).
  - `systemId` : `null` (réservé à l'IA, cf. section 4).
  - `daySeen` : jour courant du `GameState` **avant** filtrage.
  - `estimatedPower` : résultat de `calculateFleetPower`.
  - `confidence` : `1.0` (confiance totale pour une observation directe).
* Le sighting est remplacé si le jour évolue ou si la position change.

### 3.2. Expiration et bornes
* **Durée de vie** : tout sighting dont `daySeen < (day - ENEMY_SIGHTING_MAX_AGE_DAYS = 30)` est supprimé.
* **Quota** : au-delà de `ENEMY_SIGHTING_LIMIT = 200` entrées, seuls les 200 sightings les plus récents (par `daySeen`) sont conservés.
* `lastUpdateDay` n'est pas utilisé côté joueur : l'âge provient uniquement de `daySeen`.

---

## 4. Représentation UI des ghosts
Le composant `IntelGhosts` matérialise visuellement les sightings non visibles actuellement.

* **Filtrage** : un ghost n'est rendu que si la flotte correspondante n'est pas dans le `GameState.fleets` courant (donc masquée par le brouillard).
* **Fading temporel** :
  - Un ghost disparaît s'il a plus de 10 jours (`FADE_DURATION`) d'ancienneté.
  - L'opacité décroît linéairement de 0.5 à 0 en fonction de l'âge ; en dessous de 0.05, il n'est plus rendu.
* **Style** : tetraèdre fil de fer, couleur déterminée par la faction du sighting, non interactif (raycast ignoré).
* **Position** : la position est celle enregistrée dans le sighting (pas de prédiction de mouvement).

---

## 5. Renseignement et brouillard côté IA

### 5.1. Omniscience vs perception limitée
* **Sans brouillard (`rules.fogOfWar = false`)** : l'IA est omnisciente (`perceivedState = state`) et n'utilise pas de mémoire de sighting pour filtrer.
* **Avec brouillard** : `perceivedState = applyFogOfWar(state, factionId)`. L'IA ne voit que les flottes détectées selon les règles 2.x et doit s'appuyer sur sa mémoire pour le reste.

### 5.2. Mise à jour des sightings IA
À chaque tour (via `updateMemory`) :
* Les flottes ennemies visibles créent/rafraîchissent un sighting :
  - `systemId` : système le plus proche dans `CAPTURE_RANGE`, sinon `null`.
  - `daySeen` et `lastUpdateDay` : jour courant.
  - `estimatedPower` : calculé via `calculateFleetPower`.
  - `confidence` : `1.0`.
* Les sightings non rafraîchis sont vieillis :
  - **Oubli dur** : suppression si `day - daySeen > sightingForgetAfterTurns` (par défaut 12).
  - **Décroissance de confiance** : `confidence *= (1 - sightingConfidenceDecayPerTurn)^(turnsSinceUpdate)` avec un pas par jour (`sightingConfidenceDecayPerTurn` par défaut 0.1). `lastUpdateDay` est mis à jour lors du calcul.
  - **Plancher** : suppression si `confidence < sightingMinConfidence` (par défaut 0.05).

### 5.3. Exploitation des sightings
* Les systèmes observés mettent à jour `systemLastSeen` et `lastOwnerBySystemId`.
* Lors de l'évaluation stratégique d'un système :
  - **Menace visible** : somme de la puissance des flottes ennemies visibles dans `CAPTURE_RANGE`.
  - **Menace mémorisée** : somme des `estimatedPower * confidence` des sightings liés au système (`systemId`), atténuée par l'âge du brouillard (`fogAge`).
  - Le score final combine valeur du système, biais attaque/défense, distance à l'empire et menaces (visibles + mémoires).

Ces mécanismes permettent à l'IA de réagir aux contacts récents tout en conservant une mémoire dégradée des forces disparues sous le brouillard.
