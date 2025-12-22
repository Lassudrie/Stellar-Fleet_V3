# Stellar Fleet

A minimalist 3D space battle simulator for mobile.

## Architecture

- **UI (`src/ui/`)** : React + React Three Fiber, écrans, hooks, i18n et orchestration de l'app.
- **Engine (`src/engine/`)** : Simulation déterministe (boucle de tour, IA, combat, déplacement, génération).
- **Content (`src/content/`)** : Données statiques, templates de scénarios et assets audio utilisés par l'UI.
- **Shared (`src/shared/`)** : Types métier et utilitaires runtime partagés.
- **State** : Immutable updates.
- **Determinism** : The simulation (world generation, combat, movement logs) is strictly deterministic based on the `seed` in `GameState`. `Math.random` and `Date.now` are prohibited in state-modifying logic. Visual animations (FleetRenderer) may use system time for smooth interpolation but do not affect logic.
- **Audio assets (UI only)** : stockés sous `src/content/audio/` avec des sous-dossiers `sounds/` (effets) et `musics/` (ambiances). La couche moteur n'en dépend jamais.
- **Règles de dépendance** : `src/shared` n'importe rien ; `src/content` ne dépend que de `src/shared` ; `src/engine` dépend de `src/shared` et `src/content` mais jamais de `src/ui` ; `src/ui` peut orchestrer l'ensemble.

## Tech Stack

- React 19 / Vite
- React Three Fiber / Three.js
- TailwindCSS
