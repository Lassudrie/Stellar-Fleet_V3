# Stellar Fleet — Guide pour agents

Ce dépôt contient **Stellar Fleet**, un simulateur de batailles spatiales 3D (Vite/React + React Three Fiber) avec un **moteur strictement déterministe**.

Ce fichier est destiné aux assistants de code (agents) et sert de “contrat” projet : commandes utiles, frontières d’architecture, invariants à ne pas casser, et conventions de contribution.


## Commandes indispensables

La CI exécute Node **20** (voir `.github/workflows/ci.yml`). Pour reproduire fidèlement la CI, privilégier Node 20+.

Installation (recommandé, identique à la CI) :

```bash
npm ci
```

Développement :

```bash
npm run dev
```

Vérifications (avant PR) :

```bash
npm run typecheck
npm test
```

Vérifications utiles (selon le scope du changement) :

```bash
npm run typecheck:strict   # strict sur src/engine
npm run lint
npm run build
npm run preview
```

Outils de debug/simulation :

```bash
SMOKE_TURNS=100 npm run smoke      # smoke test IA (50–200 tours)
npm run battle:sim -- --help       # simulateur de combat/balance
```

Exécuter un test ciblé (sans lancer toute la suite) :

```bash
node --experimental-specifier-resolution=node --loader ./tools/tsSmokeLoader.mjs src/engine/tests/rng.spec.ts
```


## Plan du repo (où modifier quoi)

- `src/shared/` : types métier et utilitaires runtime partagés. Ne dépend de rien.
- `src/content/` : données statiques, scénarios, assets audio (UI seulement). Dépend uniquement de `src/shared/`.
- `src/engine/` : moteur de simulation déterministe (tour, IA, mouvement, combat, génération, sérialisation). Dépend de `src/shared/` et `src/content/`, mais **jamais** de `src/ui/`.
- `src/ui/` : React + React Three Fiber. Orchestration, écrans, rendu 3D, i18n, audio.
- `docs/` : specs et architecture. Garder la doc alignée avec le code lorsqu’on modifie des règles.

Entrées importantes :
- Boucle de tour : `src/engine/runTurn.ts` et `src/engine/turn/phases/*`.
- Commandes : `src/engine/commands.ts`.
- Sérialisation / sauvegardes : `src/engine/serialization.ts`, `src/engine/saveFormat.ts`.
- Scénarios : `src/content/scenarios/*`.


## Invariants non négociables

### 1) Déterminisme (moteur)

But : à `seed` identique et suite de commandes identique, l’état au tour N doit être identique (machine / navigateur / moment indépendants).

Règles (voir `docs/architecture/determinism-and-state.md`) :

- Interdiction d’utiliser `Math.random()`, `crypto.randomUUID()`, ou toute source non déterministe dans `src/engine`, `src/shared`, `src/content`.
- Interdiction d’utiliser `Date.now()` / `performance.now()` pour influencer la logique moteur. Le temps logique est discret (`state.day`).
  - Exception : rendu/animation UI (ex. interpolation visuelle) et métadonnées hors-état (ex. horodatage d’export) peuvent utiliser le temps système.
- RNG unique : utiliser la classe `RNG` (`src/engine/rng.ts`). Le curseur RNG (`rngState`) est persisté dans le `GameState`.
- Ordre d’itération stable : tout ce qui consomme la RNG doit itérer dans un ordre déterministe.
  - Toujours trier par `id` (ou appliquer `canonicalizeState`) avant une boucle qui consomme la RNG.
  - Si vous itérez des clés d’objets/records (`Object.keys`, `Object.entries`), triez explicitement les clés.
- Isolation locale de RNG : les sous-systèmes “complexes” (ex. résolution de bataille) doivent dériver une RNG locale (seed stable) pour éviter l’effet papillon sur le reste du tour.

Points d’attention :
- Ne changez pas l’ordre des phases de `runTurn` sans mettre à jour `docs/specs/turn-loop.md` et les tests.
- Ne changez pas l’ordre des logs/messages si cela modifie la consommation RNG ou les ID générés.


### 2) Immutabilité (pas de mutation d’état)

Le moteur adopte un pattern “Redux-like” : l’état n’est jamais muté in-place. En dev/test, `deepFreezeDev` peut geler des objets pour détecter les mutations (`src/engine/state/immutability.ts`).

Règles pratiques :
- Ne jamais modifier `state`, `fleet`, `system`, `army`, etc. Retourner de nouveaux objets via spread (`{ ...obj, x: ... }`) et de nouveaux tableaux via `map`/`filter`/`concat`.
- Éviter les opérations mutantes sur des tableaux provenant de l’état : `push`, `pop`, `splice`, `reverse`, `sort`, etc.
  - Si vous devez trier : triez une copie (`[...arr].sort(...)` ou `arr.slice().sort(...)`).
  - L’ESLint signale `sort()` in-place (warning) : considérez-le comme une contrainte réelle.


### 3) Canonicalisation (ordre stable des collections)

