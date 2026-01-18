# Spécification des objectifs et conditions de fin de partie

**Version :** 2.0  
**Statut :** Validé  
**Portée :** Moteur, générateur de scénarios, validation de données

---

## 1. Objet
Cette spécification décrit les règles métiers associées aux objectifs d'un scénario *Stellar Fleet*, leur paramétrage, ainsi que les règles de tie-break utilisées lorsque plusieurs conditions s'appliquent simultanément. Elle complète le contrat `objectives` défini dans le schéma de scénario (`docs/specs/scenario-spec.md`) et reste strictement compatible avec celui-ci.

---

## 2. Modèle de données compatible avec le schéma de scénario
Dans le schéma de scénario, la section `objectives` contient :

```json
{
  "objectives": {
    "win": [
      { "type": "elimination" },
      { "type": "domination", "value": 60 },
      { "type": "king_of_the_hill", "value": "alpha" },
      { "type": "survival" }
    ],
    "maxTimeMs": 7200000
  }
}
```

* `win` est un tableau de conditions évaluées en **OU** (la première atteinte déclenche la fin de partie), conformément à `ScenarioDefinition.objectives.win`.
* `maxTimeMs` fixe une borne dure en millisecondes pour les parties avec contrainte de durée.
* Les champs optionnels non requis par un type **ne doivent pas** apparaître pour éviter toute ambiguïté de validation.

---

## 3. Conditions de victoire

### 3.1 Élimination (`type: "elimination"`)
* **Condition** : la faction contrôlée détruit toutes les flottes **et** ne laisse aucun système contrôlé par les factions adverses.
* **Sources de données** :
  * Flottes actives (`Fleet` encore présentes sur la carte).
  * Possession des systèmes (`System.ownerFactionId`).
* **Évaluation** : réussie si `count(fleets ennemies) == 0` **et** `count(systèmes ennemis) == 0`.
* **Compatibilité schéma** : aucun paramètre supplémentaire ; ne déclare que `{"type": "elimination"}`.

### 3.2 Domination (`type: "domination"`)
* **Paramètre requis** : `value` (`0 < value <= 100`) exprimé en pourcentage de systèmes.
* **Condition** : la faction possède au moins `value`% des systèmes générés.
* **Évaluation** : recalculée à chaque tick stratégique sur l'état courant des propriétaires de systèmes.
* **Compatibilité schéma** : `value` est un nombre décimal conforme au schéma (`number`).

### 3.3 Roi de la colline (`type: "king_of_the_hill"`)
* **Paramètre requis** : `value` = identifiant stable d'un système existant dans la carte.
* **Condition** : la faction possède le système ciblé.
* **Compatibilité schéma** : `value` est une chaîne conforme au schéma (`string`).

### 3.4 Survie (`type: "survival"`)
* **Paramètre requis** : aucun paramètre propre ; la durée est portée par `maxTimeMs`.
* **Condition** : si `timeMs >= maxTimeMs`, la victoire revient à la faction du joueur si elle a encore une présence (flotte ou système). Sinon, `draw`.
* **Compatibilité schéma** : ne déclare que `{"type": "survival"}` et exige `maxTimeMs`.

---

## 4. Contraintes globales

### 4.1 Limite de durée (`maxTimeMs`)
* **Comportement** : au dépassement (inclusif) de `maxTimeMs`, la partie est arrêtée et passe en tie-break si aucune condition de victoire n'est déjà satisfaite.
* **Validation** :
  * `maxTimeMs` doit être un entier strictement positif.
  * Si `survival` est présent, `maxTimeMs` est requis et doit être cohérent avec la durée souhaitée.

---

## 5. Tie-break et ordre de résolution

### 5.1 Priorité d'évaluation
1. Évaluer toutes les conditions de `win` dans l'ordre de déclaration. La première condition satisfaite déclenche immédiatement la victoire.
2. Si aucune victoire n'est atteinte et que `maxTimeMs` est dépassé, appliquer le tie-break.

### 5.2 Règles de tie-break
* **Survie** : si une condition `survival` existe, la victoire revient au joueur si sa présence est toujours active ; sinon `draw`.
* **Score de contrôle** : comparer le nombre de systèmes possédés. Le plus haut l'emporte.
* **Score de puissance** (si égalité sur le contrôle) : comparer la puissance totale des flottes (HP agrégés ou métrique interne équivalente).
* **Égalité restante** : si les scores restent strictement égaux, déclarer un **match nul**.

---

## 6. Compatibilité et validation
* La structure décrite reste alignée avec la section `objectives` du schéma de scénario existant ; aucun champ supplémentaire requis n'est introduit.
* Les moteurs de validation doivent :
  * Rejeter toute condition `win` ne correspondant pas à l'un des quatre types listés.
  * Vérifier la présence des paramètres obligatoires (`value` pour `domination` et `king_of_the_hill`) lorsque requis.
  * Garantir que l'ID référencé par `king_of_the_hill` existe dans le contenu généré ou statique du scénario.
  * Vérifier que `domination.value` est dans l'intervalle **]0,100]**.
  * Rejeter les valeurs non numériques pour `maxTimeMs`.

---

## 7. Points de vigilance
* **Conflit entre `elimination` et `domination`** : l'élimination prévaut si elle est atteinte en premier, mais la domination peut conclure la partie même en présence de flottes ennemies si la condition de pourcentage est remplie et évaluée avant `elimination` dans la liste.
* **Durée vs victoire** : la limite `maxTimeMs` ne remplace pas les conditions de `win` ; elle ne s'applique que lorsqu'aucune victoire n'est atteinte à temps.
* **Tie-break et lectures externes** : les règles de tie-break sont indépendantes des paramètres des objectifs ; elles doivent rester stables pour assurer la reproductibilité des replays et des sauvegardes.
