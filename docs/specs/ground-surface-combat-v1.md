# Spécification Technique : Ground Surface Combat V1 (Hex Map)

**Statut :** Implémentation (normative)  
**Responsable :** Engine Team  
**Portée :** unités terrestres, mouvement terrestre, combats terrestres sur carte hex (`PlanetSurfaceMap`).

---

## 1. Objectif

Remplacer la résolution terrestre agrégée "par planète" par un système **localisé sur la surface map hexagonale**, déterministe, lisible, et conforme au modèle de résolution strict (attrition + break + RNG faible).

---

## 2. Principes et invariants

1. **Localisation** : tout mouvement et combat terrestre se déroule sur une grille hex (`SurfacePos`) d’un `PlanetSurfaceMap`.
2. **Profil strict** : aucune statistique autre que **MM, M, A, D, C, K** ne participe aux calculs d’attrition, de ratio \(R\), de break, etc.
3. **K calculé à l’engagement** : `K` n’est **jamais** persisté en state; il est dérivé du terrain et des flags autorisés.
4. **Déterminisme** :
   - Itération stable (tri par id) dans chaque phase.
   - RNG **isolé par engagement** (seed locale) pour éviter les “effets papillon”.
5. **No stacking (MVP)** : un hex est occupé par **0 ou 1 unité** (toutes factions confondues).
6. **Hex de référence du combat** : l’engagement est résolu **sur l’hex du défenseur** (terrain du défenseur).

---

## 3. Modèle de données

### 3.1. Army (unité terrestre)

Les unités terrestres sont stockées dans `GameState.armies` (type `Army`).

#### Métadonnées (hors combat)
- `id: string`
- `factionId: FactionId`
- `state: ArmyState` (`EMBARKED | DEPLOYED | IN_TRANSIT`)
- `containerId: string` (fleetId si embarqué, bodyId si déployé)
- `surfacePos?: SurfacePos` (**obligatoire si** `DEPLOYED`)
- `unitType: GroundUnitType`
- `posture?: 'normal' | 'prepared_defense'`
- `groundOrder?: GroundOrder` (ordre du tour, stocké côté unité)
- `lastDeployedTurn?: number` (tour du dernier passage à `DEPLOYED`, utilisé pour l’assaut amphibie/aéroporté)

#### Profil de combat strict
- `maxMembers: number` (MM)
- `members: number` (M)
- `attack: number` (A)
- `defense: number` (D)
- `condition: number` (C ∈ [0..1])

### 3.2. GroundOrder (ordre terrestre)

Les ordres sont persistés sur l’unité pour symétrie joueur/IA et relecture.

- `Move { type:'move'; to: SurfacePos }`
- `Attack { type:'attack'; targetArmyId: string }`
- (optionnel) `SetPosture { type:'set_posture'; posture: 'normal'|'prepared_defense' }`

---

## 4. Terrain

### 4.1. TerrainType

Le moteur dérive un `TerrainType` par hex :

- `Open | Forest | Hills | Mountains | Urban | Swamp | Desert | Coastal`

### 4.2. Dérivation (Biome / features → TerrainType)

Règles (première règle gagnante) :
1. **Urban** si l’hex contient :
   - un `Settlement` (`PlanetSurfaceMap.settlements`), ou
   - un `GroundBuilding` (`GameState.groundBuildings`).
2. Mapping `Biome` :
   - `desert | ash_desert | vitrified | oxidized | fossil_basin → Desert`
   - `coast → Coastal`
   - `forest | rainforest | taiga → Forest`
   - `mountain | volcanic | lava_flats → Mountains`
   - `rocky | cratered | fractured_ice | cryovolcanic | thermal_polygons | chemical_erosion → Hills`
   - `grassland | tundra | ice | dusty_ice | compressed_plateau → Open`
   - `ocean` est **impassable** (voir mouvement)
   - `lake` : par défaut `Coastal` (peut évoluer vers `Swamp` selon humidité si spécifié).

### 4.3. Tables normatives

Le moteur maintient deux tables :

1) `Kterrain_base[TerrainType]` (multiplicateur terrain “neutre”)

2) `MoveCost[TerrainType]` (coût de base en MP)

**Kterrain_base (normatif)** :

| TerrainType | Kterrain_base |
| --- | --- |
| Open | 1.00 |
| Forest | 0.90 |
| Hills | 0.95 |
| Mountains | 0.85 |
| Urban | 0.90 |
| Swamp | 0.80 |
| Desert | 0.90 |
| Coastal | 1.00 |

**MoveCost (normatif)** :

