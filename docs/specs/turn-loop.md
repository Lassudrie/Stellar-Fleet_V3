# Spécification Technique : Boucle de Tour

**Responsable :** Engine Team

---

## 1. Principe général

`runTurn` applique une pipeline déterministe sur l’état courant pour produire l’état du tour suivant (`day + 1`). Chaque phase consomme l’état en entrée et peut muter des sous-ensembles (flottes, armées, systèmes, batailles, logs, messages, IA). Les phases sont strictement séquentielles : aucune phase ultérieure ne peut s’exécuter partiellement ou en parallèle.

**Règles globales d’ordre et de logs**

- **Canonicalisation** : avant toute phase et juste avant l’incrément du jour, `canonicalizeState` trie `systems`, `fleets` (et leurs `ships`), `armies`, `battles`, `logs` et `messages` par ID (ou jour puis ID pour les journaux/messages). Cela garantit un ordre d’itération stable pour la consommation du RNG et la comparaison d’états.
- **Tri intra‑phase** : certaines phases imposent un tri supplémentaire pour stabiliser le RNG ou les effets :
  - **AI** : les factions IA sont parcourues par `id` croissant avant d’appeler `planAiTurn` puis `applyCommand`.
  - **Mouvement** : les flottes sont déplacées dans l’ordre lexicographique de `fleet.id` puis leurs opérations d’arrivée sont évaluées sur les positions finales.
  - **Résolution de bataille** : les batailles `scheduled` sont triées par `systemId` puis `battle.id` avant résolution.
- **Logs** : chaque phase ajoute ses entrées avec `day = ctx.turn` et un `id` RNG, puis la canonicalisation finale réordonne par jour/ID si nécessaire.
- **Messages** : les messages sont fusionnés puis `canonicalizeMessages` applique le tri jour/ID dès la génération.

## 2. Phases détaillées (entrées → sorties, invariants)

### 2.1. Phase AI (`phaseAI`)

- **Entrée** : état canonicalisé, `ctx.turn` (jour cible) et `ctx.rng` partagé.
- **Traitement** :
  - Ignore la phase si `rules.aiEnabled` est faux.
  - Trie les factions disposant d’un profil IA par `id` et garantit un `AIState` pour chacune (compatibilité avec `aiState` legacy).
  - Pour chaque faction : `planAiTurn` génère des commandes appliquées immédiatement via `applyCommand` dans l’ordre reçu.
- **Sortie** : état mis à jour (flottes, armées, ordres consommés, logs éventuels émis par les commandes) et `aiStates` fusionné.
- **Invariants** : l’IA ne modifie pas `day`; les commandes sont appliquées sur un état déjà trié, assurant une consommation RNG stable.

### 2.2. Phase Mouvement (`phaseMovement`)

- **Entrée** : état issu de l’AI, `ctx.turn` pour dater les positions cibles.
- **Traitement** :
  - Trie les flottes par `id` pour déplacer chacune via `moveFleet`, accumulant leurs positions finales et logs.
  - Exécute ensuite `executeArrivalOperations` pour chaque résultat (chargement/débarquement/invasion) sur les positions déjà mises à jour.
- **Sortie** : flottes avec positions/états mis à jour, armées modifiées par les opérations d’arrivée, logs additionnés.
- **Invariants** : aucune opération d’arrivée n’est traitée tant que toutes les positions finales ne sont pas connues; les cibles d’invasion/chargement/déchargement sont nullifiées après exécution.

### 2.3. Phase Détection des batailles (`phaseBattleDetection`)

- **Entrée** : état après mouvement, `ctx.turn`.
- **Traitement** :
  - Court‑circuite si `rules.useAdvancedCombat` est faux.
  - `detectNewBattles` crée des batailles `scheduled` selon la co‑présence de flottes opposées.
  - Les flottes impliquées sont verrouillées (`FleetState.COMBAT`) et leurs cibles de mouvement/chargement sont vidées.
- **Sortie** : mêmes entités plus les nouvelles batailles ajoutées; flottes engagées marquées combat.
- **Invariants** : aucune nouvelle bataille n’est ajoutée dans un système déjà en combat actif (`scheduled`/`resolving`), selon `detectNewBattles`.

