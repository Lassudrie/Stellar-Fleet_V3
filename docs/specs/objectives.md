# Spécification détaillée des objectifs

Ce document complète la [Specification des scénarios](./scenario-spec.md) en précisant la sémantique et les unités des objectifs évalués par le moteur.

## Types d’objectifs

### Elimination
* **Type:** `elimination`
* **Condition:** Détruire toutes les forces adverses pertinentes (unités, infrastructures ou contrôle territorial selon les règles de l’engine).

### Domination
* **Type:** `domination`
* **Champ:** `percentage` (nombre, requis)
* **Unité:** Pourcentage **0..100** du total des systèmes contrôlables.
* **Condition:** Le scénario est gagné lorsque la faction atteint ou dépasse `percentage` % de contrôle sur les systèmes éligibles, évalué en fin de tour.

### Survival
* **Type:** `survival`
* **Dépendance:** `constraints.maxTurns` (obligatoire dans le scénario).
* **Condition:** La faction doit toujours être en jeu au tour `maxTurns`. Aucun champ `turns` supplémentaire n’est défini côté objectif.

### King of the Hill
* **Type:** `king_of_the_hill`
* **Champs:**
  * `systemId` (string, requis) — identifiant du système cible.
  * `turnsHeld` (integer, optionnel) — nombre de tours consécutifs à tenir.
* **Sémantique:**
  * Si `turnsHeld` est `0` ou omis, la simple possession du système à la fin d’un tour déclenche la victoire.
  * Si `turnsHeld > 0`, la faction doit conserver le contrôle pendant `turnsHeld` tours consécutifs.

## Evaluation
* Les conditions sont évaluées en fin de tour, après application des actions et résolutions de combats.
* Les objectifs sont combinés en **OU** par défaut dans `objectives.win`, sauf mention contraire dans la configuration de scénario.
* Les contraintes globales (ex. `maxTurns`) s’appliquent à tous les objectifs et peuvent déclencher un statut Nul/Défaite même si aucune condition de victoire n’est atteinte.
