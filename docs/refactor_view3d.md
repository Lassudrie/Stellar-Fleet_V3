# Plan d’action — Représentation graphique fidèle des systèmes stellaires et planètes (optimisé Codex 5.2)

Ce document traduit le diagnostic en un plan exécutable, découpé en lots patchables. Chaque lot contient des tâches détaillées, des fichiers cibles et une checklist de validation (Definition of Done).

## Principes d’exécution

- Priorité à la justesse des données et du modèle orbital avant toute amélioration visuelle (shaders, textures).
- Chaque lot doit rester mergable indépendamment, avec tests et instrumentation minimale.
- Réduire les “magic numbers” et rendre explicites les hypothèses (unités, époque, masses, référentiels).
- Pas d’allocation par frame côté viewer (objectif mobile) lorsque c’est évitable.

---

## Lot 0 — Garde-fous (tests + invariants + debug)

### Objectif
Empêcher les régressions et rendre visibles les incohérences de mapping (planètes/lunes) et de paramètres orbitaux.

### Tâches
1. Ajouter des tests unitaires de mapping `BodyId -> AstroRef`.
   - Cas: système sans lune.
   - Cas: système avec N planètes et M lunes par planète.
   - Vérifier que la lune `moon-{systemId}-{p}-{m}` mappe sur `astro.planets[p-1].moons[m-1]`.
2. Ajouter des assertions/invariants dans le build du SystemViewData.
   - Sur index (p-1, m-1) et présence des arrays.
   - Fallback contrôlé si astro manquante (ne pas crasher le viewer).
3. Ajouter un mode debug overlay (UI) pour afficher, sur l’objet sélectionné:
   - `kind` (star/planet/moon), `id`, `parentId`
   - `a,e,i,Ω,ω,M0`, période, rayon (mètres), index astro (planetIndex, moonIndex)
4. Ajouter un scénario de test “référence” (seed fixe) reproductible.
   - Option: fixture de système généré (JSON) pour tests/QA.

### Fichiers probables
- `src/viewer/spaceView.ts`
- `src/engine/tests/*` ou emplacement de tests existant
- `src/ui/*` (overlay debug / panneau sélection)

### Checklist de validation
- [x] Tests unitaires: mapping planète OK sur système sans lune.
- [x] Tests unitaires: mapping lunes OK sur système avec lunes (aucun décalage d’index).
- [x] Le viewer ne crashe pas si une astroRef est absente: fallback explicite et traçable.
- [x] Le debug overlay affiche des valeurs cohérentes (indices + éléments orbitaux).
- [x] Un seed fixe reproduit le même système et les mêmes mappings.

---

## Lot 1 — Refactor ViewData (hiérarchie + correction du bug planètes/lunes)

### Objectif
Corriger le bug structurel (indexation) et introduire un modèle hiérarchique des corps (étoiles/planètes/lunes) pour permettre un rendu fidèle.

### Tâches
1. Introduire un modèle unifié “BodyViewData” dans le viewer:
   - `BodyKind = 'star' | 'planet' | 'moon'`
   - `BodyViewData { id, name, kind, parentId: string|null, radiusMeters, baseColor, orbit?: OrbitElements, astroRef?: { planetIndex?, moonIndex?, starIndex? } }`
2. Remplacer l’ancien `planets: PlanetViewData[]` par une collection hiérarchique:
   - Racine: “frame” système (barycentre logique)
   - Enfants: étoiles (1..n)
   - Enfants d’une étoile (ou barycentre): planètes
   - Enfants d’une planète: lunes
3. Implémenter un mapping robuste `id -> astroRef`:
   - Parser les IDs générés par le worldgen (ex: `planet-{systemId}-{p}`, `moon-{systemId}-{p}-{m}`)
   - Planet: `planetIndex = p-1`
   - Moon: `planetIndex = p-1`, `moonIndex = m-1`
   - Ne plus utiliser `planetsAstro[index]` basé sur un index d’itération.
4. Séparer couleur “politique” du système vs couleur physique de l’étoile:
   - `markerColor = system.color` (galaxie/ownership)
   - `starColor` dérive de `teffK` (Lot 3), mais dès maintenant: ne plus utiliser `system.color` pour l’étoile.
