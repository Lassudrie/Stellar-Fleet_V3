# Plan d'action - realisme planetes (System View 3D)

## Contexte et reference
Le depot berrytechnics/procedural-planet est une reference utile car il combine:
- relief coherent
- cartes PBR (albedo / normal / roughness / AO)
- enveloppes visuelles (atmosphere / nuages)

Notre pipeline est deja proche: generation de textures en worker (albedo + normal/AO/roughness) puis application dans `src/ui/components/screens/SystemView3D.tsx`, avec couches nuages + atmosphere en shader. L'objectif est donc d'enrichir ce qui est deja calcule (micro-structure, coherence relief/couleur, eau/terre, details par biome), puis d'ajouter de la geometrie si besoin.

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