| TerrainType | MoveCost |
| --- | --- |
| Open | 1 |
| Forest | 2 |
| Hills | 2 |
| Mountains | 3 |
| Urban | 2 |
| Swamp | 3 |
| Desert | 2 |
| Coastal | 2 |

> Les valeurs exactes doivent être alignées sur les constantes du moteur et les tests associés. Toute modification nécessite mise à jour des tests.

---

## 5. Mouvement terrestre

### 5.1. MP effectifs

```
MPeff = floor(BaseMP * C * SupplyFactor)
SupplyFactor = 1.0 (ravitaillé) | 0.7 (hors ravitaillement)
MPeff >= 1 si l’unité n’est pas hors de combat
```

**BaseMP (normatif, mapping actuel)** :

| UnitType | BaseMP |
| --- | --- |
| light_infantry | 4 |
| mechanized_infantry | 5 |
| heavy_armor | 5 |
| artillery | 3 |

### 5.2. Supply (MVP)

Une unité est ravitaillée si distance hex (BFS) ≤ `SUPPLY_RADIUS` d’un point de supply contrôlé.

Sources de supply (MVP) :
- settlements contrôlés (`settlement.factionId === factionId`),
- buildings contrôlés (optionnel selon implémentation).

### 5.3. Coûts de déplacement (centi‑MP)

Représentation : 1 MP = 100 centi‑MP.

```
effectiveCost = MoveCost(terrainToEnter) * MovementAffinity(unitType, terrainToEnter)
MovementAffinity clamp [0.7..1.3]
costCenti = round(effectiveCost * 100)
```

**ZOC** :
- entrer dans une ZOC ennemie : `+100`
- quitter une ZOC ennemie : `+100`

### 5.4. ZOC

Une unité projette une ZOC si `C >= 0.3`.

La ZOC utilisée pour le mouvement est un **snapshot** pris au début de l’exécution des ordres de mouvement terrestre.

### 5.5. Pathfinding

Algorithme : Dijkstra (ou A* déterministe) en centi‑MP.

Tie-break déterministe :
- ordre fixe des voisins axiaux (les 6 directions en ordre stable),
- puis `(r, q)` en cas d’égalité.

### 5.6. Fatigue de mouvement

Après exécution réelle du mouvement :

```
ΔCmove = 0.02 * HexesMoved
si mouvement contient un terrain de MoveCost >= 3 : ΔCmove *= 1.5
si hors ravitaillement : ΔCmove *= 1.5
C = clamp(C - ΔCmove, 0, 1)
```

### 5.7. Interaction mouvement → combat (situation)

Les informations transientes suivantes doivent être disponibles au moment d’un engagement :
- `mpEff`
- `mpUsed`
- `mpUsedRatio = mpUsed / mpEff`

Règles :
- si `mpUsedRatio >= 0.75` : appliquer un modificateur de situation `Ki = 0.9` sur l’attaquant.
- si `C < 0.4` : l’unité **ne peut pas attaquer**.
- artillerie (si activée par type/tag) : pas de tir si `mpUsedRatio > 0.5`.
- amphibie/aéroporté (si activé) : consomme 100% MP et applique `Ki = 0.70` **le premier tour après un débarquement**.

---

## 6. Combat terrestre (résolution 1v1 sur hex)

### 6.1. RNG triangulaire (ε = 0.08)

```
u1 = rng.next()
u2 = rng.next()
t = (u1 + u2 - 1)     // ∈ [-1, 1]
R = 1 + t * ε         // ∈ [1-ε, 1+ε]
```

`RA` et `RD` sont tirés séparément.

### 6.2. RNG isolé par engagement

Chaque engagement utilise une RNG locale avec seed :

```
seed = hash32(turn, attackerId, defenderId, "ground")
localRng = new RNG(seed)
```

### 6.3. Strength Ratio

```
SR = clamp(M / MM, 0, 1)
```

### 6.4. K (ordre strict)

Construire `K` dans cet ordre :
1. `kTerrainBase = Kterrain_base[TerrainType(defenderHex)]`
2. `kAffinity = CombatAffinity(unitType, TerrainType(defenderHex))`
3. `kSituation = Π Ki_situation`, puis clamp `[0.7..1.6]`
4. `kStatus = Π Ki_status`, puis clamp `[0.4..1.0]`
5. `K = clamp(kTerrainBase * kAffinity * kSituation * kStatus, 0.5, 1.8)`

Le moteur doit pouvoir exposer un breakdown complet (debug + UI).

