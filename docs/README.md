# Stellar Fleet - Documentation Technique

## Vue d'ensemble
Ce dossier contient la documentation technique, architecturale et fonctionnelle du projet **Stellar Fleet**, un simulateur de batailles spatiales 3D déterministe pour web et mobile.

## Structure de la documentation

### 1. Spécifications Fonctionnelles (`specs/`)
Détail des règles du jeu et des mécaniques.
- **[Vue d'ensemble fonctionnelle](specs/functional-overview.md)** : Génération de monde, économie, mouvement, IA.
- **[Battle System V1](specs/battle-system-v1.md)** : Spécification détaillée du moteur de résolution de combat par rounds.
- **[Gabarit de spécification](specs/_template.md)** : Structure à suivre pour toute nouvelle spécification fonctionnelle.

### 2. Architecture & Ingénierie (`architecture/`)
Conception technique et contraintes critiques.
- **[Architecture Système](architecture/system-design.md)** : Architecture globale, séparation Moteur/UI/Rendu, Stack technique.
- **[Déterminisme & Gestion d'État](architecture/determinism-and-state.md)** : Le cœur du moteur. Gestion de la RNG, Immutabilité, Sérialisation.

### 3. Données & API (`data/`)
Structure des données.
- **[Modèles de Données](data/data-models.md)** : Définition des entités (GameState, Fleet, System) et des DTOs de sauvegarde.

## Scénario actif

Le simulateur propose désormais plusieurs scénarios, notamment **Conquest Sandbox** (`src/content/scenarios/templates/conquest_sandbox.ts`) et **Spiral Convergence** (`src/content/scenarios/templates/spiral_convergence.ts`), tous deux référencés manuellement dans `src/content/scenarios/registry.ts`. Toute nouvelle définition devra être ajoutée au registre pour être exposée à l'UI.

## Conventions de rédaction des spécifications

- **Indexation** : toute nouvelle spécification doit être ajoutée dans `docs/specs/` et référencée dans la liste ci-dessus pour garantir la découvrabilité.
- **Convention de nommage** : utiliser le `kebab-case` en anglais pour les fichiers de spécification (ex. `battle-system-v1.md`, `scenario-spec.md`). Inclure une version dans le nom uniquement si plusieurs itérations coexistent.
- **Source de vérité des types** : décrire les données en s'alignant sur les définitions TypeScript existantes (`src/shared/types.ts`, `src/engine/**`, `src/content/**`, `src/ui/**`). Tout écart doit être explicité, et les sections **Données** et **Constantes** doivent pointer vers les types/constantes correspondants.

## Installation & Démarrage

Le projet utilise **Vite** et **React**.

```bash
npm install
npm run dev
```
