# Planet Map — carte planète 2D hex — Stellar Fleet V3

Version: **1.0** (générateur déterministe, carte cylindrique “wrap X”, compatible save)

> Ce document est la spécification consolidée du système **Planet Map** (surface 2D hex) et sert de contrat d’implémentation:
> types stables, pipeline ordonné, invariants testables, et points d’intégration UI.

## 1. Objectif et périmètre

La “Planet Map” est une vue 2D hexagonale (top-down) représentant la surface d’une planète (ou lune) pour visualiser et, à terme, supporter les opérations au sol (invasion, défense, présence d’armées, villes/points d’intérêt, rivières, biomes).

La carte doit être :

- cohérente avec l’environnement de la planète (température, atmosphère/pression, gravité, albédo, distance à l’étoile, éventuel échauffement de marée),
- déterministe (même seed + mêmes identifiants + même version d’algo => même carte),
- légère en sauvegarde (on ne stocke pas obligatoirement toutes les tuiles),
- performante au rendu (InstancedMesh, caméra orthographique, picking math).

### Contraintes de génération au début du jeu

On distingue deux niveaux :

- **Génération “structurelle” obligatoire au NewGame** : création d’un descripteur de surface (seed/config/version + liens astro). C’est très léger, et fige la reproductibilité.
- **Génération “matérialisée” (tuiles)** : au choix
  - mode **Lazy** (recommandé) : calcul à l’ouverture de la vue + cache LRU,
  - mode **Precompute** : calcul de toutes les grilles au lancement, au prix d’un coût CPU/mémoire initial plus élevé.

### Audit log (debug)

Un audit JSON deterministe peut etre genere pour diagnostiquer les surfaces
sans stocker toutes les tuiles. Il contient des seeds, des stats et un hash
par surface (voir `docs/specs/worldgen-audit-log.md`).

## 2. Représentation de la surface (topologie et grille)

Choix pragmatique (4X) : projection 2D cylindrique.

- Wrap Est-Ouest (wrapX = true).
- Pas de wrap Nord-Sud.
- Pôles gérés par latitude (froid + biomes polaires), sans topologie sphérique complexe.

### Taille de grille

- Ratio ~2:1 (W ≈ 2×H) pour limiter l’étirement visuel des pôles.
- Valeurs typiques : 64×32, 96×48, 128×64.
- Règle de dimensionnement recommandée (si planet.size disponible) :
  - w = clamp(round(60 * sqrt(size)), 64, 128)
  - h = clamp(round(w / 2), 32, 64)
  - Sinon, défaut global : 96×48.

### Système de coordonnées

- Interne : axial (q, r) recommandé (standard hex).
- Stockage/itération : index linéaire i = r*w + q (avec q ∈ [0..w-1], r ∈ [0..h-1]).
- Voisinage : 6 voisins axiaux, avec wrapX appliqué sur q.

### Latitude normalisée (pour température/biomes)

- lat ∈ [-1, +1]
- lat = (r/(h-1))*2 - 1

## 3. Modèle de données (minimum, recommandé, optionnel)

### 3.1 Types principaux (contrat stable)

