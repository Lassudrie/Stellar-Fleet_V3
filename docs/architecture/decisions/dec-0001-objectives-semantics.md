# DEC-0001 — Sémantique des objectifs

## Contexte
La spécification des scénarios définit plusieurs conditions de victoire (domination, king_of_the_hill, survival) mais leur sémantique n’était pas homogène :

* La valeur de **domination** était exprimée tantôt en ratio (0..1), tantôt en pourcentage.
* **King of the hill** ne précisait pas la différence entre la possession instantanée et la tenue d’un objectif pendant plusieurs tours.
* **Survival** utilisait un champ `turns` spécifique alors que la limite de tour globale (`maxTurns`) était déjà présente dans les contraintes.

## Décision
1. **Domination** utilise désormais une valeur en **pourcentage dans [0 ; 100]**, permettant une lecture directe côté scénario et UI.
2. **King of the hill** supporte deux usages explicites :
   * **Possession actuelle** : si `turnsHeld` est omis ou `0`, la victoire est déclenchée dès que le système cible est contrôlé à la fin du tour.
   * **Hold** : si `turnsHeld > 0`, le joueur doit conserver le contrôle pendant ce nombre de tours consécutifs.
3. **Survival** s’appuie sur la contrainte globale `constraints.maxTurns` comme horizon de survie : la victoire est acquise si la faction est toujours en jeu au tour `maxTurns`. Aucun champ `turns` dédié n’est attendu dans l’objectif.

## Conséquences techniques
* Les scénarios doivent renseigner **domination** avec un entier ou un flottant compris entre 0 et 100.
* Les consommateurs du contrat doivent gérer explicitement les deux modes de **king_of_the_hill** (immédiat ou temporisé) via `turnsHeld`.
* Les objectifs de type **survival** doivent valider la présence de `constraints.maxTurns` et ne plus définir de durée redondante côté objectif.

## Adoption et migration
* Mettre à jour la documentation des scénarios et des objectifs pour refléter ces unités.
* Prévoir une migration pour les scénarios existants utilisant `domination` en ratio (conversion `ratio * 100`) ou `survival.turns` (déplacer la valeur vers `constraints.maxTurns`).
