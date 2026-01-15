# Surface View & Camera (UI)

## Périmètre
- Vue unifiée : `src/ui/components/GameScene.tsx` (UniverseScene + SurfaceLayer).
- Surface : planète sphérique stylisée + grille géodésique (hex + 12 pentagones).
- Entrées : `PlanetSurfaceMap` (tiles + settlements), armées/bâtiments/factions du `GameState`.
- Sélection : raycast sur la sphère, direction → `tileId` (grille géodésique), puis lecture de la map via `tileId` (et `q/r` uniquement pour les surfaces rectangulaires legacy).

## Modèle caméra / zoom
- Une seule caméra (`GameCamera`) avec bornes min/max par tier.
- Zoom sémantique : chaque layer (système/planète/surface) est mis à l’échelle pour préserver la précision float.

## Pipeline rendu
- Planète : sphère low-poly + matériau stylisé.
- Overlay : segments de lignes pour la grille géodésique; LOD choisi selon distance caméra.
- Marqueurs : armées et bâtiments posés sur la sphère, teintés par faction.
- Optimisation : rendu limité à un cap angulaire autour du point sous-caméra, cache par niveau de subdivision.

## Données et compatibilité
- Les surfaces utilisent une grille géodésique (icosphère) par défaut (`gridKind='geodesic'`), la grille rectangulaire `w×h` reste supportée pour compatibilité.
- `SurfacePos` utilise `tileId` comme identifiant principal; `q/r` restent optionnels pour les maps rectangulaires legacy.

## Déterminisme & perf
- Grille géodésique générée de façon déterministe (`src/engine/worldgen/geodesicGrid.ts`).
- Pas de source non déterministe; itérations stables.
- Ne jamais rendre la grille complète aux LOD élevés.

## Points de vigilance
- Ne jamais muter l’état React ni l’état moteur; toujours copier les tableaux/objets.
- Respecter les frontières : pas d’import UI dans `src/engine`, pas d’accès DOM dans le moteur.
