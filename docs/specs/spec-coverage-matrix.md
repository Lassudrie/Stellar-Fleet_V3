# Matrice de Couverture des Spécifications

| Sous-système | Fichiers code principaux | Spécification associée | Statut | Action à mener |
| --- | --- | --- | --- | --- |
| Engine | `src/engine/GameEngine.ts`, `src/engine/strategicSimulation.ts`, `src/engine/fogOfWar.ts`, `src/engine/conquest.ts` | `docs/specs/functional-overview.md`, `docs/specs/battle-system-v1.md` | PARTIAL | Compléter la spécification pour couvrir l’IA (`src/engine/ai.ts`), la brume de guerre et les règles de conquête, puis aligner les étapes du cycle stratégique documenté avec les phases réelles de `runStrategicTick`. |
| Simulation & services | `src/engine/worldgen/worldGenerator.ts`, `src/engine/movement/movementPhase.ts`, `src/engine/battle/resolution.ts` | *(Aucune spécification dédiée)* | MISSING | Rédiger une spécification des services (génération du monde, mouvement, résolution de combat) incluant leurs entrées/sorties et contrats de dépendance. |
| Scénarios | `src/content/scenarios/index.ts`, `src/content/scenarios/registry.ts`, `src/content/scenarios/schemaV1.ts`, `src/content/scenarios/templates/` | `docs/specs/scenario-spec.md` | OK | Conserver l’alignement entre le schéma V1 et les templates ; ajouter une section « validation automatique » pour formaliser les contrôles lors de l’ajout de nouveaux scénarios. |
