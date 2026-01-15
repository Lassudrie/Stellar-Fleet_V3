# Architecture Système

## 1. Stack Technique
*   **Langage** : TypeScript 5.x (Strict Mode).
*   **Runtime** : Node.js 20 (ESM).
*   **Tooling** : tsx pour l'exécution des scripts/tests.

## 2. Architecture Haut-Niveau
L'application suit une séparation stricte des préoccupations entre logique et données :

```mermaid
graph TD
    Shared[Shared (src/shared)] --> Engine[Game Engine (Pure Logic)]
    Content[Content (src/content)] --> Engine
    Engine --> State[GameState (Immutable)]

    subgraph "Engine Layer (src/engine/)"
        GameEngine class
        runTurn.ts
        RNG System
        Services (Movement, Battle, World)
    end
```

## 3. Le Moteur de Jeu (`src/engine/`)
Le cœur du jeu est agnostique de toute couche de présentation.
*   **GameEngine** : Classe Singleton qui détient l'état.
*   **Pattern Redux-like** : Les modifications d'état se font via des actions (`GameCommand`) ou le tick (`runTurn`).
*   **Immutabilité** : L'état n'est jamais muté directement. Chaque tour produit un nouvel objet `GameState`.

### Boucle de Jeu (`runTurn.ts`)
Fonction pure : `(currentState, rng) => nextState`.
Elle orchestre les services séquentiellement :
1.  Résolution des batailles (V1).
2.  IA Planning.
3.  Exécution des Commandes.
4.  Mouvement.
5.  Détection de conflits.
6.  Capture de systèmes.