**Ki_situation (normatif)** :
- `prepared_defense` : 1.20 (si `posture = prepared_defense`).
- `encirclement` : 1.40 (si le défenseur a ≥ 3 hex adjacents en ZOC ennemie).
- `spent_75pct_mp` : 0.90 (si `mpUsedRatio >= 0.75`).
- `amphibious_or_airborne` : 0.70 (premier tour après débarquement).

**Ki_status (normatif)** :
- `out_of_supply` : 0.60.
- `fatigue_extreme` : 0.50 (déclenché si `C < 0.30`).
- `moral_critical` : 0.70 (optionnel, si activé par règles).

### 6.5. Puissance effective et ratio R

```
AttackEff  = A * SR * C * K * RA
DefenseEff = D * SR * C * K * RD
R = AttackEff / DefenseEff
```

### 6.6. Attrition (members)

```
pDef = clamp(0.05 * R,   0.02, 0.30)
pAtt = clamp(0.04 / R,   0.01, 0.25)
losses = floor(M * p)
losses >= 1 si M>0 et p>0
M = max(0, M - losses)
```

### 6.7. Dégradation condition

```
ΔCdef = clamp(0.10 * R, 0.03, 0.25)
ΔCatt = clamp(0.08 / R, 0.02, 0.20)
C = clamp(C - ΔC, 0, 1)
```

### 6.8. Break

```
BreakScore = (1 - SRdef) * 0.6 + (1 - Cdef) * 0.4
Advantage = clamp(R - 1.1, 0.0, 1.0)
si R >= 2.5 => Advantage = 1.0
BreakChance = clamp(BreakScore * Advantage, 0.0, 0.85)
```

Garde‑fous :
- si `Cdef <= 0.20` ⇒ break
- si `SRdef <= 0.15` ⇒ break

Sinon :
- `roll = localRng.next()`
- break si `roll < BreakChance`

### 6.9. Hors de combat

Une unité est retirée du jeu si :
- `members === 0`, ou
- `condition < 0.20`.

### 6.10. Récupération (hors combat)

Par tour **sans combat** :
- Ravitaillé : `C += 0.08`
- Hors ravitaillement : `C += 0.04`

---

## 7. Outcome sur carte (break / retraite / avance)

### 7.1. Retraite du défenseur

Si le défenseur break :
1. candidates = voisins axiaux du défenseur
2. filtrer : passable, non occupé
3. préférer hors ZOC ennemie
4. minimiser “pression ennemie” (ex: nombre de ZOC ennemies adjacentes)
5. tie-break déterministe : `(pressure, r, q)`

Si aucun candidat : appliquer un outcome **déterministe** “overrun” (pas de RNG), puis éventuellement retirer si hors de combat.

### 7.2. Avance de l’attaquant (MVP)

Si le défenseur quitte l’hex (retraite ou retiré) et que l’hex devient libre, l’attaquant peut avancer dans l’hex libéré si cela ne viole pas no‑stacking.

---

## 8. Collisions de mouvement (no-stacking)

Les ordres de mouvement sont exécutés dans l’ordre lexicographique de `army.id`.

Si un pas tente d’entrer sur un hex déjà occupé (après application des mouvements précédents du tour), l’unité stoppe immédiatement sur l’hex précédent.

---

## 9. Orchestration de tour : phaseGround (map-based)

Ordre normatif :
1. Grouper unités `DEPLOYED` par `bodyId`.
2. Calculer supply maps par `(bodyId, factionId)`.
3. Snapshot ZOC pré‑mouvement.
4. Exécuter `Move` (pathfinding + MP limit + fatigue + collisions), collecter `mpUsedRatio`.
5. (Option) ZOC post‑mouvement (si utilisée pour retraite).
6. Exécuter `Attack` (validation, engagement, outcome break, retrait hors de combat).
7. Appliquer la récupération sur les unités **sans combat** (selon ravitaillement).
8. Nettoyer ordres (`groundOrder = undefined`).
9. Conquête minimale : si, sur un body, une seule faction garde des unités, `ownerFactionId = faction`.

---

## 10. Tests (acceptance)

1. Clamps et bornes : SR, K, kSituation, kStatus, pAtt/pDef, ΔC, BreakChance.
2. RNG triangulaire bornée \([1-ε, 1+ε]\).
3. Déterminisme : même état + mêmes ordres + même tour ⇒ même résultat (incluant retraite/collisions).
4. Non-inversion : si `R0 <= 0.8519...` alors aucune combinaison RA/RD (ε=0.08) ne doit produire `R > 1.0`.
