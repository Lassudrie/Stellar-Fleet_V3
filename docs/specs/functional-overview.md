
# Spécification Fonctionnelle Générale

**Version :** 1.2  
**Statut :** Validé

---

## 1. Concept Global
Stellar Fleet est un jeu de stratégie et de simulation spatiale au tour par tour. Le joueur incarne l'une des nombreuses factions jouables d'une galaxie générée procéduralement ; plusieurs IA peuvent coexister et chaque faction possède sa propre couleur, son nom et son espace vital. Les scénarios peuvent définir plusieurs participants (joueurs ou IA), leurs couleurs et leurs objectifs propres.

## 2. Génération de l'Univers
Au démarrage d'une partie (ou restart), un univers est généré via une `seed`.
- **Systèmes Stellaires** : 100 systèmes positionnés selon une logique de bras spiraux ou de disque dispersé.
- **Territoire Initial** : Chaque faction reçoit un système capital et un cluster de systèmes adjacents.
- **Ressources** : Certains systèmes sont de type `GAS`, d'autres `NONE`. (Impact futur sur l'économie).

## 3. Gestion du Temps et Tours
Le jeu repose sur une boucle de jeu séquentielle :
1.  **Phase d'IA** : Génération et exécution des ordres IA.
2.  **Phase de Mouvement** : Mise à jour des positions des flottes.
3.  **Détection des combats** : Verrouillage des combats spatiaux à résoudre.
4.  **Résolution des combats spatiaux** : Traitement immédiat de toutes les batailles planifiées.
5.  **Bombardement orbital** : Application automatique des bombardements sur les armées au sol exposées.
6.  **Combat terrestre & Conquête** : Résolution des combats au sol et application de la capture.
7.  **Objectifs de victoire** : Vérification des conditions de victoire configurées.
8.  **Nettoyage & Avancement** : Maintenance de l'état, canonicalisation et incrémentation du `day` de +1.

## 4. Flottes, Brouillard de Guerre et Vaisseaux
Une flotte est une entité composée d'un ou plusieurs vaisseaux.
- **Types de vaisseaux** :
    *   Combattants : `CARRIER`, `CRUISER`, `DESTROYER`, `FRIGATE`, `FIGHTER`, `BOMBER`, `SUPPORT`.
    *   Logistique : `TRANSPORTER` (transport d'armées), `TANKER` (ravitaillement), `EXTRACTOR` (extraction de gaz), `BUILDER` (construction/civil).
- **Propriétés** : Chaque type possède des stats définies (HP, Damage, Speed, PD, Evasion, Stocks missiles/torpilles).
- **Brouillard de guerre (`rules.fogOfWar`)** : quand activé, seul ce qui est observé est visible :
    *  Un système est considéré observé s'il est possédé par la faction observatrice ou si au moins une de ses flottes se trouve dans la portée de capture (`CAPTURE_RANGE`).
    *  Une flotte ennemie est visible si elle appartient à la même faction que l'observateur, se trouve dans la portée de capteurs (`SENSOR_RANGE`) d'une flotte observatrice, est proche d'un système observé (portée de capture) ou se situe dans le territoire contrôlé par l'observateur.
    *  Les systèmes et leurs propriétaires restent visibles même lorsqu'ils ne sont pas observés, afin de préserver le rendu des frontières et du score territorial.

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
1.  Une flotte contenant des `TRANSPORTER` chargés doit être en orbite (`FleetState.ORBIT`) autour du système cible.
2.  L'ordre `UNLOAD_ARMY` doit être donné pour débarquer l'armée sur la planète (`ArmyState.DEPLOYED`).
3.  Conditions de débarquement :
    *   Pas de bataille spatiale active dans le système.
    *   Le débarquement est autorisé même en orbite contestée : les transports risquent alors d'être détruits avant de pouvoir déposer les troupes.
    *   La supériorité orbitale réduit ce risque sans la supprimer.

### 6.2. Résolution du Conflit Terrestre
À la fin du tour, si des armées de factions opposées sont présentes au sol (`ArmyState.DEPLOYED`) :
1.  **Puissance pondérée par la morale** : chaque armée contribue `puissance = strength × facteur_morale`, où le facteur de morale est borné (clamp) pour rester dans des bornes stables, sans pouvoir descendre sous le plancher ni dépasser le plafond.
2.  **Attrition proportionnelle** : chaque camp subit des pertes proportionnelles à la pression adverse avec un plafond de pourcentage de pertes par tour. Les pertes s'appliquent à toutes les armées du camp ; la morale est également réduite en fonction de la fraction de pertes.
3.  **Seuil de destruction** : toute armée dont la `strength` tombe sous `ARMY_DESTROY_THRESHOLD(maxStrength)` est supprimée. Les armées restantes doivent aussi rester au‑dessus du minimum de création (`MIN_ARMY_CREATION_STRENGTH`) pour être considérées comme survivantes.
4.  **Issues possibles** :
    *   Victoire d'un camp (l'autre n'a plus d'armées au‑dessus du seuil).
    *   `draw` si les deux camps conservent des armées encore valides.
    *   Destruction mutuelle si plus aucune armée ne dépasse le seuil.
