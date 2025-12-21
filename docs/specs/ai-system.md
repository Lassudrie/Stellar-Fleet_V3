# Spécification du système d'IA

**Version :** 1.0  
**Statut :** Brouillon

---

## 1. Périmètre et objectifs
Ce document décrit le comportement décisionnel de l’IA de Stellar Fleet tel qu’implémenté dans `engine/ai.ts`. L’IA planifie chaque tour pour les factions déclarées comme automatisées, en évaluant les systèmes stellaires, en générant des tâches (défense, attaque, invasion, reconnaissance, maintien de position) puis en produisant des ordres déterministes pour les flottes et armées.

## 2. Entrées, mémoire et règles
- **État de jeu (`GameState`)** : systèmes, flottes, armées, factions, règles de partie (`rules`) et jour courant (`day`). Les limitations de visibilité sont appliquées via le brouillard de guerre (`rules.fogOfWar`) avec une observation calculée par `applyFogOfWar` et `getObservedSystemIds`.【F:engine/ai.ts†L26-L115】
- **Mémoire IA persistante (`AIState`)** : détections ennemies (`sightings` avec confiance et puissance estimée), dernières observations par système (`systemLastSeen`), dernier propriétaire connu, inertie de cible (`targetPriorities`) et dates de maintien (`holdUntilTurnBySystemId`). Les données expirent ou se dégradent selon la confiance et l’ancienneté de la détection.【F:engine/ai.ts†L60-L170】
- **Règles et constantes** : portée de capture (`CAPTURE_RANGE`), proximité orbitale, bonus d’inertie, durée minimale d’engagement et durée de “hold”. Les dates de maintien sont inclusives (le maintien reste actif tant que `day <= holdUntil`).【F:engine/ai.ts†L85-L136】【F:engine/ai.ts†L113-L135】
- **Objectifs implicites** : défendre les systèmes menacés, étendre le territoire vers les systèmes de haute valeur, préparer et exécuter des invasions, explorer les zones sous brouillard et conserver des regroupements défensifs autour des cibles difficiles.

## 3. Profils et heuristiques
Trois profils sont disponibles, chacun dérivant d’un socle commun (`BASE_AI_CONFIG`) :
- **Balanced (par défaut)** : ratios neutres d’attaque/défense, probabilité de reconnaissance à 0,10 et pondérations de tâches uniformes.【F:engine/ai.ts†L32-L70】
- **Aggressive** : biais défensif réduit, ratio d’attaque abaissé, probabilité de reconnaissance accrue et priorité légèrement supérieure pour l’attaque et l’exploration.【F:engine/ai.ts†L71-L85】
- **Defensive** : biais défensif renforcé, ratio d’attaque majoré (pour sur-engager), probabilité de reconnaissance réduite et priorité accrue pour la défense.【F:engine/ai.ts†L86-L97】

Paramètres clés par profil :  
- `defendBias` / `attackRatio` : amplifient le score des systèmes amis/ennemis et la puissance exigée pour intervenir.  
- `minMoveCommitTurns` / `inertiaBonus` : verrouillent temporairement les flottes déjà en route et favorisent la continuité vers la même cible.  
- `scoutProb` : probabilité par tour d’ajouter une mission de reconnaissance aléatoire (pondérée par l’âge du brouillard).  
- `targetInertiaDecay` / `targetInertiaMin` : mémorisent la priorité d’une cible d’un tour à l’autre.  
- `holdTurns` : durée standard d’un ordre de maintien.  
- `sightingForgetAfterTurns`, `sightingConfidenceDecayPerTurn`, `sightingMinConfidence` : gestion de la confiance dans les sightings pour estimer des menaces persistantes.

## 4. Évaluation des systèmes
Chaque système reçoit un score combinant valeur stratégique, menace et contexte de brouillard :
- **Valeur intrinsèque** : base 10, +50 si ressource, +20 si déjà contrôlé, +150 si monde natal.【F:engine/ai.ts†L185-L213】
- **Distance et frontière** : distance minimale depuis les flottes amies (servant de portée d’intervention) et facteur de frontière (biais pro-expansion selon l’éloignement et l’âge du brouillard).【F:engine/ai.ts†L196-L217】
- **Menace** : somme de la puissance ennemie visible dans la portée de capture + menace mémorisée pondérée par la confiance résiduelle et un facteur d’obsolescence lié au brouillard.【F:engine/ai.ts†L201-L215】
- **Décision de cible** : un système ami avec menace ou un système neutre/ennemi de valeur > 20 est considéré comme candidat, avec un score final appliquant le biais d’expansion/défense moins la menace évaluée. Des logs détaillés sont produits si le débogueur IA est actif.【F:engine/ai.ts†L208-L236】

