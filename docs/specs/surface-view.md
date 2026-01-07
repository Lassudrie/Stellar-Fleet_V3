# Surface View & Camera (UI)

## Périmètre
- Écran : `src/ui/components/screens/SurfaceView.tsx` (affichage carte hex de surface planétaire).
- Utilitaires partagés : `src/ui/components/screens/surfaceViewCore.ts` (maths hex, conversions, bounds/clamp).
- Entrées : `PlanetSurfaceMap` (tiles + settlements), armées/bâtiments/factions du `GameState`.

## Modèle caméra
- État : `{ zoom, offset }` où `offset` est un décalage pixel appliqué à la carte; le monde est exprimé en pixels hex (`HEX_SIZE`) à zoom=1.
- Bornes : zoom clampé `[MIN_ZOOM, MAX_ZOOM]`, pan limité par `computeMapBoundsPx` + marges (`PAN_MARGIN_PX`, `CENTER_SLOP_PX`).
- Ajustement auto : zoom initial forcé à 1×, centré sur le settlement à la population max (capital prioritaire en cas d’égalité), sinon centre carte; déclenché lors d’un changement de corps et tant que l’utilisateur n’a pas bougé la caméra (`userCameraRef`).
- Rendu : caméra orthographique Three.js synchronisée sur `{ zoom, offset }` (unités monde = pixels à zoom=1).

## Gestion des entrées
- Hook `useMapControlsCamera` : gère wheel zoom, pan, pinch via Pointer Events; `clampOffset` appliqué à chaque update.
- Touches : les handlers touch → pointer-like ne sont attachés qu’en fallback (si `PointerEvent` absent). Sur les navigateurs modernes seul le flux pointer est utilisé, supprimant les doublons touch/pointer. `preventDefault` sur touch/pointer pour bloquer scroll/zoom natifs; canvas a `touch-action: none`.
- Hover/tap : déplacements pointeur regroupés par frame, hover mis à jour hors interaction; tap détecté via `tapDragThresholdSq` dans le hook.

## Pipeline rendu
- Terrain : rendu Three.js (R3F) via instancing GPU (hex fill + bordure), couleurs par biome.
- Overlays (Canvas 2D) : portée de déplacement (`computeReachable`), chemin prévisualisé (`findPathWithCost`), armées/bâtiments/settlements (labels conditionnés par zoom), surbrillances sélection/hover/unité sélectionnée.
- Surlignage/sélection : conversion client → monde → hex (`pixelToGrid`), rejet si hors `bounds`.

## Palette terrain (biomes)
- `ocean` : `#0a75c2`
- `coast` : `#2bb9a8`
- `lake` : `#4f9dfd`
- `ice` : `#f2f7fb`
- `fractured_ice` : `#d7e6f6`
- `dusty_ice` : `#c9d2c8`
- `cryovolcanic` : `#9aaec7`
- `tundra` : `#ced4a4`
- `taiga` : `#1b6b4b`
- `grassland` : `#8ccb4a`
- `forest` : `#1e7c2f`
- `rainforest` : `#22a95f`
- `desert` : `#e3b04c`
- `ash_desert` : `#a88463`
- `thermal_polygons` : `#b6a46d`
- `lava_flats` : `#b3402c`
- `vitrified` : `#6b7c8a`
- `oxidized` : `#b35a3a`
- `compressed_plateau` : `#7c7f75`
- `chemical_erosion` : `#7aa081`
- `fossil_basin` : `#c1a07a`
- `rocky` : `#9b8974`
- `mountain` : `#565f6b`
- `volcanic` : `#e05b3c`
- `cratered` : `#8a60c6`

## Données dérivées
- Normalisation positions (`normalizePos` + `deriveFallbackPos` stable hash) pour armées/bâtiments/settlements; occupancy par hex.
- Supply/ZOC : `computeSupplyDistanceMapFromSurfaceMap`, `computeZocSnapshotFromArmies`.
- Préviews : mouvement (affinité terrain, coûts ZOC) et combat (adjacent, `previewEngagement`).

## Déterminisme & cache
- Aucune source non déterministe; dépend uniquement de la map et des états fournis. `surfaceMapKey` (seed+config+wrap) sert de clé de cache (map prête + instancing) pour éviter flicker lors des transitions.

## Points de vigilance
- Ne jamais muter l’état React ni l’état moteur; toujours copier les tableaux/objets.
- Respecter les frontières : pas d’import UI dans `surfaceViewCore.ts`, pas de moteur/DOM dans le reste du moteur.
- Toute modification d’ordre des phases de rendu ou de consommation RNG doit conserver l’ordre d’itération stable (tri explicite si nécessaire).