5.  **Logs et effet réel** : les journaux indiquent la puissance engagée, les pertes appliquées et le nombre d'unités détruites, reflétant exactement l'attrition calculée en jeu.

### 6.3. Changement de Propriétaire
Le système change de couleur et d'owner si :
1.  Une seule faction conserve des armées déployées dans le système (aucun ennemi terrestre restant). Il suffit d'avoir **au moins une armée déployée** sur **une planète ou lune solide** : le système bascule et **tous les corps solides** du système deviennent possédés par cette faction (les corps non solides, ex. géantes gazeuses, ne basculent pas automatiquement).
2.  **Règle de Contestation Orbitale** : la capture est bloquée s'il existe une orbite contestée (`isOrbitContested`) dans la portée de capture, même après une victoire terrestre. Il faut nettoyer l'orbite ET le sol pour sécuriser la conquête.

### 6.4. Bombardement Orbital
Les flottes peuvent affaiblir des forces terrestres ennemies par bombardement orbital entre la résolution spatiale et le combat au sol :
- **Conditions** : une seule faction doit occuper l'orbite du système, au moins un vaisseau combattant (non `TRANSPORTER`) doit être en `ORBIT` et des armées ennemies doivent être déployées sur une planète solide du système.
- **Effets** : chaque bombardement inflige une perte de `strength` proportionnelle à la puissance de bombardement disponible, plafonnée pour éviter l'annihilation instantanée, et réduit la `morale` jusqu'à un minimum. Les pertes sont réparties entre les armées ciblées mais respectent un buffer pour éviter de passer sous le seuil minimal instantanément.
- **Journalisation** : chaque bombardement génère un log indiquant le système, la planète, la faction attaquante et les pertes appliquées. Si plusieurs factions partagent l'orbite, aucun bombardement n'a lieu.

## 7. Objectifs et Conditions de Victoire
Les conditions de victoire sont entièrement configurables par scénario (`objectives.conditions`) et peuvent impliquer plusieurs factions simultanément :
- **Aucune condition explicite** : par défaut, chaque faction tente d'éliminer toutes les autres (`elimination`).
- **Élimination (`elimination`)** : une faction gagne si tous ses adversaires n'ont plus ni flottes actives ni systèmes contrôlés.
- **Domination (`domination`)** : une faction gagne si elle contrôle au moins `X%` des systèmes (50% par défaut si la valeur n'est pas précisée).
- **Roi de la Colline (`king_of_the_hill`)** : une faction gagne si elle possède un système cible spécifique.
- **Survie (`survival`)** : utilisée avec un `maxTurns` ; le joueur remporte la partie s'il est encore présent (flottes actives) lorsque le tour limite est atteint, sinon la partie se termine en match nul.

Les conditions sont évaluées en "OU" pour chaque faction à la fin du tour (phase 7). Si un `maxTurns` est défini et atteint, la résolution est immédiate : priorité à `survival` pour la faction du joueur, sinon victoire du ou des leaders en nombre de systèmes contrôlés (égalité = match nul).
