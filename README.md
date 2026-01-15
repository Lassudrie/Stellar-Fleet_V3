# Stellar Fleet

A deterministic space battle simulation engine.

## Architecture

- **Engine (`src/engine/`)** : Simulation déterministe (boucle de tour, IA, combat, déplacement, génération).
- **Content (`src/content/`)** : Données statiques et templates de scénarios.
- **Shared (`src/shared/`)** : Types métier et utilitaires runtime partagés.
- **State** : Immutable updates.
- **Determinism** : The simulation (world generation, combat, movement logs) is strictly deterministic based on the `seed` in `GameState`. `Math.random` and `Date.now` are prohibited in state-modifying logic.
- **Règles de dépendance** : `src/shared` n'importe rien ; `src/content` ne dépend que de `src/shared` ; `src/engine` dépend de `src/shared` et `src/content`.

## Tech Stack

- TypeScript (ESM) / Node 20
- tsx for test execution

## Installation fiable

- Version Node recommandée : **20.x** (voir `.nvmrc` pour la version exacte). npm 10.x est attendu (champ `engines`).
- Commande standard : `npm ci` (identique à la CI).
