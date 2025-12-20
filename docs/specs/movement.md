# Spécification Mouvement des Flottes

## Formule de vitesse
- La vitesse d'une flotte est déterminée par le vaisseau le plus lent.
- Calcul (par tour) : `BASE_FLEET_SPEED * min(ship.speed)` sur l'ensemble des vaisseaux présents.
- Si la flotte est vide ou si aucune vitesse n'est trouvée, la valeur par défaut `BASE_FLEET_SPEED` est utilisée.

Référence : `getFleetSpeed(fleet)` dans `services/movement/fleetSpeed.ts`.

## Step de déplacement : `moveFleet`
- Entrées : `fleet`, `systems`, `day`, `rng`.
- Précondition : `fleet.state === MOVING` et `fleet.targetPosition` défini, sinon aucun déplacement.
- Processus :
  - Direction = `targetPosition - position`, distance = norme.
  - `moveDistance = getFleetSpeed(fleet)`.
  - Si la distance à couvrir est **strictement supérieure** à `moveDistance`, la flotte avance d'un vecteur normalisé multiplié par `moveDistance` et reste en état `MOVING`.
  - Sinon, la flotte arrive à destination :
    - Passage en `FleetState.ORBIT`.
    - Position forcée à `targetPosition` (clone du vecteur).
    - `stateStartTurn` mis au jour courant.
    - Drapeaux de mouvement remis à zéro : `targetPosition`, `targetSystemId`, `retreating`, `invasionTargetSystemId`, `loadTargetSystemId`, `unloadTargetSystemId`.
    - Journal d'arrivée ajouté si la cible correspond à un système connu (type `move`).

Référence : `moveFleet` dans `services/movement/movementPhase.ts`.

## Transition ORBIT ↔ MOVING
- **Départ** : la mise en mouvement (hors de ce scope) place la flotte en `FleetState.MOVING` avec une `targetPosition` et, le cas échéant, `targetSystemId`.
- **Arrivée** : `moveFleet` déclenche la bascule vers `FleetState.ORBIT` quand la distance restante est couverte par la vitesse du tour. La position est alignée exactement sur la cible.

## Effets à l'arrivée dans un système
Lorsqu'`arrivalSystemId` est défini à la fin de `moveFleet`, la résolution de tour exécute automatiquement des opérations d'arrivée via `executeArrivalOperations` :

1) **Réinitialisation des ordres spéciaux**
   - Les champs `invasionTargetSystemId`, `loadTargetSystemId`, `unloadTargetSystemId` sont conservés pendant l'appel puis remis à `null` après les opérations.

2) **Logs**
   - Log `move` créé à l'arrivée si le système est identifié : `Fleet <id> (<faction>) arrived at <system>.`
   - Les opérations suivantes peuvent ajouter leurs propres logs (`combat` ou `move`).

3) **Opérations automatiques** (ordre de traitement) :
   - **Auto unload** dans un système allié correspondant à `unloadTargetSystemId`, vers la planète solide par défaut si elle existe ; risques supplémentaires si l'orbite est contestée (`applyContestedUnloadRisk`).
   - **Auto load** d'armées amies si `loadTargetSystemId` correspond au système d'arrivée.
   - **Auto invasion** si `invasionTargetSystemId` correspond au système d'arrivée :
     - Si aucune planète solide n'est disponible, log d'échec.
     - Sinon, tentative de déploiement avec risque d'échec en orbite contestée (`applyContestedDeploymentRisk`).
     - Succès partiel ou total génère un log `combat` indiquant le nombre d'armées déposées et un avertissement si l'orbite est contestée.

Référence : `executeArrivalOperations` et `resolveFleetMovement` dans `services/movement/movementPhase.ts`.
