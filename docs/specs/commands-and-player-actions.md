# Commandes et actions joueur

Cette spécification recense toutes les commandes consommées par le moteur (`GameCommand`) ainsi que les actions joueur hors pipeline de commandes (split/merge). Pour chaque opération, elle détaille les préconditions, les messages d'erreur éventuels et l'impact exact sur l'état du jeu. Toutes les descriptions utilisent les noms de champs de code (en anglais) pour rester alignées avec l'implémentation.

## Rappels généraux

- **Blocages globaux** : une flotte ne peut recevoir aucun ordre si `fleet.state === COMBAT` ou si `fleet.retreating === true`. L’appel retourne alors l’erreur `"Fleet is in combat and cannot receive commands."` ou `"Fleet is retreating and cannot receive commands."` selon le cas.
- **Proximité orbitale** : plusieurs opérations nécessitent que la flotte soit en orbite, c’est-à-dire `fleet.state === ORBIT` **et** `distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ`.
- **Zones contestées** : `isOrbitContested(system, state)` retourne vrai dès qu’au moins deux factions possèdent des vaisseaux dans le rayon de capture. Les déchargements en zone contestée appliquent un risque supplémentaire via `applyContestedUnloadRisk`.

## GameCommand

### MOVE_FLEET
- **Entrée** : `fleetId`, `targetSystemId`, `reason?`, `turn?`.
- **Préconditions/erreurs** : le système cible doit exister ; la flotte doit exister et ne pas être bloquée (combat ou retraite). Les validations échouées annulent le changement d’état sans message additionnel.
- **Effets** : le moteur place la flotte en `MOVING`, définit `targetSystemId`/`targetPosition` sur la position du système, renseigne `stateStartTurn`, et purge les ordres précédents (`invasionTargetSystemId`, `loadTargetSystemId`, `unloadTargetSystemId`).

### ORDER_INVASION_MOVE
- **Entrée** : `fleetId`, `targetSystemId`, `reason?`, `turn?`.
- **Préconditions/erreurs** : identiques à `MOVE_FLEET` (système et flotte doivent exister, flotte non bloquée).
- **Effets** : identiques à `MOVE_FLEET`, mais `invasionTargetSystemId` est fixé au système cible (les autres ordres sont vidés).

### ORDER_LOAD_MOVE
- **Entrée** : `fleetId`, `targetSystemId`, `reason?`, `turn?`.
- **Préconditions/erreurs** : identiques à `MOVE_FLEET`.
- **Effets** : passage en `MOVING`, alignement de la cible, et mémorisation de `loadTargetSystemId` (les autres ordres sont vidés).

### ORDER_UNLOAD_MOVE
- **Entrée** : `fleetId`, `targetSystemId`, `reason?`, `turn?`.
- **Préconditions/erreurs** : identiques à `MOVE_FLEET`.
- **Effets** : passage en `MOVING`, alignement de la cible, et mémorisation de `unloadTargetSystemId` (les autres ordres sont vidés).

### AI_UPDATE_STATE
- **Entrée** : `factionId`, `newState`, `primaryAi?`.
- **Préconditions/erreurs** : aucune validation métier ; la commande est appliquée directement.
- **Effets** : remplace `aiStates[factionId]` par `newState` et, si `primaryAi` est vrai, remplace aussi `aiState`.

### ADD_LOG
- **Entrée** : `text`, `logType` (`info` | `combat` | `move` | `ai`).
- **Préconditions/erreurs** : aucune.
- **Effets** : ajoute un `LogEntry` daté du jour courant avec un identifiant généré.

### LOAD_ARMY
- **Entrée** : `fleetId`, `shipId`, `armyId`, `systemId`, `reason?`.
- **Préconditions/erreurs** :
  - Système, flotte et armée doivent exister.
  - La flotte doit être en orbite du système cible.
  - Le vaisseau ciblé doit appartenir à la flotte, être libre (`carriedArmyId` absent).
  - L’armée doit être `DEPLOYED`, appartenir à la même faction que la flotte et stationner sur une planète solide du même système.
  - En cas de non-respect, la commande est ignorée sans message supplémentaire.
- **Effets** : exécute `computeLoadOps` pour embarquer l’armée sur le vaisseau ciblé, met à jour flotte et armées, et ajoute les logs produits. Aucun effet si aucune opération n’est réalisable.

### UNLOAD_ARMY
- **Entrée** : `fleetId`, `shipId`, `armyId`, `systemId`, `planetId`, `reason?`.
- **Préconditions/erreurs** :
  - Système, flotte, armée et planète doivent exister ; la planète doit être solide et dans le système indiqué.
  - La flotte doit être en orbite du système.
  - Le vaisseau ciblé doit transporter l’armée (`carriedArmyId === armyId`).
  - L’armée doit être `EMBARKED`, contenue dans la flotte et appartenir à la même faction.
  - Toute précondition manquante annule silencieusement la commande.
- **Effets** :
  - Exécute `computeUnloadOps` pour débarquer l’armée sur `planetId` et ajoute les logs associés.
  - Si l’orbite est contestée, applique `applyContestedUnloadRisk`, ce qui peut modifier les armées et ajouter des logs de risque supplémentaires.
  - Met à jour flotte et armées même en cas de risque appliqué.

### TRANSFER_ARMY_PLANET
- **Entrée** : `armyId`, `fromPlanetId`, `toPlanetId`, `systemId`, `reason?`.
- **Préconditions/erreurs** :
  - L’armée doit exister, être `DEPLOYED` et localisée sur `fromPlanetId`.
  - Les planètes source et destination doivent exister, être solides et appartenir au même système que `systemId`.
  - Un transport de la faction de l’armée doit être disponible en orbite : flotte en `ORBIT` dans la portée `ORBIT_PROXIMITY_RANGE_SQ`, vaisseau `TRANSPORTER` libre et non occupé (`transferBusyUntilDay` strictement inférieur au jour courant).
  - Si aucun transport n’est disponible ou si une précondition échoue, la commande est ignorée.
