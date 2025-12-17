
# Spécification Fonctionnelle Générale

**Version :** 1.2  
**Statut :** Validé

---

## 1. Concept Global
Stellar Fleet est un jeu de stratégie et de simulation spatiale au tour par tour. Le joueur commande une flotte spatiale (Faction: **BLUE**) contre une IA ennemie (Faction: **RED**) dans une galaxie générée procéduralement.

## 2. Génération de l'Univers
Au démarrage d'une partie (ou restart), un univers est généré via une `seed`.
- **Systèmes Stellaires** : 100 systèmes positionnés selon une logique de bras spiraux ou de disque dispersé.
- **Territoire Initial** : Chaque faction reçoit un système capital et un cluster de systèmes adjacents.
- **Ressources** : Certains systèmes sont de type `GAS`, d'autres `NONE`. (Impact futur sur l'économie).

## 3. Gestion du Temps et Tours
Le jeu repose sur une boucle de jeu séquentielle :
1.  **Phase de Planification** : Le joueur donne des ordres (Mouvement, Split, Load/Unload). L'IA planifie ses coups.
2.  **Phase d'Exécution (`runTurn`)** :
    *   Résolution des combats spatiaux en attente (Battle System V1).
    *   Sanitization des Armées (Intégrité des références).
    *   Exécution des ordres IA.
    *   Mise à jour des positions (Mouvement des flottes).
    *   Synchronisation Armées : `IN_TRANSIT` -> `EMBARKED` à l'arrivée.
    *   Détection des nouveaux conflits spatiaux.
    *   **Résolution des conflits au sol (Ground Conflict).**
3.  **Incrémentation** : Le jour (`day`) avance de +1.

## 4. Flottes et Vaisseaux
Une flotte est une entité composée d'un ou plusieurs vaisseaux.
- **Types de vaisseaux** :
    *   `CARRIER`, `CRUISER`, `DESTROYER`, `FRIGATE`, `FIGHTER`, `BOMBER`.
    *   `TROOP_TRANSPORT` : Vaisseau non-combattant (Hull élevée, 0 DPS) capable de transporter une Armée.
- **Propriétés** : Chaque type possède des stats définies (HP, Damage, Speed, PD, Evasion, Stocks missiles/torpilles).

## 5. Mouvement
Le mouvement est spatial (Vector3) mais contraint par les règles de jeu :
- **Orbital** : Une flotte en orbite tourne autour de son étoile (purement visuel).
- **Transit** : Une flotte se déplace en ligne droite vers un système cible.
- **Vitesse** : La vitesse d'une flotte est déterminée par le vaisseau le plus lent de sa composition.
- **Interception** : Il n'y a pas d'interception en plein vide spatial. Les combats n'ont lieu que dans les systèmes.

## 6. Invasion et Capture de Territoire (Ground Ops)
La capture d'un système n'est plus automatique via la présence orbitale. Elle nécessite une action explicite d'invasion et la victoire au sol.

### 6.1. Déploiement ("Boots on the Ground")
Pour capturer ou défendre un système :
1.  Une flotte contenant des `TROOP_TRANSPORT` chargés doit être en orbite (`FleetState.ORBIT`) autour du système cible.
2.  L'ordre `UNLOAD_ARMY` doit être donné pour débarquer l'armée sur la planète (`ArmyState.DEPLOYED`).
3.  Conditions de débarquement :
    *   Pas de bataille spatiale active dans le système.
    *   Le débarquement est autorisé même en orbite contestée : les transports risquent alors d'être détruits avant de pouvoir déposer les troupes.
    *   La supériorité orbitale réduit ce risque sans la supprimer.

### 6.2. Résolution du Conflit Terrestre
À la fin du tour, si des armées de factions opposées sont présentes au sol (State `DEPLOYED`) :
1.  **Comparaison de Puissance** : Somme des effectifs (`strength`) de chaque camp.
2.  **Vainqueur** : Le camp avec la puissance la plus élevée gagne.
3.  **Anéantissement** : Le camp perdant est totalement détruit.
4.  **Attrition** : Le vainqueur subit des pertes proportionnelles à la force ennemie vaincue (Logic: 1 armée perdue pour chaque 20k effectifs ennemis).

### 6.3. Changement de Propriétaire
Le système change de couleur et d'owner si :
1.  Une faction a gagné le combat au sol (ou est seule présente).
2.  **Règle de Contestation Orbitale** : Si des flottes ennemies sont toujours présentes en orbite (même sans troupes), le drapeau ne change pas ("Contested"). Il faut nettoyer l'orbite ET le sol pour sécuriser la conquête.

## 7. Conditions de Victoire
La partie s'arrête si :
- **Victoire** : Toutes les flottes RED sont détruites.
- **Défaite** : Toutes les flottes BLUE sont détruites.
