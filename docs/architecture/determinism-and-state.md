# Déterminisme et Gestion d'État

## 1. Le Principe de Déterminisme
Stellar Fleet est conçu pour être strictement déterministe.
**Définition** : Pour une `seed` initiale donnée et une suite de commandes joueurs identique, l'état du jeu au tour N sera **toujours** identique, quel que soit la machine, le navigateur ou le moment de l'exécution.

### Pourquoi ?
*   **Replayabilité** : Possibilité de rejouer une partie.
*   **Débug** : Reproduire un bug nécessite uniquement la sauvegarde (JSON).
*   **Synchronisation future** : Facilite un mode multijoueur (Lockstep simulation).

## 2. Règles d'Implémentation (STRICT)

### Règle #1 : Isolation de la RNG
*   Interdiction totale d'utiliser `Math.random()`.
*   Utilisation exclusive de la classe `RNG` (`engine/rng.ts`), basée sur l'algorithme Mulberry32.
*   L'instance `RNG` est passée dans toute la chaîne d'appel de `runTurn`.

### Règle #2 : Pas de temps système dans la logique
*   Interdiction d'utiliser `Date.now()` ou `performance.now()` pour influencer la logique de jeu.
*   Le temps est discret (`state.day`).
*   Seul le rendu visuel (`useFrame`) peut utiliser le temps système pour les animations.

### Règle #3 : Ordre des opérations stable
*   Lorsqu'on itère sur des collections (Flottes, Systèmes) pour appliquer des règles (ex: Combat), il faut garantir un ordre stable.
*   **Pratique** : Toujours trier par `id` avant d'effectuer des opérations sensibles à l'ordre qui consomment de la RNG.

Exemple dans `resolveBattle.ts` :
```typescript
// BON
battleShips.sort((a, b) => a.shipId.localeCompare(b.shipId));
// (Ensuite seulement on itère et on utilise rng.next())
```

### Règle #4 : Isolation RNG locale
Pour éviter que l'ordre de résolution des batailles n'influence le reste de la galaxie (effet papillon indésirable sur la génération procédurale future) :
*   Les sous-systèmes complexes (comme Battle V1) doivent instancier leur propre `RNG` dérivée.
*   `const battleRng = new RNG(currentState.seed + battleHash)`.

## 3. Sérialisation et Sauvegarde
Le système de sauvegarde repose sur la sérialisation complète du `GameState`.

*   **Format** : JSON.
*   **Versioning** : `SAVE_VERSION` dans `saveFormat.ts` pour gérer les migrations futures.
*   **Persistance RNG** : L'état interne du générateur RNG (`rngState`) est sauvegardé. Au chargement, la classe `RNG` est restaurée dans cet état précis.

### Structure DTO (Data Transfer Object)
Nous distinguons les types Runtime (`Vector3` de Three.js) des types DTO (`{x,y,z}`).
Le fichier `serialization.ts` contient les mappers `serializeGameState` et `deserializeGameState` qui font la conversion et la validation.

## 4. Stratégie de Migration vers l'Immutabilité (React Rendering)

Pour garantir des performances UI optimales avec `React.memo`, nous adoptons une stratégie hybride :

1.  **Engine (Simulation)** : Migration progressive vers le "Copy-on-Write". Les commandes (`commands.ts`) renvoient déjà de nouveaux objets. La boucle de simulation (`runTurn`) est en cours de migration.
2.  **App (Vue)** : En attendant l'immutabilité totale du moteur, l'application (`App.tsx`) génère un **View Snapshot** à chaque notification.
    *   Copie superficielle (shallow copy) des tableaux principaux (`fleets`, `systems`, etc.).
    *   Cela force le rafraîchissement des composants React purement basés sur les props.

*Note : Une fois `runTurn` entièrement refactorisé pour être immutable (structurellement partagé), le View Snapshot pourra être retiré.*