5. Mettre à jour la création des assets:
   - Les objets “planète/lune” se placent dans le repère du parent (sans orbites hiérarchiques complètes à ce stade; minimal: group parenting).

### Fichiers probables
- `src/viewer/spaceView.ts`
- `src/engine/worldgen/stellarSystem.ts` (si besoin de normaliser IDs)
- `src/shared/shared.ts` (types partagés si nécessaires)

### Checklist de validation
- [x] Le mapping astro ne dépend plus de l’index d’itération; présence d’un parseur d’ID.
- [x] Une lune utilise bien `astro.planets[planetIndex].moons[moonIndex]`.
- [x] Le viewer affiche un système avec lunes sans incohérence visible (ex: lune attachée à sa planète).
- [x] La couleur de l’étoile n’est plus `system.color` (au minimum: couleur neutre provisoire).
- [x] Les objets ont un `parentId` cohérent et une hiérarchie logique (inspection debug OK).

---

## Lot 2 — Orbites fidèles (Kepler ellipse + orientation complète + tracés cohérents)

### Objectif
Modéliser correctement la position orbitale (ellipse) et rendre les tracés d’orbite cohérents avec la position des corps.

### Pré-requis données
Les éléments orbitaux doivent permettre une ellipse orientée:
- `a` (semi-major axis)
- `e` (eccentricity)
- `i` (inclination)
- `Ω` (longitude du nœud ascendant)
- `ω` (argument du périapside)
- `M0` (anomalie moyenne à l’époque)
- `epoch` (optionnel mais recommandé) ou convention d’époque fixe

### Tâches
1. Étendre les types partagés:
   - Ajouter `argPeriapsisDeg` (ω) et `meanAnomalyAtEpochDeg` (M0) pour:
     - `PlanetData`
     - `MoonData`
     - `StarOrbit` (companion stars)
   - Optionnel: ajouter `epochDays`/`epochSeconds` ou documenter une époque globale.
2. Mettre à jour la génération (worldgen) de ces paramètres:
   - Déterministe (seed)
   - Valeurs plausibles (ω, M0 uniformes 0..360; e dans bornes; i bornée)
3. Remplacer `computeOrbitPositionMeters()` par un solveur keplérien:
   - Calculer `n = 2π / period`
   - `M(t) = M0 + n * (t - epoch)`
   - Résoudre Kepler: `E - e sin(E) = M` (Newton-Raphson)
   - Convertir en vraie anomalie `ν`, rayon `r`
   - Position dans le plan orbital puis rotations `Rz(Ω) * Rx(i) * Rz(ω)`
4. Corriger la période orbitale:
   - Utiliser la masse centrale (Kepler 3) au lieu d’une hypothèse implicite `1 M☉`
   - Pour planètes: masse centrale = masse de l’étoile primaire (ou masse barycentrique)
   - Pour lunes: masse centrale = masse de la planète (si disponible; sinon approximation documentée)
5. Refaire la géométrie des orbites (tracés):
   - Générer polyline échantillonnée de l’ellipse (N segments adaptatifs)
   - Appliquer la même rotation `Ω,i,ω` que le calcul de position
   - Pour lunes: orbite dans repère local de la planète (objet parent)
6. Assurer l’invariant “corps sur son orbite”:
   - Même fonction de transformation utilisée pour:
     - (a) position instantanée
     - (b) ligne d’orbite

### Fichiers probables
- `src/shared/shared.ts`
- `src/engine/worldgen/stellarSystem.ts`
- `src/viewer/spaceView.ts`
- `src/viewer/*` (module utilitaire orbit/kepler recommandé, ex: `src/viewer/orbits.ts`)

### Checklist de validation
- [x] Un système avec orbites inclinées: lignes inclinées (pas dans un plan plat XZ par défaut).
- [x] Une planète est exactement sur la ligne de son orbite à tout instant (visuel + debug).
- [x] Une orbite excentrique est visiblement elliptique (e > 0) et cohérente.
- [x] La période varie correctement avec la masse centrale (tests/inspection debug).
- [x] Les lunes orbitent autour de leur planète (repère parent), pas directement autour de l’étoile.
- [x] Aucune allocation importante par frame dans l’update orbitale (profiling simple).

---

