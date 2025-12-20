# Spécification des objectifs et conditions de fin de partie

**Version :** 1.0  
**Statut :** Validé  
**Portée :** Moteur, générateur de scénarios, validation de données

---

## 1. Objet
Cette spécification décrit les règles métiers associées aux objectifs d'un scénario *Stellar Fleet*, leur paramétrage, ainsi que les règles de tie-break utilisées lorsque plusieurs conditions s'appliquent simultanément. Elle complète le contrat de `objectives` défini dans le schéma de scénario (`docs/specs/scenario-spec.md`) et reste strictement compatible avec celui-ci.

---

## 2. Modèle de données compatible avec le schéma de scénario
Dans le schéma de scénario, la section `objectives` contient :

```json
{
  "objectives": {
    "victory": [
      { "type": "elimination" },
      { "type": "domination", "percentage": 0.75 },
      { "type": "king_of_the_hill", "systemId": "alpha", "turnsHeld": 5 },
      { "type": "survival", "turns": 50 }
    ],
    "constraints": {
      "maxTurns": 200
    }
  }
}
```

* `victory` est un tableau de conditions évaluées en **OU** (la première atteinte déclenche la fin de partie), conformément à `ScenarioDefinition.objectives.victory`.
* `constraints.maxTurns` se mappe à `ScenarioDefinition.objectives.constraints.maxTurns` et fixe une borne dure de tours.
* Les champs optionnels non requis par un type **ne doivent pas** apparaître pour éviter toute ambiguïté de validation.

---

## 3. Conditions de victoire

### 3.1 Élimination (`type: "elimination"`)
* **Condition** : la faction contrôlée détruit toutes les flottes **et** ne laisse aucun système contrôlé par les factions adverses. Une destruction des flottes sans capture des derniers systèmes ne suffit pas.
* **Sources de données** :
  * Flottes actives (`Fleet` encore présentes sur la carte).
  * Possession des systèmes (`System.ownerFactionId`).
* **Évaluation** : réussie si `count(fleets ennemies) == 0` **et** `count(systèmes ennemis) == 0`.
* **Compatibilité schéma** : aucun paramètre supplémentaire ; ne déclare que `{"type": "elimination"}`.

### 3.2 Domination (`type: "domination"`)
* **Paramètre requis** : `percentage` (`0 < percentage <= 1`).
* **Condition** : la faction possède au moins `percentage` des systèmes générés (arrondi selon la règle mathématique standard : seuil = `ceil(systemCount * percentage)`).
* **Évaluation** : recalculée à chaque fin de tour sur l'état courant des propriétaires de systèmes.
* **Compatibilité schéma** : `percentage` est un nombre décimal cohérent avec le schéma du scénario (`number`).

### 3.3 Roi de la Colline (`type: "king_of_the_hill"`)
* **Paramètres requis** :
  * `systemId` : identifiant stable d'un système existant dans la carte (nécessite un support de génération déterministe ou d'IDs injectés).
  * `turnsHeld` : nombre de tours consécutifs à maintenir la possession.
* **Choix de règle (DEC-001)** :
  * **DEC-001** prescrit que la variante `roi unique` est utilisée : seul le contrôle intégral du système compte, la présence orbitale contestée bloque la progression du compteur de tours.
  * Si un autre mode devait être supporté (ex. compteur partagé), il nécessiterait une nouvelle décision et un champ supplémentaire, non couvert par cette version.
* **Évaluation** :
  1. Vérifier que `System.ownerFactionId` correspond à la faction du joueur.
  2. Vérifier qu'aucune orbite contestée n'existe sur `systemId` (doit être propre).
  3. Incrémenter un compteur interne ; si le contrôle est perdu ou contesté, réinitialiser à 0.
  4. Victoire lorsque `turnsHeld` est atteint.
* **Compatibilité schéma** : `systemId` (`string`) et `turnsHeld` (`integer`) sont conformes aux types décrits dans le schéma de scénario.

### 3.4 Survie (`type: "survival"`)
* **Paramètre requis** : `turns` (`integer > 0`).
* **Condition** : la faction contrôlée est encore vivante (au moins une flotte ou un système) au tour `turns` inclus.
* **Interaction avec `maxTurns`** : si `constraints.maxTurns` est défini, il doit être **>=** `turns` pour éviter une victoire automatique par dépassement de limite globale ; sinon, atteindre `maxTurns` sans remplir `turns` conduit au tie-break.
* **Compatibilité schéma** : `turns` se mappe à `objectives.victory[].turns` tel que défini dans la spécification de scénario.

---

## 4. Contraintes globales

### 4.1 Limite de tours (`constraints.maxTurns`)
* **Comportement** : au dépassement de `maxTurns`, la partie est arrêtée et passe en tie-break si aucune condition de victoire n'est déjà satisfaite.
* **Validation** :
  * `maxTurns` doit être un entier strictement positif.
  * Si `survival` est présent, `maxTurns >= survival.turns` est conseillé pour éviter une partie non gagnable, mais non imposé pour conserver la compatibilité ascendante du schéma.

---

## 5. Tie-break et ordre de résolution

### 5.1 Priorité d'évaluation
1. Évaluer toutes les conditions de `victory` dans l'ordre de déclaration. La première condition satisfaite déclenche immédiatement la victoire.
2. Si aucune victoire n'est atteinte et que `maxTurns` est dépassé, appliquer le tie-break.

### 5.2 Règles de tie-break
* **Score de contrôle** : comparer le nombre de systèmes possédés. Le plus haut l'emporte.
* **Score de puissance** (si égalité sur le contrôle) : comparer la puissance totale des flottes (HP agrégés ou métrique interne équivalente).
* **Égalité restante** : si les scores restent strictement égaux, déclarer un **match nul**.
* **Implémentation** : ces règles sont déterministes et ne dépendent pas de l'ordre de résolution des combats ; elles doivent être exécutées après toutes les mises à jour de fin de tour.

---

## 6. Compatibilité et validation
* La structure décrite reste alignée avec la section `objectives` du schéma de scénario existant ; aucun champ supplémentaire requis n'est introduit.
* Les moteurs de validation doivent :
  * Rejeter toute condition `victory` ne correspondant pas à l'un des quatre types listés.
  * Vérifier la présence des paramètres obligatoires (`percentage`, `systemId`, `turnsHeld`, `turns`) lorsque requis.
  * Garantir que `systemId` référencé par `king_of_the_hill` existe dans le contenu généré ou statique du scénario.
  * Vérifier que `percentage` est dans l'intervalle **]0,1]**.
  * Rejeter les valeurs non entières pour `turns`, `turnsHeld` et `maxTurns`.
* Les moteurs consommant des scénarios plus anciens demeurent compatibles car aucun champ requis n'est ajouté à la racine du schéma.

---

## 7. Points de vigilance
* **Conflit entre `elimination` et `domination`** : l'élimination prévaut si elle est atteinte en premier, mais la domination peut conclure la partie même en présence de flottes ennemies si la condition de pourcentage est remplie et évaluée avant `elimination` dans la liste.
* **Roi de la colline et combats orbitaux** : une orbite contestée remet le compteur de `turnsHeld` à zéro (DEC-001). Les combats terrestres sans contestation orbitale ne bloquent pas le compteur.
* **Survie avec limites courtes** : un `survival.turns` supérieur à `maxTurns` rend l'objectif inatteignable ; l'éditeur de scénario doit être explicite sur cette incohérence.
* **Tie-break et lectures externes** : les règles de tie-break sont indépendantes des paramètres des objectifs ; elles doivent rester stables pour assurer la reproductibilité des replays et des sauvegardes.
