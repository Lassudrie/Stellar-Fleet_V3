# Surface View & Camera (UI)

## Périmètre
- Écran : `src/ui/components/screens/SurfaceView.tsx` (affichage carte hex de surface planétaire).
- Utilitaires partagés : `src/ui/components/screens/surfaceViewCore.ts` (maths hex, zoom/fit, buffer terrain).
- Entrées : `PlanetSurfaceMap` (tiles + settlements), armées/bâtiments/factions du `GameState`.

## Modèle caméra
- État : `{ zoom, offset }` où `offset` est un décalage pixel appliqué à la carte; le monde est exprimé en pixels hex (`HEX_SIZE`) à zoom=1.
- Bornes : zoom clampé `[MIN_ZOOM, MAX_ZOOM]`, pan limité par `computeMapBoundsPx` + marges (`PAN_MARGIN_PX`, `CENTER_SLOP_PX`).
- Ajustement auto : `computeFitZoom` (pad 0.94, cap à 1) lors d’un changement de corps ou première vue; figé après interaction utilisateur (`userCameraRef`).
- Quantification : buffers terrain re-générés uniquement aux paliers `TERRAIN_ZOOM_STEP`, dépendants de la dpr.

## Gestion des entrées
- Hook `useMapControlsCamera` : gère wheel zoom, pan, pinch via Pointer Events; `clampOffset` appliqué à chaque update.
- Touches : pont explicite (handlers touch → pointer-like) actif tant qu’aucun `pointermove` n’a été vu (`pointerMoveSeenRef`), pour contourner les navigateurs qui annulent le flux pointeur (Android/WebView/Safari-like). `preventDefault` sur touch/pointer pour bloquer scroll/zoom natifs; canvas a `touch-action: none`.
- Hover/tap : déplacements pointeur regroupés par frame, hover mis à jour hors interaction; tap détecté via `tapDragThresholdSq` dans le hook.

## Pipeline rendu
- Terrain : buffer offscreen (`TerrainBuffer`) par `(mapKey, quantizedZoom, dpr)` rendu via `renderTerrainLayer` (palette `biomeColors`). Fallback : dessin direct sur canvas si buffer absent.
- Overlays : portée de déplacement (`computeReachable`), chemin prévisualisé (`findPathWithCost`), armées/bâtiments/settlements (labels conditionnés par zoom), surbrillances sélection/hover/unité sélectionnée.
- Surlignage/sélection : conversion client → monde → hex (`pixelToGrid`), rejet si hors `bounds`.

## Données dérivées
- Normalisation positions (`normalizePos` + `deriveFallbackPos` stable hash) pour armées/bâtiments/settlements; occupancy par hex.
- Supply/ZOC : `computeSupplyDistanceMapFromSurfaceMap`, `computeZocSnapshotFromArmies`.
- Préviews : mouvement (affinité terrain, coûts ZOC) et combat (adjacent, `previewEngagement` + intervalle RNG `approxRngRange`).

## Déterminisme & cache
- Aucune source non déterministe; dépend uniquement de la map et des états fournis. `surfaceMapKey` (seed+config+wrap) invalide les buffers; `readyMapCache` conserve la dernière map prête par corps pour éviter flicker lors des transitions.

## Points de vigilance
- Ne jamais muter l’état React ni l’état moteur; toujours copier les tableaux/objets.
- Respecter les frontières : pas d’import UI dans `surfaceViewCore.ts`, pas de moteur/DOM dans le reste du moteur.
- Toute modification d’ordre des phases de rendu ou de consommation RNG doit conserver l’ordre d’itération stable (tri explicite si nécessaire).
