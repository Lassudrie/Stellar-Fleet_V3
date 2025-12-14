# Spécification Technique : Battle System V1

**Feature Flag :** `ENABLE_V1_COMBAT`  
**Responsable :** Engine Team

---

## 1. Objectif
Le Battle System V1 remplace la résolution instantanée par une simulation déterministe complexe, gérant les types d'armes (Cinétique, Missile, Torpille), la défense ponctuelle (PD) et l'évasion.

## 2. Cycle de Vie d'une Bataille

### Phase A : Détection (Fin du Tour N)
1.  Après tous les mouvements, le moteur scanne chaque système.
2.  Si des flottes **BLUE** et **RED** sont présentes dans le rayon de capture (`CAPTURE_RANGE`).
3.  Une entité `Battle` est créée avec le statut `scheduled`.
4.  Les flottes concernées passent en état `COMBAT`.
5.  **Note Importante** : Si un système contient déjà une bataille *active* (statut `scheduled` ou `resolving`), aucune nouvelle bataille n'est créée. Cependant, si une bataille passée est `resolved`, elle ne bloque pas la détection d'un nouveau conflit si des ennemis sont toujours présents au tour suivant.

### Phase B : Résolution (Début du Tour N+1)
1.  Avant toute action joueur/IA, les batailles `scheduled` sont résolues.
2.  La résolution est atomique (instantanée du point de vue CPU) mais simule plusieurs "Rounds" tactiques.
3.  Une `seed` spécifique est générée pour chaque bataille (`hash(battleId + turn)`) pour garantir l'isolation RNG.
4.  À la fin de la résolution, `turnResolved` est défini à `state.day`.

### Phase C : Application & Nettoyage
1.  Les dégâts sont appliqués aux flottes persistantes.
2.  Les vaisseaux détruits sont retirés.
3.  Un rapport de combat (`BattleLog`) est généré.
4.  Le statut passe à `resolved`.
5.  Les batailles résolues sont conservées dans l'état pendant 5 tours (`pruneBattles`) pour permettre au joueur de consulter les rapports, puis sont supprimées pour alléger la sauvegarde.

## 3. Algorithme de Résolution (Par Round)

La bataille dure **4 Rounds** fixes (sauf si un camp est anéanti avant).

### 3.1. Phase de Ciblage (Targeting)
Chaque vaisseau sélectionne une cible ennemie.
*   **Logique** : Priorité par classe (ex: Un Bomber vise en priorité Carrier > Cruiser).
*   **Friction** : 80% de chance de garder la même cible qu'au round précédent si elle est encore valide.

### 3.2. Phase de Manœuvre
*   Ajustement du `FireControlLock` (Bonus de précision).
*   Si le vaisseau a une cible : +25% de Lock/round.
*   Si pas de cible : Dégradation du Lock.

### 3.3. Phase de Lancement (Launch)
Les vaisseaux tirent leurs munitions limitées.
*   **Torpilles** : Dégâts élevés, lents (`ETA = 3 rounds`). Prioritaire.
*   **Missiles** : Dégâts moyens, rapides (`ETA = 2 rounds`). Saturation.
*   **Limite** : Max 2 projectiles par vaisseau par round (Burst).

### 3.4. Phase d'Interception (Soft Kill)
Les missiles en vol (ETA 0 ou 1) peuvent être interceptés par des contre-mesures.
*   Condition : Le défenseur doit avoir du stock de missiles.
*   Chance : 50% de tenter une interception, puis probabilité de réussite (`INTERCEPTION_BASE_CHANCE`).

### 3.5. Phase de Défense Ponctuelle (PD - Hard Kill)
Concerne uniquement les projectiles arrivant à l'impact ce round (`ETA = 0`).
*   Regroupement des menaces par cible.
*   La stat `pdStrength` du défenseur réduit les PV des missiles entrants.
*   Si PV missile <= 0, il est détruit.

### 3.6. Phase d'Impact & Tir Cinétique
*   **Impacts** : Les projectiles survivants infligent leurs dégâts aux HP du vaisseau cible.
*   **Cinétique (Canons)** : Tir immédiat.
    *   Formule : `HitChance = BaseAcc * Lock * (1 - EvasionCible)`.
    *   Dégâts appliqués immédiatement.

## 4. Données et Équilibrage
Les statistiques sont définies dans `SHIP_STATS`.

| Type      | Rôle     | PD Strength | Evasion | Armement Principal |
|-----------|----------|-------------|---------|--------------------|
| Carrier   | Capital  | Haute       | Faible  | -                  |
| Cruiser   | Capital  | Moyenne     | Moyenne | Torpilles / Canons |
| Destroyer | Screen   | **Très Haute**| Moyenne | Canons / PD        |
| Frigate   | Screen   | Faible      | **Haute** | Missiles           |
| Bomber    | Striker  | Nulle       | Haute   | **Torpilles**      |
| Fighter   | Striker  | Nulle       | **Très Haute**| Canons       |