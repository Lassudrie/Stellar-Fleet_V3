# Stellar Fleet - Documentation Technique

## Vue d'ensemble
Ce dossier contient la documentation technique, architecturale et fonctionnelle du projet **Stellar Fleet**, un simulateur de batailles spatiales 3D déterministe pour web et mobile.

## Structure de la documentation

### 1. Spécifications Fonctionnelles (`specs/`)
Détail des règles du jeu et des mécaniques.
- **[Vue d'ensemble fonctionnelle](specs/functional-overview.md)** : Génération de monde, économie, mouvement, IA.
- **[Battle System V1](specs/battle-system-v1.md)** : Spécification détaillée du moteur de résolution de combat par rounds.

### 2. Architecture & Ingénierie (`architecture/`)
Conception technique et contraintes critiques.
- **[Architecture Système](architecture/system-design.md)** : Architecture globale, séparation Moteur/UI/Rendu, Stack technique.
- **[Déterminisme & Gestion d'État](architecture/determinism-and-state.md)** : Le cœur du moteur. Gestion de la RNG, Immutabilité, Sérialisation.

### 3. Données & API (`data/`)
Structure des données.
- **[Modèles de Données](data/data-models.md)** : Définition des entités (GameState, Fleet, System) et des DTOs de sauvegarde.

## Scénario actif

Le simulateur charge uniquement le scénario **Conquest Sandbox** situé dans `scenarios/templates/conquest_sandbox.ts`, référencé manuellement par le registre `scenarios/registry.ts`. Toute nouvelle définition devra être ajoutée au registre pour être exposée à l'UI.

## Installation & Démarrage

Le projet utilise **Vite** et **React**.

```bash
npm install
npm run dev
```