`canonicalizeState` (`src/engine/state/canonicalize.ts`) impose un ordre canonique (lexicographique par `id`, ou `day` puis `id` pour logs/messages). C’est un pilier du déterminisme.

Si vous ajoutez une nouvelle collection dans `GameState` (ex. `something[]`) qui est :
- itérée pendant un tour, ou
- sérialisée et comparée,

alors vous devez très probablement :
- l’ajouter à `canonicalizeState` et `isCanonical`,
- décider d’un tri stable (souvent par `id`),
- adapter les tests de déterminisme/serialization si nécessaire.


### 4) Format de sauvegarde / sérialisation

Tout ce qui est dans `GameState` doit rester JSON-sérialisable (types simples / objets / tableaux). Pas d’instances Three.js dans l’état : utiliser `Vec3` (`src/engine/math/vec3.ts`).

Si vous modifiez un type sérialisé (ajout/changement de champ), mettre à jour de manière cohérente :
- `src/shared/types.ts` (types runtime),
- `src/engine/saveFormat.ts` (DTO + `SAVE_VERSION` si breaking),
- `src/engine/serialization.ts` (serialize/deserialize + validations/sanitization),
- `docs/specs/save-format.md` (si la structure change),
- les tests associés (ex. `src/engine/tests/serializationRobustness.spec.ts`).

Règle : lecture tolérante, écriture stricte. Éviter de casser la compatibilité ascendante sans migration explicite.


### 5) Frontières de dépendances

Respecter strictement :
- `src/shared` n’importe rien.
- `src/content` dépend uniquement de `src/shared`.
- `src/engine` dépend de `src/shared` et `src/content`, mais jamais de `src/ui` (ni DOM).
- `src/ui` peut orchestrer l’ensemble.

Les assets audio (`src/content/audio/*`) sont **UI-only** : le moteur ne doit pas y référencer.


### 6) Imports et exécution Node

Le projet est en ESM (`"type": "module"`). Les tests et scripts Node utilisent un loader TypeScript (`tools/tsSmokeLoader.mjs`).

Contraintes :
- Préférer des imports relatifs (comme le code existant). Éviter d’introduire l’alias `@/` : il est configuré côté TS/Vite, mais **n’est pas résolu** par le runner Node actuel.
- Les spec files sont exécutés directement avec Node (pas de Jest/Vitest). Écrire des tests “script” avec `node:assert`.


## Conventions de code

TypeScript :
- Dans `src/engine`, viser la compatibilité `tsconfig.strict.json` (strict). Éviter `any` (ou l’isoler et le justifier).
- Conserver des fonctions pures dans l’engine (entrées → sorties), et passer les dépendances (RNG, contexte de tour) explicitement.

IDs :
- Pour générer des IDs gameplay : utiliser `rng.id(prefix)` (format `prefix_uuid`).
- Pour afficher des IDs à l’écran/log : utiliser `shortId()` (`src/engine/idUtils.ts`).

Logs :
- Éviter le bruit en console. Préférer `src/shared/devLogger.ts` (niveau configurable via `VITE_LOG_LEVEL`) et garder les logs lourds derrière un flag dev.

UI / i18n :
- Ne pas hardcoder du texte UI : utiliser `useI18n().t(key, params)`.
- Si vous ajoutez une clé, la définir dans `src/ui/i18n/locales/en.ts` ET `src/ui/i18n/locales/fr.ts`.


## Patterns de contribution (ce qui marche bien ici)

1) Identifier la couche : `engine` (règles), `ui` (présentation/UX), `content` (données/scénarios).
2) Lire les docs associées (`docs/architecture/*`, `docs/specs/*`) avant de modifier une règle.
3) Faire des changements minimaux, sans refactor gratuit.
4) Ajouter/adapter un test script si la logique change.
5) Exécuter au minimum `npm run typecheck` et `npm test`.


## Recettes fréquentes

### Ajouter un scénario

- Créer un template TS dans `src/content/scenarios/templates/<nom>.ts` (export default).
- L’enregistrer dans `src/content/scenarios/registry.ts` (tableau `templatesToLoad`).
- Vérifier que `validateScenarioV1` accepte la structure (schemaVersion, meta, generation, setup, rules, objectives).
- Mettre à jour `docs/README.md` si vous ajoutez une nouvelle spec de scénario.


### Modifier l’équilibrage combat

- Les stats sont dans `src/content/data/static.ts` (`SHIP_STATS`, constantes combat, etc.).
- Le moteur combat est dans `src/engine/battle/*`.
- Utiliser `npm run battle:sim` pour obtenir des taux de victoire et des métriques (et garder le changement déterministe).


## Checklist avant PR

- `npm run typecheck`
- `npm test`
- Si changement moteur : `npm run typecheck:strict`
- Si changement de style/refactor : `npm run lint`
- Si changement UI/build : `npm run build` (et éventuellement `npm run preview`)

Dans la description/summary, mentionner explicitement :
- l’impact (ou non) sur le déterminisme,
- toute modification de format de sauvegarde (`SAVE_VERSION`),
- les tests exécutés.