### 2.4. Phase Résolution des batailles (`phaseBattleResolution`)

- **Entrée** : état avec batailles `scheduled` potentielles.
- **Traitement** :
  - Trie les batailles `scheduled` par `systemId` puis `battle.id` et les résout via `resolveBattle`.
  - Pour chaque résultat : met à jour l’entrée `Battle`, remplace les flottes engagées par les survivants, ajoute un log global de fin de combat et un `GameMessage` synthétique (pertes, munitions).
- **Sortie** : batailles marquées `resolved` avec `turnResolved`, flottes nettoyées/ajoutées, logs/messages enrichis.
- **Invariants** :
  - Toutes les batailles `scheduled` doivent ressortir résolues. Si des `scheduled` persistent après la phase (ou par erreur en aval), un garde‑fou force la résolution en « draw » avant le cleanup.
  - Les résultats de RNG sont isolés par bataille (seed propre dans `resolveBattle`).

### 2.5. Phase Bombardement orbital (`phaseOrbitalBombardment`)

- **Entrée** : état après résolution spatiale.
- **Traitement** :
  - `resolveOrbitalBombardment` applique des pertes/morale aux armées déployées selon la présence orbitale et retourne des logs textuels.
- **Sortie** : armées patchées (force/morale), logs combat ajoutés si l’action a eu lieu.
- **Invariants** : pas d’effet si aucun bombardement; aucune suppression d’armée directe, seulement des mises à jour de stats.

### 2.6. Phase Combat terrestre & conquête (`phaseGround`)

- **Entrée** : état après bombardement, incluant positions orbitale/sol.
- **Traitement** :
  - Résout `resolveGroundConflict` planète par planète solide, accumule pertes, destructions et changement de propriétaire.
  - Met à jour/élimine les armées, recalcul les propriétaires de planètes puis de systèmes (bloqués si orbite contestée via `isOrbitContested`).
  - Génère logs combat et messages `PLANET_CONQUERED` (lignes pertes/restes) ordonnés via `canonicalizeMessages`.
  - Met à jour `aiStates` pour pousser les factions IA victorieuses à tenir les systèmes capturés (`holdUntilTurnBySystemId`).
- **Sortie** : systèmes recolorés et réassignés, armées filtrées/ajustées, logs/messages enrichis, IA mise à jour.
- **Invariants** : une planète n’est capturée que si un seul camp reste au sol ET que l’orbite n’est pas contestée; les mises à jour de force/morale sont appliquées avant suppression des armées sous seuil.

### 2.7. Phase Objectifs (`phaseObjectives`)

- **Entrée** : état courant, `ctx.turn` pour la datation du check.
- **Traitement** :
  - Court‑circuit si `winnerFactionId` est déjà défini.
  - `checkVictoryConditions` évalue les conditions (avec `day` forcé à `ctx.turn`).
- **Sortie** : éventuellement `winnerFactionId` fixé; sinon état inchangé.
- **Invariants** : aucune modification d’autre entité; un gagnant figé n’est jamais écrasé par la suite.

### 2.8. Phase Cleanup (`phaseCleanup`)

- **Entrée** : état post‑objectifs (et post garde‑fou de batailles).
- **Traitement** :
  - `pruneBattles` purge les rapports trop anciens (retention 5 tours).
  - `sanitizeArmies` retire/recorrige les références d’armées orphelines, produisant des logs système.
  - Tronque `logs` à 2000 entrées max, en conservant les plus récentes.
- **Sortie** : état prêt à être canonicalisé puis à incrémenter `day`.
- **Invariants** : aucune bataille `scheduled` ne subsiste; les logs système ajoutés sont préfixés `[SYSTEM]`.

## 3. Canonicalisation finale et incrément du temps

Après le cleanup, l’état est de nouveau passé par `canonicalizeState` pour figer l’ordre des collections avec les mutations finales. Enfin, `day` est fixé à `ctx.turn` et renvoyé au moteur. Toute consommation du RNG pendant ce tour a été réalisée dans un ordre déterminé par :

1) la canonicalisation d’entrée ; 2) les tris intra‑phases ci‑dessus ; 3) la canonicalisation de sortie des logs/messages. Cela garantit la reproductibilité des tours sur la même `seed` et le même set d’ordres.