```ts
export type Biome =
  | 'ocean' | 'coast' | 'lake'
  | 'ice' | 'fractured_ice' | 'dusty_ice' | 'cryovolcanic'
  | 'tundra' | 'taiga'
  | 'grassland' | 'forest' | 'rainforest'
  | 'desert' | 'ash_desert' | 'thermal_polygons'
  | 'lava_flats' | 'vitrified' | 'oxidized'
  | 'compressed_plateau' | 'chemical_erosion' | 'fossil_basin'
  | 'rocky' | 'mountain' | 'volcanic' | 'cratered';

export interface HexCoord { q: number; r: number; }

export interface PlanetSurfaceConfig {
  w: number;              // ex 96
  h: number;              // ex 48
  wrapX: boolean;         // true
  generatorVersion: number; // ex 1
}

export interface PlanetSurfaceDescriptor {
  seed: number;                 // uint32
  config: PlanetSurfaceConfig;
  astroRef: { planetIndex: number; moonIndex?: number }; // requis (lien stable vers astro)
  settlementConfig?: {
    neutralOutpostChance?: number;
    neutralOutpostRuinsChance?: number;
    developmentBias?: number;
  };
}

export const enum FeatureBits {
  River      = 1 << 0,
  Road       = 1 << 1,
  City       = 1 << 2,
  Capital    = 1 << 3,
  Resource1  = 1 << 8, // réserves pour le futur
}

export interface PlanetSurfaceTile {
  elev: number;        // int16 (ou float32 si vous préférez)
  tempC2: number;      // int16: température locale en °C*2 (encoding figé)
  moist: number;       // uint8 0..255
  biome: Biome;
  featureBits: number; // bitset
}

export interface Settlement {
  id: string;
  name: string;
  coord: HexCoord;
  factionId?: string;       // undefined si neutre
  type: 'outpost' | 'colony' | 'frontierTown' | 'city' | 'metropolis' | 'megalopolis';
  population: number;
  status?: 'active' | 'ruins';
  isCapital?: boolean;
}

export interface PlanetSurfaceMap {
  systemId: string;
  bodyId: string;                  // planetId (ou moonId)
  descriptor: PlanetSurfaceDescriptor;
  seaLevelElev: number;            // seuil “mer” pour cohérence et rivières
  tiles: PlanetSurfaceTile[];      // longueur w*h (ou buffers typés internes)
  settlements: Settlement[];
}

export interface SurfacePos {
  bodyId: string; // planetId (ou moonId)
  q: number;
  r: number;
}
```

### 3.2 Ce qui est déjà dans vos données (suffisant pour v1 “cohérent”)

PlanetData contient déjà l’essentiel pour contraindre le générateur :

- climateK / temperatureK / teqK
- gravityG
- albedo
- atmosphere (+ pressureBar? si présent) + greenhouseK + airMassIndex
- semiMajorAxisAu
- type/class (terrestrial / sub-neptune / etc.)
- Côté lunes : MoonData.tidalBonusK? utile pour volcanisme.

Conclusion opérationnelle :

- Pour produire une carte crédible (océans/glaces/déserts/relief/rivières conditionnelles), les données existantes suffisent.
- Pour des saves stables : persister un **PlanetSurfaceDescriptor** (seed + config + generatorVersion), et préférer un **astroRef** (planetIndex/moonIndex).

## 4. Déterminisme, seeds, versioning

Principe : aucune lecture de hasard non seedée. Toute décision provient de (gameSeed, systemId, bodyId, generatorVersion).

### Seed de surface

- seed = hash32(`${gameSeed}|${systemId}|${bodyId}|surface|v${generatorVersion}`)
- hash32 : FNV-1a ou équivalent, stable, sans dépendances.

### Versioning

- PlanetSurfaceConfig.generatorVersion est obligatoire.
- Toute modification qui change la carte implique soit :
  - incrémenter generatorVersion,
  - ou maintenir la compat bit-for-bit (rarement souhaitable).

### Implémentation actuelle (repo)
- Fichier moteur : `src/engine/worldgen/planetSurfaceGenerator.ts` (versions 1/2 legacy, v6 par défaut).
- Entrée pipeline : `generateSurfaceMap` choisit l’implémentation selon `descriptor.config.generatorVersion`.
- Spécificités v4/v5 (P0 qualité) : macro-masse continentale séparée du relief, rotation/warp anti-anisotropie, jitter côtier, bruit périodique wrapX, classification océan = plus grande composante d’eau, nettoyage micro-îles/micro-lacs post-seuil, bords de côtes recalculés après labeling.
- Spécificités v6 (terrain-first) : champ de terrain continu échantillonné sur la sphère (dir unitaire), bruit 3D sans couture, carte 2D dérivée par sampling multi-points, textures 3D dérivées du même champ (source de vérité unique).

## 5. Pipeline de génération (cohérence environnementale)

Le pipeline standard produit trois champs continus puis discrétise :

- Altitude (elev) → Mer/continents/montagnes/cratères
- Température locale (tempC2) → gradient latitude/altitude + contraintes atmosphère/albédo
- Humidité (moist) → champ continu (bruit + latitude + hydrologie), modulé par l’atmosphère/pression

Validation hydrologie/climat (avant biomes et rivières) :
- Pas d’hydrosphère liquide si atmosphère absente ou pression < seuil (≈ 0.08 bar) → aucune eau de surface, pas de rivières.
- Si la température moyenne dépasse le point d’ébullition (≈ 100°C), pas d’hydrosphère liquide → aucune eau de surface, pas de rivières.
- Si la température moyenne est sous le point de congélation effectif (fonction de la pression), l’eau de surface est figée → biomes d’eau gelés, rivières désactivées.
- Le relief est modulé par la gravité (amplitude), l’activité tectonique (structures majeures) et l’érosion (atmosphère/hydrosphère/glaces).

