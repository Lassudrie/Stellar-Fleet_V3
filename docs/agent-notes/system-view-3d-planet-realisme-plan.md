# Plan d'action - terrain "realiste d'abord" + declinaison 2D

## Objectif
Passer d'une generation "surface 2D d'abord" a une source de verite unique: un champ de terrain continu echantillonne sur une sphere. Les sorties (map 2D gameplay et textures/relief 3D) deviennent des derivations de ce champ, avec un rendu plus coherent et un determinisme conserve.
Priorite constante: rechercher la beaute des graphismes et un haut niveau de realisme, sans sacrifier les invariants techniques.

## Invariants a respecter
- Determinisme strict (pas de Math.random, pas de temps reel, RNG local derive).
- Immutabilite (pas de mutation in-place des tableaux/objets d'etat).
- Ordre d'iteration stable (tri explicite par id si RNG consommee).
- Frontieres de dependances (engine/shared/content != UI; UI peut consommer engine).
- Versioning: conserver la compatibilite des saves, lecture tolerante/ecriture stricte.

## Methodes pour assurer une haute qualite graphique
- References fixes: definir 4-6 seeds + cameras de reference et comparer visuellement a chaque iteration (avant/apres).
- Golden images: capturer des images "cibles" et valider absence de regressions (couture, poles, banding, details).
- Controle colorimetrique: sRGB pour les textures, pipeline linear dans le shader, tone mapping stable, dithering actif.
- Qualite des textures: mips actifs, anisotropy raisonnable, resolution adaptee a la distance/cap mobile.
- Materiaux calibres: ranges de roughness/normal/displacement par type de corps, ocean specular controle.
- Anti-aliasing geographique: multi-sampling deterministe des tiles et filtrage des textures pour eviter les artefacts.
- Debug visuel: overlay dev des resolutions, temps worker, et activations de maps (AO/roughness/height).
- Budget perf: definir des budgets GPU (nombre/taille de textures) pour eviter les degradations silencieuses.

## Architecture cible (source de verite + derivations)

### A. TerrainField (canonique)
Expose une API de sampling pure et deterministe:
- Entrees: descriptor (seed + generatorVersion + params), dir unitaire sur sphere, lod optionnel.
- Sorties: `TerrainSample` (height, oceanMask, temp, moist, roughness, biomeWeight/biome, craterMask, etc.).

Note: preferer l'echantillonnage de bruit en 3D (dir sur sphere) pour eviter couture/poles.

### B. Carte 2D (gameplay)
Pour chaque tuile (q,r), convertir vers (lat,lon) puis dir:
- multi-precision sampling (4-9 sous-echantillons) pour limiter l'aliasing.
- produire `PlanetSurfaceTile` (elev/temp/moist/biome/featureBits).
- conserver settlements/FeatureBits et l'existant gameplay.

### C. Assets 3D (SystemView3D)
Pour chaque pixel (u,v) d'une texture:
- dir = uvToSphereDir(u,v)
- sampleTerrain(dir)
- produire albedo/height/normal/roughness/ao + oceanMask
- overlay emissive (settlements, features) sans polluer la base terrain.

## Plan d'action par phases

### Phase 0 - Etat des lieux et garde-fous
- Cartographier le pipeline actuel (tiles -> textures) et identifier les points de duplication.
- Lister les parametres determinants (seed, generatorVersion, resolution).
- Capturer 4 cas visuels de reference (rocheux, glace, gaz, monde sans atmosphere).
- Verifier l'emplacement des tests existants (determinisme, serialization).

### Phase 1 - TerrainField v1 (engine)
Objectif: exposer une fonction `sampleTerrain(dir)` stable et reutilisable.
- Implementer dans `src/engine/worldgen/planetSurfaceGenerator.ts` ou extraire si besoin
  (fichier >500 lignes: extraction autorisee, mais ajouter un `index.ts` de dossier et
  basculer les imports internes vers le barrel).
- TerrainSample minimal: height, oceanMask, temp, moist, biome (ou biomeWeights).
- Bruits 3D + domain warp + masques (continentalness, mountains, craters).
- Aucun RNG sequentiel global: RNG local derive par hash seed + coords.
- Update docs: `docs/specs/world-generation.md`, `docs/specs/planet-map-v1.md`.
- Tests: verif determinisme (meme seed + meme dir => meme sample), pas de dep aux resolutions.

### Phase 2 - Deriver la map 2D depuis TerrainField
Objectif: la 2D devient un echantillonnage du terrain canonique.
- Rebrancher `planetSurfaceGenerator` pour boucler sur (q,r) -> dir -> sampleTerrain.
- Multi-sampling deterministe pour stabiliser biomes et altitude.
- Reutiliser la logique settlements/FeatureBits existante.
- Verifier la coherence poles/couture (lat/lon -> dir).
- Tests: map stable en seed fixe, pas de drift avec w/h differents.

### Phase 3 - Textures 3D depuis TerrainField (worker)
Objectif: plus de dependence aux tiles pour le rendu 3D.
- Dans `src/ui/workers/surfaceMapWorker.ts`, generer les maps (albedo, normal, height,
  roughness, AO, oceanMask) par sampling direct du TerrainField.
- Conserver un fallback sync coherent dans `src/ui/workers/index.ts`.
- Emissive overlay via settlements (depuis la map 2D, pas depuis le terrain brut).
- Ajouter un canal oceanMask explicite (texture ou alpha documente).
- Qualite: res configurable + eventuelle reduction sur mobile.

### Phase 4 - Ajustements visuels "realistes"
Objectif: gain perceptuel sans complexite lourde.
- Ajuster displacement/normal scale selon type de corps (planete, lune, airless).
- Craters pour mondes sans atmosphere (via craterMask).
- Climate simple: temperature latitudinale + altitude, humidite waterMask + bruit.
- Eau plus lisible (roughness plus basse + specular control).

### Phase 5 - Compatibilite & versioning
Objectif: migration sans casser les saves.
- Bump `generatorVersion` (ex: 6) pour activer le pipeline terrain-first.
- Garder le chemin v5 pour les saves existantes.
- Si format de save change: update `saveFormat.ts`, `serialization.ts`,
  `docs/specs/save-format.md`, tests associes.
- Ajouter un flag dev pour comparer visuellement v5/v6 (si utile).

### Phase 6 - Option long-terme (LOD / cube-sphere)
Objectif: zoom tres rapproche sans artefacts.
- Evaluer un cube-sphere ou LOD par distance.
- A prevoir uniquement si besoin (non bloquant pour le pivot terrain-first).

## Tests et validation
- `npm run typecheck` + `npm test` (engine + UI).
- `npm run typecheck:strict` si modifications engine.
- Comparaison visuelle avant/apres (meme seed): couture 0/360, poles, ocean lisse.
- Verification determinisme: meme seed/turn => meme surfaceMap + memes textures.

## Risques & mitigations
- Perf worker: sampling par pixel couteux -> baisser resolution, limiter samples, cache.
- Determinisme: sampling doit dependre uniquement du descriptor + dir.
- Divergence 2D/3D: garder une source de verite unique (TerrainField), pas de logic dupliquee.
- Compatibilite: garder v5 et activer v6 explicitement par version.

## Revue et durcissement (post-implementation)
- Rejouer les scenarii de reference (4 corps) et comparer les captures avant/apres.
- Verifier stabilite des sauvegardes et absence de regressions de determinisme.
- Mesurer le budget GPU (nombre de textures et taille).
- Verifier que la map 2D correspond visuellement a la 3D (biomes/relief).
- Mettre a jour la doc et l'audit log (`docs/specs/worldgen-audit-log.md`).

## Etat d'execution (post-implementation)
- Phase 1 (TerrainField v6) : fait.
- Phase 2 (map 2D derivee par sampling) : fait.
- Phase 3 (textures 3D depuis TerrainField + fallback sync) : fait.
- Phase 4 (ajustements visuels: roughness eau, craters, scales par type de corps) : fait.
- Phase 5 (generatorVersion 6 + chemin v5 conserve) : fait.
- Phase 6 (LOD/cube-sphere) : optionnel, non implemente.
- Validation : tests typecheck/test + captures visuelles a lancer.

## Robustification supplementaire
- Verifier la coherence worker/sync (meme seed -> meme textures) sur 2 resolutions.
- Encadrer les budgets texture (max size + fallback mobile) et consigner dans la doc.
- Confirmer que le canal roughness alpha encode bien le water mask (doc de rendu).

---

# Plan d'action - Surface 3D "Orbit-to-Ground" (SystemView3D)

## Objectif
Mettre en place une surface planétaire 3D zoomable et procédurale, de l’orbite jusqu’au sol, en s’appuyant sur une architecture cube-sphere + quadtree déterministe, avec LOD adaptatif, streaming par tuiles et transitions visuelles sans rupture.

## Invariants a respecter
- Determinisme strict: tout bruit et génération dérivent d’un seed stable.
- Immutabilite: pas de mutation in-place dans l’engine et les structures d’état.
- Ordre stable: tri explicite pour toute boucle qui consomme du RNG.
- Frontieres de dependances: UI peut consommer engine; pas d’aller-retour.
- Save-format: pas de rupture sans migration documentee.

## Architecture cible (orbit -> sol)

### A. Base mesh "orbitale"
- Sphère basse résolution (ou cube-sphere LOD0) pour l’affichage lointain.
- Textures existantes (albedo/normal/height) utilisées comme fallback.
- Atmosphère simple + nuages en overlay pour le macro-rendu.

### B. Cube-sphere + quadtree par face
- 6 faces, chacune en quadtree (face, lod, i, j).
- Mapping cube->sphere pour une grille stable sans pôles.
- Tuiles générées à la volée: maillage + hauteur via sampleTerrain(dir).

### C. LOD adaptatif par erreur écran
- Calcul d’erreur projetée (hauteur max / distance * facteur FOV).
- Subdivision si erreur > seuil; sinon rendu du patch courant.
- Delta LOD entre voisins borné à 1 pour limiter les fissures.

### D. Culling hiérarchique
- Frustum culling par bounding sphere de tuile.
- Horizon culling via test de cône (caméra vs sphère planète).
- Culling par face entière si opposée à la caméra.

### E. Streaming et budget
- File de tâches de génération des patches (prio par distance + angle).
- Time-slicing (budget ms par frame) + cache LRU des meshes.
- Budgets: triangles max, patches max, temps CPU max.

### F. Transitions sans pop
- Geomorphing (morph factor par distance) entre parent/enfants.
- Skirts pour masquer les fissures entre LOD.
- Option: cross-fade de textures multi-résolutions pour les détails fins.

## Plan d'action par phases

### Phase 0 - Cadrage et instrumentation
- Lister les composants 3D actuels dans `SystemView3D`.
- Ajouter un overlay debug (LOD/patch count/temps worker).
- Capturer 3-4 cas visuels de reference (planete, lune, airless).

### Phase 1 - Cube-sphere LOD0 + sampling canonique
- Construire la sphère via cube-sphere (6 faces).
- Echantillonnage hauteur en 3D (dir normalisee) via TerrainField.
- Verifier continuites aux coutures (faces adjacentes).

### Phase 2 - Quadtree + selection LOD
- Implémenter quadtree par face (structure UI, pas d’état moteur).
- Selection adaptative par erreur écran.
- Forcer delta LOD <= 1 entre voisins.

### Phase 3 - Generation et cache de tuiles
- Générer un patch (mesh + attributes) par tuile.
- Cache LRU des geometries + eviction par distance.
- Scheduler de generation (time-slice).

### Phase 4 - Transitions (geomorph + skirts)
- Ajouter skirts paramétrés par erreur max de tuile.
- Ajouter morph factor par tuile (distance -> morph).
- Valider l’absence de cracks au zoom rapide.

### Phase 5 - Optimisations perf
- Culling horizon + frustum hiérarchique.
- Limiter draw calls (instancing ou batching par material).
- Ajuster budgets selon framerate cible (mobile/desktop).

### Phase 6 - Micro-details au sol
- Normales de detail + blend de textures (biome-driven).
- Displacement local optionnel (zone proche caméra).
- Brouillard et shading atmosphérique pour masquer transitions lointaines.

## Tests et validation
- `npm run typecheck`
- `npm test`
- Comparaisons visuelles (same seed): coutures, pops, flicker.
- Verifier determinisme: une tuile identique (face/LOD/i/j) reste stable.

## Risques & mitigations
- Surcharge CPU: generation des patches -> time-slicing + cache.
- Pops visibles: morph + skirts + delta LOD limite.
- Coups de memoire: eviction LRU + budgets stricts.
- Divergence 2D/3D: TerrainField reste la source de verite.
