# Plan d'action - realisme planetes (System View 3D)

## Contexte et reference
Le depot berrytechnics/procedural-planet est une reference utile car il combine:
- relief coherent
- cartes PBR (albedo / normal / roughness / AO)
- enveloppes visuelles (atmosphere / nuages)

Notre pipeline est deja proche: generation de textures en worker (albedo + normal/AO/roughness) puis application dans `src/ui/components/screens/SystemView3D.tsx`, avec couches nuages + atmosphere en shader. L'objectif est donc d'enrichir ce qui est deja calcule (micro-structure, coherence relief/couleur, eau/terre, details par biome), puis d'ajouter de la geometrie si besoin.

## Plan d'action (base A-D)

### A. Facettage (tessellation / LOD)
- Objectif: supprimer les bandes visibles sur planetes/lunes en vue rapprochee.
- Changement:
  - Monter la tessellation de base (planete 48 -> 96, lune 32 -> 64).
  - Option propre: conserver un LOD (ex: low 48, mid 96, high 128) et declencher le high en fonction de `highDetailBodyId` ou d'une distance camera.
- Fichiers:
  - `src/ui/components/screens/SystemView3D.tsx` (geometries)
  - `src/ui/components/screens/systemView3d/celestial.tsx` (selection de la geometrie active si ajout LOD par distance)
- Validation: zoom tres proche sur une planete, verif que les facettes ne sont plus visibles.

### B. Matiere PBR (metalness + dithering)
- Objectif: rendu plus credible pour des dielectriques (roche/glace/eau) et reduction du banding.
- Changement:
  - `metalness: 0.0` pour `planetMaterialMap` / `moonMaterialMap`.
  - `material.dithering = true` sur les materiaux de base et/ou sur les clones par corps.
- Fichiers:
  - `src/ui/components/screens/SystemView3D.tsx`
- Validation: specularite plus douce, gradients moins bandes au terminateur.

### C. Relief percu (heightField -> normal/AO)
- Objectif: relief plus lisible a la lumiere (pas seulement couleur).
- Changement:
  - Injecter une fraction de `macroNoise` / `microNoise` dans le `heightField` qui sert aux normales/AO.
  - Eviter l'ocean (multiplier par `landWeight` / water mask).
  - Repliquer la meme logique dans le fallback sync.
  - Renforcer la lecture via `SURFACE_NORMAL_SCALE` (0.85 -> 1.1) si besoin.
- Fichiers:
  - `src/ui/workers/surfaceMapWorker.ts`
  - `src/ui/workers/index.ts`
  - `src/ui/components/screens/systemView3d/config.ts`
- Validation: relief visible en gros plan sans "bosseler" l'ocean.

### D. Transition jour/nuit + atmosphere
- Objectif: un terminateur moins "calculateur", mieux fondu dans l'atmosphere.
- Changement:
  - Reduire l'agressivite du terminator (baisser `DAY_NIGHT_NIGHT_MIN`, augmenter `DAY_NIGHT_TERMINATOR_SOFTNESS`, ou appliquer un facteur seulement sur la composante diffuse).
  - Si une atmosphere est presente, diminuer l'effet terminator et laisser l'atmosphere porter le halo/twilight.
- Fichiers:
  - `src/ui/components/screens/systemView3d/renderUtils.ts`
  - `src/ui/components/screens/systemView3d/config.ts`
  - `src/ui/components/screens/systemView3d/atmosphere.tsx` (si ajustement cote shader)
- Validation: bord jour/nuit moins dur, halo atmospherique plus lisible.

### Patch rapide a tester (delta minimal)
- Planete: `SphereGeometry(1, 48, 48)` -> `SphereGeometry(1, 96, 96)` (ou 128 si le LOD reste utile).
- Lune: `SphereGeometry(1, 32, 32)` -> `SphereGeometry(1, 64, 64)`.
- Materiaux: `metalness` a 0 + `dithering = true`.
- Relief: injecter micro/macro noise dans `heightField` (hors ocean).
- Normal scale: `SURFACE_NORMAL_SCALE = 1.1`.