## Lot 3 — Rendu stellaire fidèle (couleur, taille, lumière, multiples)

### Objectif
L’étoile doit refléter l’astro (température/couleur, rayon, luminosité) et éclairer la scène correctement; gérer les systèmes multiples.

### Tâches
1. Créer un module “astro -> visuel”:
   - Conversion `teffK -> RGB` (approx blackbody ou table OBAFGKM)
   - Courbes/coeffs documentés (même approximatifs)
2. Construire les étoiles depuis `system.astro.stars[]`:
   - Rayon: `radiusSun * SUN_RADIUS_METERS`
   - Couleur: dérivée de `teffK`
   - Intensité: fonction de `luminositySun` (et distance)
3. Éclairage de scène:
   - Remplacer DirectionalLight fixe par PointLight au centre stellaire (ou stratégie hybride):
     - PointLight pour shading local
     - Option: Directional par planète (vector étoile->planète) si besoin d’un style constant
4. Ajouter un rendu “émissif/halo” pour la lisibilité:
   - Sprite/billboard (gradient) ou emissive material
5. Systèmes multiples:
   - Positionner les étoiles sur leurs orbites autour du barycentre:
     - Utiliser `StarOrbit` si présent
     - Sinon fallback déterministe simple (en attendant worldgen complet)
   - Mettre à jour l’éclairage (plusieurs sources ou simplification: primary seulement, documentée)

### Fichiers probables
- `src/viewer/spaceView.ts`
- `src/viewer/astroVisual.ts` (nouveau)
- `src/shared/shared.ts` (si besoin de types)
- `src/engine/worldgen/stellarSystem.ts` (si enrichissement orbit star)

### Checklist de validation
- [x] La couleur de l’étoile dépend de `teffK`, pas de `system.color`.
- [x] Le rayon à l’écran varie clairement selon `radiusSun`.
- [x] Les planètes montrent un terminator cohérent (même sans shader custom, via lumière).
- [x] Un système binaire affiche 2 étoiles (positions distinctes, pas superposées).
- [x] Le debug overlay indique starIndex et paramètres cohérents.

---

## Lot 4 — Rendu planétaire fidèle (rotation, terminator, surface, atmosphère, anneaux)

### Objectif
Rendre la planète “physiquement plausible” et exploiter les données/génération existantes (surface/biomes), en restant compatible mobile (LOD/streaming).

### Tâches
1. Rotation et obliquité:
   - Appliquer `axialTiltDeg` au mesh
   - Ajouter rotation propre (période paramétrable ou déterministe)
2. Terminator jour/nuit:
   - S’assurer que le shading (Lambert/Standard) reçoit la lumière stellaire correcte (Lot 3)
   - Option: shader custom si style “terminator net”
3. Texture de surface (albedo):
   - Générer une texture low-res initiale (ex: 256x128) issue du générateur de surface (biomes/altitude)
   - Upgrade de résolution selon taille écran (`planetScreenPx` seuils)
   - Cache (LRU) et streaming via `StreamingQueue`
4. Atmosphère et nuages:
   - Shell atmosphérique (sphere légèrement plus grande) avec Fresnel + opacité
   - Couverture nuageuse selon type/pression (nuages opaques si atmosphère épaisse)
   - Animation lente (offset UV) optionnelle
5. Anneaux:
   - Pour géantes gazeuses/glacées: disque anneaux (texture procédurale simple + alpha)
6. Cohérence des couleurs:
   - Palette stylisée mais dérivée de paramètres (température, type, composition)
   - Garder un mode debug “flat color” pour isoler les bugs.

### Fichiers probables
- `src/viewer/spaceView.ts` (createPlanetAssets, materials, textures)
- `src/engine/worldgen/planetSurfaceGenerator.ts` (si export d’API nécessaire)
- `src/viewer/*` (texture gen module, cache, LOD)

### Checklist de validation
- [x] La rotation de la planète est visible et stable (pas de jitter).
- [x] Le terminator est cohérent avec la position de l’étoile (test: déplacer la caméra).
- [x] Texture low-res apparaît rapidement puis s’améliore sans flash ni pop agressif.
- [x] Retour/aller vue système <-> planète: pas de planète “non texturée” (cache OK).
- [x] Atmosphère visible sur Earthlike/épaisse; nuages 100% opaques si requis.
- [x] Anneaux visibles uniquement sur types ciblés (pas sur telluriques par défaut).

