# Architecture Système

## 1. Stack Technique
*   **Langage** : TypeScript 5.x (Strict Mode).
*   **Framework UI** : React 19 (Hooks, Functional Components).
*   **Rendu 3D** : Three.js via `@react-three/fiber` et `@react-three/drei`.
*   **Styling** : TailwindCSS.
*   **Build** : Vite.

## 2. Architecture Haut-Niveau
L'application suit une architecture stricte de séparation des préoccupations :

```mermaid
graph TD
    Engine[Game Engine (Pure Logic)] --> State[GameState (Immutable)]
    UI[React UI Layer] --> Engine
    Scene[3D Scene (R3F)] --> State
    
    subgraph "Engine Layer (engine/)"
        GameEngine class
        runTurn.ts
        RNG System
        Systems (Movement, Battle, World)
    end

    subgraph "Presentation Layer (components/)"
        UI Overlay (DOM)
        GameScene (Canvas)
        FleetRenderer (Meshes)
    end
```

## 3. Le Moteur de Jeu (`engine/`)
Le cœur du jeu est agnostique de l'UI.
*   **GameEngine** : Classe Singleton (instanciée dans `App.tsx`) qui détient l'état.
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

## 4. Couche de Présentation (`components/`)
*   **GameScene** : Contient le Canvas Three.js. Gère le rendu 3D.
*   **UI** : Overlay HTML/CSS (Menu, Badges, BattleScreen).
*   **Synchronisation** : `App.tsx` s'abonne (`subscribe`) aux changements du moteur et force un re-render React à chaque mise à jour de l'état.

## 5. Rendu 3D Optimisé
*   Utilisation de `Instances` (InstancedMesh) pour les systèmes stellaires (Galaxy.tsx) afin de maintenir 60fps.
*   Interpolation visuelle : Le moteur calcule des positions discrètes (Jour N, Jour N+1). `FleetRenderer` interpole la position entre ces états pour une animation fluide, indépendamment de la logique.