## 5. Génération des tâches
Les tâches sont priorisées (priority + distance + inertie) puis triées avant affectation :
- **Types** : `DEFEND`, `ATTACK`, `INVADE`, `HOLD`, `SCOUT`.  
- **Maintiens actifs** : les systèmes sous ordre de “hold” actif génèrent une tâche `HOLD` prioritaire avec puissance minimale et facteur d’obsolescence du brouillard.【F:engine/ai.ts†L260-L284】
- **Défense** : toute menace sur un système possédé crée une tâche `DEFEND` proportionnelle à la menace et au biais défensif.【F:engine/ai.ts†L286-L302】
- **Attaque / Invasion** : un système de valeur > 20 et à menace gérable génère `ATTACK`. La présence d’armées embarquées sur des flottes amies convertit la tâche en `INVADE` et augmente sa priorité. Les exigences de puissance intègrent `attackRatio`.【F:engine/ai.ts†L303-L339】
- **Cibles trop défendues** : si la menace dépasse 80 % de la puissance totale de la faction, l’IA crée un `HOLD` sur le système ami le plus proche pour regrouper, puis un `SCOUT` vers la cible pour sonder.【F:engine/ai.ts†L340-L370】
- **Reconnaissance proactive** : à chaque tour, un tirage `rng.next() < scoutProb` ajoute une mission `SCOUT` vers le système le plus anciennement dans le brouillard (avec tiebreak sur la valeur).【F:engine/ai.ts†L372-L404】
- **Tri** : priorité décroissante, puis distance croissante, puis type, puis identifiant système pour garantir l’ordre déterministe des tâches.【F:engine/ai.ts†L405-L421】

## 6. Attribution des flottes et décisions de mouvement
- **Filtrage** : les flottes déjà en mouvement vers une autre cible depuis moins de `minMoveCommitTurns` ne peuvent être détournées (sauf pour défendre).【F:engine/ai.ts†L431-L460】
- **Score de convenance** : basé sur la distance au système, la puissance de flotte, un bonus d’inertie si déjà en route vers la cible, un malus pour les gros groupes en reconnaissance, et un bonus massif si des transports contiennent des armées pour les tâches `INVADE`.【F:engine/ai.ts†L461-L507】
- **Seuils d’assignation** : une tâche est validée si la puissance cumulée atteint `requiredPower`, ou 70 % pour les assauts (`ATTACK`/`INVADE`), ou tout apport pour les tâches flexibles (`DEFEND`/`HOLD`). Sinon, les flottes sélectionnées sont redirigées vers un `HOLD` de regroupement sur le système allié le plus proche.【F:engine/ai.ts†L509-L557】
- **Journalisation** : chaque évaluation et tâche assignée/alphabetisée est loggée quand le débogueur IA est activé, assurant une traçabilité complète.【F:engine/ai.ts†L523-L560】

## 7. Invasion, transport d’armées et ordres finaux
- **Planification d’embarquement** : pour les tâches d’assaut, l’IA cherche des transports libres, réserve les armées disponibles proches et insère un ordre `ORDER_LOAD_MOVE`. Si une flotte transporte déjà des armées, une tâche `ATTACK` est promue en `INVADE`.【F:engine/ai.ts†L579-L655】
- **Ordres de mouvement** :  
  - `ORDER_INVASION_MOVE` pour les tâches `INVADE`, ou `MOVE_FLEET` pour les autres, en conservant le cap si déjà en transit.  
  - À l’arrivée en orbite de la cible d’invasion, `UNLOAD_ARMY` est émis pour chaque armée embarquée vers la planète par défaut du système.【F:engine/ai.ts†L663-L734】
- **Mise à jour de l’inertie** : `targetPriorities` décroitent chaque tour et sont rafraîchies par les tâches assignées au-dessus d’un seuil minimal.【F:engine/ai.ts†L736-L758】
- **Synchronisation d’état** : un ordre `AI_UPDATE_STATE` persiste la mémoire mise à jour (priorités, sightings, hold actifs). Les transferts intra-système déplacent une armée amie depuis une planète sûre vers une planète contestée si des transports orbitent et des cibles hostiles sont présentes.【F:engine/ai.ts†L760-L821】

## 8. Contraintes de déterminisme
- **RNG injecté** : toute variabilité aléatoire (mission de reconnaissance opportuniste) utilise l’instance `rng` passée à `planAiTurn`, garantissant la reproductibilité avec la même seed et le même ordre d’appels.【F:engine/ai.ts†L372-L387】
- **Tri explicite** : les tâches et les flottes sont triées avec des critères fixes (priorité, distance, identifiants) afin que les décisions soient stables à entrée et seed identiques.【F:engine/ai.ts†L405-L421】【F:engine/ai.ts†L481-L503】
- **Décroissance déterministe** : la confiance des sightings, l’obsolescence des priorités et l’expiration des holds suivent des formules sans hasard, dépendant uniquement de `day` et des paramètres du profil.【F:engine/ai.ts†L103-L151】【F:engine/ai.ts†L736-L759】
- **Persistences explicites** : l’ordre `AI_UPDATE_STATE` en fin de tour conserve les données nécessaires au prochain cycle, évitant les dérives non contrôlées. Les prises de décision s’appuient uniquement sur l’état perçu (brouillard appliqué) et la mémoire persistée pour garantir la cohérence entre tours.【F:engine/ai.ts†L736-L784】
