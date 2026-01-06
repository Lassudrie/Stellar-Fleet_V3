# Backlog v2 (hors refonte combat terrestre)

Scope:
- Exclut: resolver combat, mouvement/ZOC/stacking, pipeline ground v2.
- Inclut: commandes etat/sauvegarde, orbite <-> sol, UI multi-vues, IA, logs/i18n, tests.

P0 - Blocants d'integration
- Etat et sauvegarde v2: ajouter champs manquants (army: morale/fatigue/range/projectionRange/groundOrders/landingOrder; state: settlementControl) + serialization/validation + bump SAVE_VERSION. Files: src/shared/shared.ts, src/engine/serialization.ts
- Commande debarquement: introduire ORDER_GROUND_LAND + validation (hex passable, cap stack, amphibious) + stockage landingOrder. Files: src/engine/commands.ts, src/shared/shared.ts
- Bombardement -> sol: exposer "bombardedThisTurn" (ou equivalent) et penalties de debarquement (contested orbit + bombarded hex) + anti-orbital projection. Files: src/engine/orbitalBombardment.ts, src/engine/runTurn.ts, src/engine/armyOps.ts

P1 - UX et lisibilite
- UI multi-vue: afficher % settlements controles par body, statut contested, et debarquements planifies. Files: src/ui/components/Galaxy.tsx, src/ui/components/ui/GroundOpsModal.tsx, src/ui/components/screens/SurfaceView.tsx
- Surface overlays: controle settlements, supply, stacking, bombardedThisTurn (affichage seulement). Files: src/ui/components/screens/SurfaceView.tsx

P2 - IA / logs / i18n
- IA debarquement: selection zone (terrain + defense), eviter stacking, annulation si risque eleve. Files: src/engine/ai.ts
- Logs + i18n: logs debarquement, pertes, capture settlement; cles i18n FR/EN. Files: src/engine/runTurn.ts, src/ui/i18n/locales/en.ts, src/ui/i18n/locales/fr.ts

P3 - Tests / docs
- Tests specifiques debarquement + bombardement (determinisme, pertes, penalties). Files: src/engine/tests/engine.spec.ts (ou nouveau script test)
- Docs: aligner turn-loop / save-format avec les nouvelles phases et champs. Files: docs/specs/turn-loop.md, docs/specs/save-format.md

Notes:
- "saveFormat.ts" n'existe pas dans le repo; si besoin, clarifier l'endroit de la version de save.
- Plusieurs items dependent de la refonte ground v2 pour la logique, mais peuvent etre prepares cote commandes/UI/serialization.
