# Titre de la spécification

## Objectif
- Décrire le problème à résoudre et le résultat attendu.
- Préciser le public cible et le périmètre produit concerné.

## Scope
- Délimiter ce qui est couvert par la spécification et ce qui ne l'est pas.
- Mentionner les dépendances externes ou les interactions avec d'autres modules.

## Définitions
- Énumérer les termes et acronymes clés.
- S'aligner sur les types et constantes existants dans les sources TypeScript (ex. `src/shared/types.ts`, `src/engine/**`, `src/content/**`, `src/ui/**`).

## Données
- Lister les structures de données impliquées avec leurs champs obligatoires/facultatifs.
- Pointer vers les types TypeScript de référence (source de vérité) et noter les écarts éventuels.

## Règles/Algorithmes
- Détailler chaque règle métier ou étape algorithmique sous forme d'étapes déterministes.
- Inclure les conditions d'entrée/sortie et les transitions d'état.

## Constantes
- Regrouper toutes les constantes et paramètres réglables utilisés par la logique.
- Indiquer les emplacements de référence dans le code (fichiers TypeScript).

## Déterminisme
- Expliquer comment la logique reste déterministe (graine, RNG, ordre de traitement).
- Préciser les sources d'horodatage ou d'aléatoire et leur contrôle.

## Edge cases
- Lister les cas limites et comportements attendus.
- Documenter les stratégies de garde-fous et validations.

## Logs/UI
- Décrire les événements à tracer (logs) et les impacts UI éventuels.
- Spécifier le format attendu des messages et le niveau de sévérité.

## Tests/Acceptation
- Définir les cas de tests fonctionnels et d'acceptation, y compris les scénarios nominaux et limites.
- Indiquer les dépendances de test (fixtures, seeds) et la manière de les exécuter.