## Phase 0 - Baseline rapide (1 jour)
- Inventorier les maps actuellement produites (albedo, normal, roughness, AO, water weight) dans `src/ui/workers/surfaceMapWorker.ts`.
- Verifier la voie de secours sync dans `src/ui/workers/index.ts` pour garder le rendu identique quand le worker est indisponible.
- Capter des captures ecran "avant" (planete froide, chaude, lune sans atmosphere, geante gazeuse) pour comparaison.

## Phase 1 - Micro-relief dans heightField (quick win)
Objectif: rendre la normal map et l'AO moins "plastique" sans changer le pipeline.
- Reinjecter une petite fraction des bruits macro/micro dans le heightField qui sert au calcul des normales/AO.
- Eviter de "bosseler" l'ocean (multiplier par un landWeight).
- Repliquer la meme logique dans le fallback sync.

Fichiers:
- `src/ui/workers/surfaceMapWorker.ts`
- `src/ui/workers/index.ts`

Pseudo-regle (a adapter):
- relief = landWeight * reliefSlope * ((macroNoise - 0.5) * macroAmp * 0.22 + (microNoise - 0.5) * microAmp * 0.18)
- heightField = clamp01(heightNorm + relief)

Succes attendu:
- lecture de relief plus riche
- normal map plus "vraie"
- AO plus credible

## Phase 2 - Eau vs terre (PBR lisible)
Objectif: rendre la specularite et la rugosite credibles.
- Renforcer la differenciation roughness eau/terre dans la generation (water plus lisse, terre plus rugueuse).
- Ajuster normalScale pour que l'eau paraisse plus calme.
- Option simple: utiliser la roughness map existante (canal G) + water mask (alpha) pour regler la specularite.
- Option plus forte: ajouter un "ocean shell" (sphered mesh legerement plus grand) masque par water mask avec un materiau dedie.

Fichiers:
- `src/ui/workers/surfaceMapWorker.ts`
- `src/ui/workers/index.ts`
- `src/ui/components/screens/SystemView3D.tsx` (materials, option ocean shell)

## Phase 3 - Displacement + LOD (relief geometrie)
Objectif: relief visible en gros plan sans exploser le budget.
- Produire une height map (heightRgba) en worker.
- Ajouter un champ `heightMap` dans le bundle de textures de `SystemSurfaceTextureManager`.
- Activer `displacementMap` + `displacementScale` sur les planete selectionnees / en gros plan.
- Introduire au moins 2 niveaux de geometrie (LODs) selon la distance.
- Capper agressivement sur mobile (pas de displacement, resolutions plus basses).

Fichiers:
- `src/ui/workers/surfaceMapWorker.ts`
- `src/ui/workers/index.ts`
- `src/ui/components/screens/SystemView3D.tsx` (SystemSurfaceTextureManager + geometries + LOD)

## Phase 4 - Details "procedural-planet"
Objectif: details a forte valeur percue, sans refonte lourde.
- Crateres pour lunes / mondes sans atmosphere (stamping dans height + albedo + roughness).
- Variation latitudinale (utile pour geantes gazeuses, glaces, etc.).
- Bruit en espace 3D / triplanar dans le shader pour limiter les coutures aux poles.
- Nuit credible: emissiveMap (villes / lave) appliquee uniquement au shading direct, pas a l'emissif.

Fichiers:
- `src/ui/workers/surfaceMapWorker.ts`
- `src/ui/components/screens/SystemView3D.tsx` (shader / material hooks)

## Garde-fous (determinisme & perf)
- Aucun Math.random ou source non deterministe dans worker / generation.
- Conserver un ordre d'iteration stable.
- Sur mobile: limiter les resolutions, pas de displacement, moins de maps (au minimum albedo + roughness).
- Mesurer la memoire GPU (textures) si possible via logs temporaires.