Puis : classification biomes + rivières + features (villes).

#### Classification de surface (climat)
- `airless` si `airMassIndex < 0.06`
- `icy` si `climateK < 240`
- `hot` si `climateK > 335`
- `dense` si `airMassIndex >= 0.6` (CO2 + `greenhouseK >= 45` ⇒ `co2_greenhouse`)
- sinon `temperate`

#### Biomes (règles de distribution)
- `airless` ou hydrologie `none` : biomes inertes (rocky/cratered/mountain/volcanic), aucune hydrologie.
- `icy` ou hydrologie `frozen` : glace dominante + toundra/taïga, déserts froids rocheux, pas de rivières.
- `hot` : déserts/rocky/volcanic majoritaires, forêts rares et seulement en zones très humides.
- `dense` : humidité renforcée, biomes plus humides (forest/rainforest) sauf atmosphères hostiles (H2He/CO2) qui favorisent des biomes minéraux.
- `temperate` : diversité classique (océans/littoraux/forêts/plaines/déserts/montagnes) gouvernée par latitude, altitude, humidité.
- Biomes extrêmes non-biologiques (conditions sévères) :
  - Froid extrême : `fractured_ice`, `dusty_ice`, `cryovolcanic`.
  - Amplitudes thermiques : `thermal_polygons`.
  - Aridité volcanique : `ash_desert`, `lava_flats`.
  - Surfaces vitrifiées/oxydées : `vitrified`, `oxidized`.
  - Forte gravité / atmosphère corrosive : `compressed_plateau`, `chemical_erosion`.
  - Bassins fossiles hyperarides : `fossil_basin`.

## 6. Stockage, sauvegarde, caches

À sauvegarder (recommandé minimal) :

- PlanetSurfaceDescriptor par planète/lune solide :
  - seed, w, h, wrapX, generatorVersion
  - astroRef recommandé

À ne pas stocker par défaut :

- tiles[] : potentiellement volumineux.
  - Mode Lazy : régénération + cache LRU.
  - Mode Precompute : calcul au lancement, sans sérialiser forcément.

## 7. Intégration application (3 niveaux de vues)

Navigation contractuelle :

- GALAXY (carte systèmes)
- SYSTEM (vue 3D tactique)
- PLANET (nouvelle vue 2D hex)

## 8. Rendu et interactions (Three.js / R3F)

- OrthographicCamera (pan/zoom)
- InstancedMesh pour les hex, couleurs par instance selon biome
- Picking math écran->monde->axial

## 9. Unités au sol et combats (compat v1)

Phase 1 :

- Army “sur la planète” via containerId=planetId
- Position visuelle déterministe (hash(army.id) -> coord)

Phase 2 :

- armyPositionsById: Record<armyId, HexCoord>
- commandes MOVE_ARMY, etc.

## 10. Exigences de performance et qualité

- Taille max recommandée : <= ~15k hex (ex: 128×64 = 8192)
- Génération < 100–300 ms pour ~5k–10k hex (sinon Lazy + cache)
- Instancing obligatoire, éviter un mesh par tuile

## 11. Tests (obligatoires pour fiabiliser le déterminisme)

- Determinism : même descriptor => hash stable tiles + settlements
- Dimension bounds : tiles.length == w*h
- Validité : settlements sur tuiles non ocean
- Eau : % tuiles eau conforme waterFraction (tolérance faible)

## 12. Plan d’implémentation (tâches atomiques)

1) Types partagés (Biome, PlanetSurfaceDescriptor, PlanetSurfaceMap, etc.)
2) hash32 stable (FNV-1a) + deriveSeed(surface)
3) helpers hex
4) deriveSurfaceParams(PlanetData/MoonData)
5) generateSurfaceMap(descriptor, planetData?)
6) Stocker PlanetSurfaceDescriptor au NewGame
7) Écran PLANET_VIEW + navigation
8) Rendu InstancedMesh + orthographic camera
9) Picking math + tooltip
10) Markers villes + unités (phase 1)
11) Cache LRU (Lazy)
12) Tests determinism + invariants