---

## Lot 5 — Grille hexagonale géodésique (dual Voronoï) + overlay propre

### Objectif
Afficher la grille géodésique hex+12 pentagones (dual Voronoï sphérique) au lieu d’un simple wireframe triangulaire.

### Tâches
1. Produire le dual Voronoï à partir de `GeodesicGrid`:
   - Pour chaque face triangulaire: calculer un centre (circumcenter recommandé), reprojeter sur la sphère
   - Pour chaque sommet (tile): récupérer les faces incidentes et ordonner les centres autour du sommet
   - Connecter les centres en boucle (arêtes de cellule)
2. Générer un `LineSegments` (ou `Line2` si besoin d’épaisseur indépendante) pour l’overlay:
   - Coordonnées unitaires puis scale au rayon
   - Matériau overlay (opacité, profondeur) maîtrisé
3. LOD / fréquence:
   - Choisir `frequency` selon taille écran de planète
   - Cache par fréquence + par planète (seed) si nécessaire
4. Intégration:
   - Remplacer l’overlay triangulaire actuel par l’overlay cellulaire
   - Conserver une option debug pour afficher le triangulé (utile pour débug)

### Fichiers probables
- `src/engine/worldgen/geodesicGrid.ts` (ou module adjacent pour dual)
- `src/viewer/spaceView.ts` (overlay)
- Nouveau module conseillé: `src/viewer/geodesicVoronoi.ts`

### Checklist de validation
- [x] À l’écran, on observe majoritairement des hexagones et exactement 12 pentagones.
- [x] Pas de couture visible (grille continue sur toute la sphère).
- [x] L’overlay reste lisible au zoom et ne z-fight pas avec la surface.
- [x] Changer la fréquence LOD ne provoque pas de freeze perceptible (cache OK).
- [x] Le mode debug permet de comparer triangulé vs dual.

---

## Lot 6 — Performance & streaming (mobile-first)

### Objectif
Réduire draw calls et charges mémoire, rendre le rendu scalable sur smartphone.

### Tâches
1. Instancing en vue système:
   - Utiliser `THREE.InstancedMesh` pour les planètes (et lunes si nombreuses)
   - `instanceMatrix` update basé sur positions orbitales
   - `instanceColor` (ou texture LUT) pour variations de teinte
2. Streaming textures/overlays:
   - Génération progressive: low-res -> hi-res
   - LRU cache avec limite mémoire configurable
   - Déduplication (même seed -> même texture) si applicable
3. Zéro allocation par frame (viewer):
   - Réutiliser `Vector3/Matrix4/Quaternion` temporaires (pool)
   - Éviter `new` dans `update`/`animate`
4. Qualité adaptative:
   - Adapter segments sphère/LOD texture à `devicePixelRatio` et FPS
   - Seuils documentés (ex: degrade si FPS < 45)
5. Mesure:
   - Ajouter métriques simples: draw calls, triangles, VRAM estimée (overlay debug)

### Fichiers probables
- `src/viewer/spaceView.ts`
- `src/viewer/*` (cache, metrics)
- `src/engine/streaming/StreamingQueue.ts` (si ajustements)

### Checklist de validation
- [x] Vue système: draw calls fortement réduits (instancing effectif).
- [x] Zoom/pan: absence de spikes majeurs (profiling visuel).
- [x] Textures/overlays se chargent progressivement sans bloquer l’UI.
- [x] Pas d’allocations répétées par frame (inspection simple + logs).
- [x] La qualité baisse automatiquement en cas de FPS bas et remonte ensuite.

---

## Définition globale de “Done”

- [x] Mapping correct étoiles/planètes/lunes (Lot 1) validé par tests (Lot 0).
- [x] Positions orbitales keplériennes et lignes d’orbite cohérentes (Lot 2).
- [x] Étoiles: taille/couleur/lumière basées sur l’astro (Lot 3).
- [x] Planètes: terminator + rotation + texture progressive + atmosphère (Lot 4).
- [x] Grille hexagonale dual Voronoï (Lot 5).
- [x] Performance mobile: instancing + streaming + qualité adaptative (Lot 6).