## Validation
- Comparer "avant/apres" sur 4 cas types (rocheux, glace, gaz, lune sans atm).
- Verifier couture 0/360 et poles.
- Verifier que l'ocean reste lisse et ne "bosselle" pas.
- Executer `npm run typecheck` et `npm test` apres chaque phase impactante.

## Backlog pragmatique (mobile-first)
Backlog derivé de l'etat actuel du code + roadmap cible.

### P0 - Lisibilite / stabilite (MVP solide)
- [x] Terminator fige optionnel (planetes), nuages qui tournent encore.
  - Dep: `src/ui/components/screens/systemView3d/celestial.tsx`, `src/ui/components/screens/systemView3d/renderUtils.ts`.
  - Acceptance: le bord jour/nuit ne bouge pas quand la planete tourne; les nuages restent animes.
  - Vigilance: ne pas casser la lecture multi-etoiles (terminator base sur l'etoile primaire).
- [x] Ownership overlay sans regen de textures.
  - Dep: `src/ui/components/screens/systemView3d/surfaceTextures.tsx`, `src/ui/components/screens/SystemView3D.tsx`.
  - Acceptance: changement de `ownerFactionId` ne declenche pas une regen albedo/normal; overlay couleur ou masque separé.
  - Vigilance: conserver la lisibilite des biomes (tint leger, alpha controle).
- [x] Debug "surface textures" (resolution, cache, inflight) en mode dev.
  - Dep: `src/ui/components/screens/SystemView3D.tsx`, `src/ui/components/screens/systemView3d/surfaceTextures.tsx`.
  - Acceptance: affichage simple activable (flag dev) sans impact perf notable.
  - Vigilance: pas de logs bruyants, pas d'impact sur determinisme.

### P1 - Info gameplay / impact visuel
- [x] City lights emissive mask (settlements + feature bits), masque cote jour.
  - Dep: `src/shared/shared.ts` (settlements), `src/ui/workers/surfaceMapWorker.ts`, `src/ui/components/screens/SystemView3D.tsx`.
  - Acceptance: planetes colonisees visibles cote nuit, intensite proportionnelle a la population.
  - Vigilance: garder un seuil minimal (eviter le "sapin de Noel"), pas d'update continue.
- [x] Multi-etoiles: clarifier la source du terminator (primary-only ou mix pondere).
  - Dep: `src/ui/components/screens/SystemView3D.tsx`, `src/ui/components/screens/systemView3d/renderUtils.ts`.
  - Acceptance: comportement defini et stable; pas de flicker.
  - Vigilance: limiter le cout shader (1 direction lumineuse par defaut).
- [x] Gas giants: normal/roughness legers pour accrocher la lumiere.
  - Dep: `src/ui/components/screens/systemView3d/surfaceTextures.tsx`.
  - Acceptance: bandes visibles avec relief subtil sans bruit excessif.
  - Vigilance: rester cheap (pas de bruit lourd en shader).

### P2 - Polish visuel / coherence 2D-3D
- [x] Traitement poles/couture (blend caps ou triplanar leger).
  - Dep: `src/ui/workers/surfaceMapWorker.ts`.
  - Acceptance: couture 0/360 invisible, poles moins etires.
  - Vigilance: ne pas introduire de divergence avec la carte 2D.
- [x] Crater stamping pour lunes/monde sans atmosphere.
  - Dep: `src/ui/workers/surfaceMapWorker.ts`.
  - Acceptance: relief crateres lisible en gros plan, pas de repetition evidente.
  - Vigilance: determinisme strict (seed derivee).
- [x] LOD geometrie base sur taille ecran (pas seulement selection).
  - Dep: `src/ui/components/screens/SystemView3D.tsx`.
  - Acceptance: relief plus fin en zoom proche, sans "pop" brutal.
  - Vigilance: capper sur mobile (pas de LOD high auto).
