# Spécification de Génération de Monde

**Version :** 1.0  
**Statut :** Draft

---

## 1. Topologies de Carte
La forme globale de la galaxie est contrôlée par `generation.topology` (`spiral` | `ring` | `cluster` | `scattered`). Les positions utilisent un rayon logique `generation.radius`.

- **Spiral** : 2 à 3 bras. Les systèmes sont distribués le long des bras avec un léger biais vers le centre, une torsion progressive et un bruit latéral pour éviter l’alignement parfait.  
- **Ring** : Donut creux. Les systèmes sont échantillonnés entre 60 % et 100 % du rayon, avec une faible variation verticale.  
- **Cluster** : Plusieurs blobs aléatoires. Des centres (3 à 5) sont tirés dans 30–80 % du rayon puis chaque système est placé suivant une distribution gaussienne autour d’un centre. Si aucun centre n’existe (garde-fou), le mode passe en `scattered`.  
- **Scattered** : Disque uniforme (par défaut). Les positions sont réparties uniformément dans le cercle via un rayon tiré avec `sqrt(rng)` et une verticalité plus marquée.

## 2. Espacement Minimal
`generation.minimumSystemSpacingLy` (défaut : 5, 0 pour désactiver) impose une distance minimale entre les systèmes, statiques compris.
- Si l’espacement échoue pour une position topologique, le générateur tente des placements “fallback” en disque plein puis choisit le meilleur candidat parmi des échantillons pour maximiser la distance au voisin le plus proche.  
- Si aucun placement ne respecte la contrainte, un avertissement est loggé et le meilleur effort est utilisé. Les positions statiques ne sont **jamais** auto-ajustées : des warnings apparaissent si elles violent l’espacement.

## 3. Insertion des `staticSystems`
`generation.staticSystems` permet d’imposer des systèmes (ID, nom, position, ressource, éventuels corps planétaires).
- Ils sont injectés en premier, conservant leurs ID/coordonnées et héritant d’une taille légèrement supérieure (`size: 1.5`).  
- Les planètes peuvent être surchargées par `planets` (copiées dans le `buildPlanetBodies`).  
- Avertissement si deux systèmes statiques sont plus proches que l’espacement minimal lorsque celui-ci est actif.

## 4. Allocation Territoriale Initiale
### 4.1 Distribution de départ (`setup.startingDistribution`)
- **scattered** : chaque faction reçoit un unique homeworld choisi pour maximiser la distance entre factions (la première évite si possible les systèmes statiques).  
- **cluster** : identique à `scattered` pour le homeworld, puis chaque faction reçoit jusqu’à 4 systèmes neutres les plus proches pour former un noyau contigu.  
- **none** : aucun propriétaire initial.

### 4.2 Allocation ciblée (`setup.territoryAllocation`)
Optionnelle, de type `percentages`. Calcule une cible de systèmes par faction à partir des parts `byFactionId`, arrondies de manière contrôlée.  
- `neutralShare` : part réservée aux neutres (si omise, correspond aux systèmes restants). Limite l’allocation maximale aux factions.  
- Croissance contiguë : chaque faction s’étend depuis ses systèmes possédés vers les systèmes neutres les plus proches (en ignorant les `staticSystems`) jusqu’à atteindre sa cible. Les couleurs sont appliquées immédiatement.

## 5. Construction des Planètes
Après l’affectation des systèmes et des propriétaires, chaque système reçoit son payload astro déterministe (`generateStellarSystem`). Les corps planétaires sont ensuite construits via `buildPlanetBodies`, intégrant les overrides éventuels des systèmes statiques.

## 6. Distribution des Flottes et Armées Initiales
Les flottes décrites dans `setup.initialFleets` sont instanciées par faction :
- **Spawn** :  
  - `home_system` : en orbite du homeworld de la faction (ou système aléatoire en secours).  
  - `random` : dans un système possédé ; sinon neutre ; sinon n’importe lequel.  
  - Coordonnées `{x,y,z}` : spawn en espace profond, verrouillant la cible vers le système le plus proche (état `MOVING`).  
- **Composition** : chaque type est validé ; sinon remplacé par `frigate` avec warning.  
- **Armées embarquées** : si `withArmies` est vrai, chaque `TROOP_TRANSPORT` génère une armée `EMBARKED`.

## 7. Garnisons Automatiques
Tous les systèmes possédés reçoivent des armées déployées sur les planètes solides : 3 pour un capital (`isHomeworld`), 1 pour les autres. Les planètes occupées héritent de l’owner si absent.

## 8. Part Neutre et Logs
- Les systèmes non affectés après allocation demeurent neutres ; la part neutre cible est pilotée par `neutralShare`.  
- Un log d’initialisation documente le seed et la topologie (`[WorldGen] Generated …`).  
- Les systèmes générés conservent `ownerFactionId = null` lorsque laissés neutres, tout en exposant leurs ressources et corps planétaires.