- **Effets** :
  - Marque le vaisseau transporteur comme occupé (`transferBusyUntilDay = state.day`).
  - Déplace l’armée vers `toPlanetId` (champ `containerId`).
  - Ajoute un log de mouvement (texte par défaut ou `reason` personnalisé).

---

## Commandes terrestres (Surface Map)

Ces commandes posent des **ordres** exécutés plus tard par `phaseGround` (débarquement, mouvement, combat). Elles ne déplacent ni ne résolvent de combat immédiatement. Les ordres persistent tant qu’ils restent valides et sont supprimés s’ils deviennent invalides ou après exécution.

### ORDER_GROUND_MOVE
- **Entrée** : `armyId`, `to` (`SurfacePos` avec `bodyId`, `tileId` et éventuels `q/r` legacy).
- **Préconditions/erreurs** :
  - L’armée doit exister.
  - L’armée doit être `ArmyState.DEPLOYED`.
  - `to.bodyId` doit correspondre au `containerId` de l’armée (même body).
  - La tuile ciblée doit être dans les bornes de la surface map et passable.
  - En cas d’échec, la commande retourne une erreur explicite (`Army not found`, `Army is not deployed...`, etc.).
- **Effets** : assigne `army.groundOrders.move = { type:'move', to }`. L’ordre peut coexister avec un ordre d’attaque.

### ORDER_GROUND_ATTACK
- **Entrée** : `attackerId`, `targetArmyId`.
- **Préconditions/erreurs** :
  - Les deux armées doivent exister et être `DEPLOYED`.
  - Elles doivent être sur le même `bodyId`.
  - Le moteur ne valide pas ici la portée/LoS (elle est validée en `phaseGround`), mais peut refuser si `targetArmyId === attackerId`.
- **Effets** : assigne `attacker.groundOrders.attack = { type:'attack', targetArmyId }`.

### ORDER_GROUND_LAND
- **Entrée** : `armyId`, `to` (`SurfacePos` avec `bodyId`, `tileId` et éventuels `q/r` legacy).
- **Préconditions/erreurs** :
  - L’armée doit exister.
  - L’armée doit être `ArmyState.EMBARKED`.
  - La flotte porteuse doit être en orbite du système cible.
  - `to.bodyId` doit désigner un corps solide dans le système cible.
  - La tuile doit être dans les bornes de la surface map.
  - La tuile doit être passable (sauf unités `amphibious`).
  - La tuile ne doit pas être occupée par un ennemi (débarquement interdit sur tuile ennemie).
  - En cas d’échec, la commande retourne une erreur explicite.
- **Effets** : assigne `army.landingOrder = { type:'land', to }` pour exécution lors de la phase de débarquement.

### SET_GROUND_POSTURE
- **Entrée** : `armyId`, `posture` (`'normal'|'prepared_defense'`).
- **Préconditions/erreurs** : l’armée doit exister.
- **Effets** : met à jour `army.posture`.

### CANCEL_GROUND_ORDER
- **Entrée** : `armyId`.
- **Préconditions/erreurs** : l’armée doit exister.
- **Effets** : supprime `army.groundOrders.move` et `army.groundOrders.attack` si présents.

## Actions joueur hors `GameCommand`

Ces actions sont validées côté moteur puis modifient directement l’état sans passer par `applyCommand`.

### SPLIT_FLEET
- **Entrée** : `originalFleetId`, liste `shipIds` à détacher.
- **Préconditions/erreurs** :
  - La flotte doit exister, appartenir au joueur et ne pas être bloquée (combat ou retraite).
  - Au moins un vaisseau sélectionné ; tous les identifiants doivent exister dans la flotte ; on ne peut pas sélectionner tous les vaisseaux. Les erreurs renvoient les messages : `"No ships selected"`, `"Some ships not found in fleet"`, ou `"Cannot split entire fleet"`.
- **Effets** :
  - Crée une nouvelle flotte avec les vaisseaux sélectionnés, conserve position et cibles de l’originale, et réplique les ordres en cours (`invasionTargetSystemId`, `loadTargetSystemId`, `unloadTargetSystemId`).
  - Met à jour la flotte d’origine avec les vaisseaux restants.
  - Transfère les armées embarquées dans les vaisseaux déplacés vers la nouvelle flotte (`containerId`).
  - Ajoute un log `info` et sélectionne la nouvelle flotte.

### MERGE_FLEETS
- **Entrée** : `sourceFleetId` (supprimée après fusion), `targetFleetId` (survit).
- **Préconditions/erreurs** :
  - Les deux flottes doivent exister, être différentes, appartenir au joueur et à la même faction.
  - Aucune ne doit être bloquée (combat ou retraite).
  - Les deux flottes doivent être en `ORBIT` et suffisamment proches (`distSq <= ORBIT_PROXIMITY_RANGE_SQ`).
  - Les violations renvoient des erreurs explicites : `"Fleet not found"`, `"Cannot merge a fleet into itself"`, `"Not your fleet"`, `"Target fleet not controlled by player"`, `"Fleets belong to different factions"`, `"Fleets must be in orbit to merge"`, `"Fleets are too far apart to merge"`.
- **Effets** :
  - Ajoute les vaisseaux de la source à la cible et recalcule les dérivés de flotte.
  - Ré-assigne les armées embarquées de la source vers la flotte cible (`containerId`).
  - Supprime la flotte source, ajoute un log `info`, et sélectionne la flotte cible.
