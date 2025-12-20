# Spécification Technique : Orbital Bombardment V1

**Feature Flag :** `ENABLE_ORBITAL_BOMBARDMENT`  
**Responsable :** Engine Team

---

## 1. Objectif
Définir les règles de bombardement orbital pour les batailles surface/orbite afin de modéliser les pertes, l'impact moral et la résolution multi-factions dans un cadre déterministe compatible relecture.

## 2. Déclencheurs et conditions
1. **Activation** : un bombardement est planifié lorsqu'une flotte disposant d'armes orbitales est en orbite d'un système contenant une force de surface ennemie (armée ou base planétaire) et que son statut est `ORBITAL_CONTROLLED`.
2. **Orbite contestée** : si l'orbite est marquée `CONTESTED` (flottes ennemies présentes sans supériorité nette), le bombardement est mis en **queue** avec le statut `blocked`, sans résolution tant que la contestation persiste.
3. **Cibles valides** : seules les unités surface avec `canBeBombarded = true` sont éligibles. Les structures avec le tag `HARDENED` appliquent leurs propres réductions (cf. §4).
4. **Coût d'ordre** : un ordre de bombardement consomme un slot d'action de flotte. Si la flotte n'a plus d'actions, la planification est ignorée.

## 3. Cycle de résolution
1. **Planification** : au début du tour, chaque flotte en orbite planifie un événement `OrbitalStrike` par cible éligible (ou groupé par faction selon `STRIKE_GROUPING = byFaction`).
2. **Vérification d'orbite** : si le statut d'orbite est `ORBITAL_CONTROLLED`, l'événement passe à `resolving`. Si `CONTESTED`, il reste `blocked` et sera réévalué au tour suivant.
3. **Jet de bombardement** : pour chaque cible, calcul d'un score d'impact (`impactScore`) qui alimente les pertes matérielles et morales (cf. §4).
4. **Application** : les pertes sont appliquées aux pools surface, puis les caps sont évalués (cf. §5).
5. **Log** : un `BombardmentLog` est généré et attaché à la cible et à la flotte exécutante (cf. §8).

## 4. Calcul des pertes
### 4.1. Score d'impact
```
impactScore = orbitalFirepower * accuracy * (1 - groundEvasion) * atmosphereModifier
```
* `orbitalFirepower` : somme des valeurs `orbitalDamage` des vaisseaux participants.
* `accuracy` : moyenne pondérée par classe des multiplicateurs de précision (Destroyer > Cruiser > Carrier).
* `groundEvasion` : stat agrégée de la cible (terrain, camouflage, bunkers).
* `atmosphereModifier` : réduit l'efficacité sur planètes à atmosphère dense (par défaut `0.85`).

### 4.2. Pertes matérielles (strength)
```
strengthLoss = clamp(
  impactScore * (1 - hardenedReduction) * (1 - coverBonus),
  MIN_STRENGTH_LOSS,
  MAX_STRENGTH_LOSS
)
```
* `hardenedReduction` : 0.35 par défaut pour les structures `HARDENED`, sinon 0.
* `coverBonus` : réduit les dégâts selon le terrain (`0.1` plaine, `0.25` montagne).
* `MIN_STRENGTH_LOSS` : 1% du pool de strength de la cible, `MAX_STRENGTH_LOSS` : 30% par tour.

### 4.3. Pertes morales (morale)
```
moraleLoss = clamp(
  impactScore * moraleSensitivity,
  MIN_MORALE_LOSS,
  MAX_MORALE_LOSS
)
```
* `moraleSensitivity` : coefficient par type d'unité (`Infantry = 1.0`, `Armor = 0.7`, `Fortification = 0.5`).
* `MIN_MORALE_LOSS` : 5 points, `MAX_MORALE_LOSS` : 25 points par tour.
* Si `strengthLoss` atteint `MAX_STRENGTH_LOSS`, appliquer un `panicDebuff = -10 morale` additionnel.

### 4.4. Échec ou dissipation
* Si `impactScore < IMPACT_THRESHOLD` (par défaut 0.05), aucune perte n'est appliquée mais un log "inefficace" est produit.
* Les pertes sont arrondies au supérieur pour éviter les zéros silencieux.

## 5. Caps, limites et sécurité
1. **Cap global par cible** : pas plus de `MAX_STRIKES_PER_TARGET = 2` bombardements appliqués par tour et par cible, tous attaquants confondus. Les événements supplémentaires restent en statut `queued`.
2. **Cap côté flotte** : une flotte ne peut résoudre qu'un seul `OrbitalStrike` par tour si son statut `weaponCooldown` est actif.
3. **Dégâts résiduels** : aucune perte ne peut réduire `strength` sous 1 ni `morale` sous 0. Les valeurs sont clampées après application.
4. **Propagation multi-cibles** : si `impactScore` dépasse `OVERKILL_THRESHOLD`, l'excédent n'est pas redistribué : il est perdu pour préserver la lisibilité et éviter les divergences.

## 6. Interactions multi-factions
1. **Alliés/Neutralité** : seuls les ennemis déclarés (relation `Hostile`) peuvent être bombardés. Les cibles neutres ou alliées sont ignorées même si présentes.
2. **Feu ami** : si une flotte alliée partage l'orbite avec le tireur, elle est exclue du groupement de cibles pour empêcher l'auto-sélection.
3. **Files concurrentes** : si plusieurs factions hostiles bombardent la même cible, les événements sont triés par `initiative` (tirée du commandant de flotte) puis par `fleetId` pour le déterminisme.
4. **Rétorsion** : un bombardement appliqué rend automatiquement la cible et ses alliés adjacents `Hostile` envers le tireur s'ils étaient `Neutral`.

## 7. Gestion d'une orbite contestée
1. Tant que le statut `CONTESTED` persiste, aucun tir n'est résolu et les événements restent en `blocked`.
2. Si l'orbite devient `ORBITAL_CONTROLLED` durant le même tour (ex : après un combat spatial), les événements `blocked` sont re-évalués immédiatement après la résolution spatiale.
3. Si l'orbite passe à `LOST`, tous les événements `blocked` ou `queued` sont annulés et loggés avec le motif `orbit_lost`.

## 8. Journalisation
Chaque résolution (ou annulation) crée un `BombardmentLog` persistant 5 tours :
* `turn`, `systemId`, `attackerFleetId`, `defenderFactionId`.
* `impactScore`, `strengthLoss`, `moraleLoss`, `panicDebuffApplied`.
* `status` : `resolved`, `blocked`, `queued`, `cancelled`.
* `orbitState` observé au moment du log (`ORBITAL_CONTROLLED`, `CONTESTED`, `LOST`).
* Résumé texte localisable : `"Bombardement orbital : pertes {strengthLoss}% / morale -{moraleLoss}"`.

## 9. Données et équilibrage
* **Constantes** : `IMPACT_THRESHOLD`, `MAX_STRIKES_PER_TARGET`, `MIN/MAX_STRENGTH_LOSS`, `MIN/MAX_MORALE_LOSS`, `OVERKILL_THRESHOLD`.
* **Sources** : les stats navales proviennent de `SHIP_STATS`, les stats surface et morale de `GROUND_UNIT_STATS`.
* **Synchronisation** : toute modification d'une constante doit être répercutée dans les tests du moteur (`engine/tests/`) pour maintenir le déterminisme.
