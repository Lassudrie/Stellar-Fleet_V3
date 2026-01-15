# Stellar Fleet — Guide pour agents (etat de l'art)

Ce depot contient **Stellar Fleet**, un simulateur de batailles spatiales deterministe avec un **moteur strictement deterministe**.
Ce guide sert de contrat projet : invariants, frontieres d'architecture, commandes et meilleures pratiques.

## Principes directeurs

- Determinisme avant tout : meme seed + memes commandes => meme etat.
- Etat immuable : aucune mutation in-place.
- Ordre stable des collections et de la RNG.
- Frontieres de dependances strictes.
- Changements minimaux, sans refactor gratuit.
- Docs et tests alignes avec les regles.


## Commandes indispensables

La CI execute Node **20** (voir `.github/workflows/ci.yml`). Pour reproduire fidèlement la CI, privilégier Node 20+.

Installation (recommandé, identique à la CI) :

```bash
npm ci
```

Verifications (avant PR) :

```bash
npm run typecheck
npm test
```

Verifications utiles (selon le scope du changement) :

```bash
npm run typecheck:strict   # strict sur src/engine
npm run lint
```

Outils de debug/simulation :

```bash
SMOKE_TURNS=100 npm run smoke      # smoke test IA (50-200 tours)
npm run battle:sim -- --help       # simulateur de combat/balance
```

Executer un test cible (sans lancer toute la suite) :

```bash
node --experimental-specifier-resolution=node --loader ./tools/tsSmokeLoader.mjs src/engine/tests/rng.spec.ts
```


## Plan du repo (ou modifier quoi)

- `src/shared/` : types metier et utilitaires runtime partages. Ne depend de rien.
- `src/content/` : donnees statiques et scenarios. Depend uniquement de `src/shared/`.
- `src/engine/` : moteur de simulation deterministe (tour, IA, mouvement, combat, generation, serialisation). Depend de `src/shared/` et `src/content/`.
- `docs/` : specs et architecture. Garder la doc alignee avec le code lorsqu'on modifie des regles.

Entrees importantes :
- Boucle de tour : `src/engine/runTurn.ts` et `src/engine/turn/phases/*`.
- Commandes : `src/engine/commands.ts`.
- Serialisation / sauvegardes : `src/engine/serialization.ts`, `src/engine/saveFormat.ts`.
- Scenarios : `src/content/scenarios/*`.


## Invariants non negociables

### 1) Determinisme (moteur)

But : a `seed` identique et suite de commandes identique, l'etat au tour N doit etre identique (machine / navigateur / moment independants).

Regles (voir `docs/architecture/determinism-and-state.md`) :

- Interdiction d'utiliser `Math.random()`, `crypto.randomUUID()`, ou toute source non deterministe dans `src/engine`, `src/shared`, `src/content`.
- Interdiction d'utiliser `Date.now()` / `performance.now()` pour influencer la logique moteur. Le temps logique est discret (`state.day`).
  - Exception : metadonnees hors-etat (ex. horodatage d'export) peuvent utiliser le temps systeme.
- RNG unique : utiliser la classe `RNG` (`src/engine/rng.ts`). Le curseur RNG (`rngState`) est persiste dans le `GameState`.
- Ordre d'iteration stable : tout ce qui consomme la RNG doit iterer dans un ordre deterministe.
  - Toujours trier par `id` (ou appliquer `canonicalizeState`) avant une boucle qui consomme la RNG.
  - Si vous iterez des cles d'objets/records (`Object.keys`, `Object.entries`), triez explicitement les cles.
- Isolation locale de RNG : les sous-systemes “complexes” (ex. resolution de bataille) doivent deriver une RNG locale (seed stable) pour eviter l'effet papillon sur le reste du tour.

Points d'attention :
- Ne changez pas l'ordre des phases de `runTurn` sans mettre a jour `docs/specs/turn-loop.md` et les tests.
- Ne changez pas l'ordre des logs/messages si cela modifie la consommation RNG ou les ID generes.


### 2) Immutabilite (pas de mutation d'etat)

Le moteur adopte un pattern “Redux-like” : l'etat n'est jamais mute in-place. En dev/test, `deepFreezeDev` peut geler des objets pour detecter les mutations (`src/engine/state/immutability.ts`).

Regles pratiques :
- Ne jamais modifier `state`, `fleet`, `system`, `army`, etc. Retourner de nouveaux objets via spread (`{ ...obj, x: ... }`) et de nouveaux tableaux via `map`/`filter`/`concat`.
- Eviter les operations mutantes sur des tableaux provenant de l'etat : `push`, `pop`, `splice`, `reverse`, `sort`, etc.
  - Si vous devez trier : triez une copie (`[...arr].sort(...)` ou `arr.slice().sort(...)`).
  - L'ESLint signale `sort()` in-place (warning) : considerez-le comme une contrainte reelle.


### 3) Canonicalisation (ordre stable des collections)

`canonicalizeState` (`src/engine/state/canonicalize.ts`) impose un ordre canonique (lexicographique par `id`, ou `day` puis `id` pour logs/messages). C'est un pilier du determinisme.

Si vous ajoutez une nouvelle collection dans `GameState` (ex. `something[]`) qui est :
- iteree pendant un tour, ou
- serialisee et comparee,

alors vous devez tres probablement :
- l'ajouter a `canonicalizeState` et `isCanonical`,
- decider d'un tri stable (souvent par `id`),
- adapter les tests de determinisme/serialization si necessaire.


### 4) Format de sauvegarde / serialisation

Tout ce qui est dans `GameState` doit rester JSON-serialisable (types simples / objets / tableaux). Pas d'instances runtime non serialisables dans l'etat : utiliser `Vec3` (`src/engine/math/vec3.ts`).

Si vous modifiez un type serialise (ajout/changement de champ), mettre a jour de maniere coherente :
- `src/shared/types.ts` (types runtime),
- `src/engine/saveFormat.ts` (DTO + `SAVE_VERSION` si breaking),
- `src/engine/serialization.ts` (serialize/deserialize + validations/sanitization),
- `docs/specs/save-format.md` (si la structure change),
- les tests associes (ex. `src/engine/tests/serializationRobustness.spec.ts`).

Regle : lecture tolerante, ecriture stricte. Eviter de casser la compatibilite ascendante sans migration explicite.


### 5) Frontieres de dependances

Respecter strictement :
- `src/shared` n'importe rien.
- `src/content` depend uniquement de `src/shared`.
- `src/engine` depend de `src/shared` et `src/content`.


### 6) Imports et execution Node

Le projet est en ESM (`"type": "module"`). Les tests et scripts Node utilisent un loader TypeScript (`tools/tsSmokeLoader.mjs`).

Contraintes :
- Preferer des imports relatifs (comme le code existant). Eviter d'introduire l'alias `@/` : il est configure cote TS, mais **n'est pas resolu** par le runner Node actuel.
- Les spec files sont executes directement avec Node (pas de Jest/Vitest). Ecrire des tests “script” avec `node:assert`.


## Conventions de code

TypeScript :
- Dans `src/engine`, viser la compatibilite `tsconfig.strict.json` (strict). Eviter `any` (ou l'isoler et le justifier).
- Conserver des fonctions pures dans l'engine (entrees -> sorties), et passer les dependances (RNG, contexte de tour) explicitement.
- Prevoir des API deterministes et documentees pour les sous-systemes sensibles.

IDs :
- Pour generer des IDs gameplay : utiliser `rng.id(prefix)` (format `prefix_uuid`).
- Pour afficher des IDs a l'ecran/log : utiliser `shortId()` (`src/engine/idUtils.ts`).

Logs :
- Eviter le bruit en console. Preferer `logger` dans `src/shared/shared.ts` (niveau configurable via `VITE_LOG_LEVEL`) et garder les logs lourds derriere un flag dev.


## Workflow recommande (meilleures pratiques)

1) Identifier la couche : `engine` (regles), `content` (donnees/scenarios), `shared` (types/outils).
2) Lire la doc associee (`docs/architecture/*`, `docs/specs/*`) avant de modifier une regle.
3) Appliquer un changement minimal, sans refactor gratuit.
4) Ajouter/adapter un test script si la logique change.
5) Mettre a jour la doc si une regle, un format ou un comportement change.
6) Executer au minimum `npm run typecheck` et `npm test`.

Decision rapide avant de coder :
- Determinisme impacte ? (RNG, ordre d'iteration, logs)
- Save format impacte ? (`SAVE_VERSION`, serialize/deserialize)
- Nouvelle collection dans l'etat ? (canonicalize + tests)


## Tests et validation

- `npm run typecheck` + `npm test` (minimum).
- `npm run typecheck:strict` si modifications engine.
- `npm run lint` si touche au code partage/UI.
- `npm run battle:sim` pour l'equilibrage combat.
- `SMOKE_TURNS=100 npm run smoke` pour IA/turn loop.
- Comparaison visuelle ou golden images si rendu/asset modifie.


## Performance, qualite, observabilite

- Eviter les allocations lourdes dans les boucles de tour.
- Cache et pre-calculs deterministes preferes aux recalculs.
- Assurer un budget clair si un pipeline graphique est implique.
- Logguer via `logger` (niveaux), pas via `console`.
- Ajouter des points de debug visuel uniquement derriere un flag dev.


## Recettes frequentes

### Ajouter un scenario

- Creer un template TS dans `src/content/scenarios/templates/<nom>.ts` (export default).
- L'enregistrer dans `src/content/scenarios/registry.ts` (tableau `templatesToLoad`).
- Verifier que `validateScenarioV1` accepte la structure (schemaVersion, meta, generation, setup, rules, objectives).
- Mettre a jour `docs/README.md` si vous ajoutez une nouvelle spec de scenario.


### Modifier l'equilibrage combat

- Les stats sont dans `src/content/data/static.ts` (`SHIP_STATS`, constantes combat, etc.).
- Le moteur combat est dans `src/engine/battle/*`.
- Utiliser `npm run battle:sim` pour obtenir des taux de victoire et des metriques (et garder le changement deterministe).


## Checklist avant PR

- `npm run lint`
- `npm run typecheck`
- `npm run typecheck:strict`
- `npm test`

Dans la description/summary, mentionner explicitement :
- l'impact (ou non) sur le determinisme,
- toute modification de format de sauvegarde (`SAVE_VERSION`),
- les tests executes.


## Garde-fou architectural TypeScript (non-proliferation et organisation)
- Si aucune de ces conditions n'est remplie, la modification doit etre realisee dans un fichier existant coherent, quitte a refactorer ce fichier pour en ameliorer la lisibilite.

### Organisation par domaines stables, jamais par micro-concepts
- Interdit : un fichier par classe, un fichier par fonction, un fichier par systeme ECS ou tout decoupage micro-conceptuel.
- Obligatoire : des fichiers agregateurs par domaine fonctionnel stable (ex. `combatTerrestre`, `surfacePlanetaire`, `generationMonde`).
- Plusieurs types, fonctions et systemes homogenes doivent cohabiter dans un meme fichier des lors qu'ils relevent du meme domaine et de la meme responsabilite.

### Regles strictes pour les barrels (`index.ts`)
- Un seul `index.ts` par dossier est autorise et obligatoire pour exposer l'API publique du dossier.
- Interdit : tout import direct vers un fichier interne d'un dossier ; les consommateurs doivent passer exclusivement par le `index.ts` du dossier.
- Ajouter un export dans le barrel est toujours preferable a la creation d'un nouveau fichier lorsque la logique correspond au domaine deja couvert.

### Granularite minimale par fichier
- Un fichier doit contenir une unite fonctionnelle complete (plusieurs fonctions/objets/types coherents) et non une primitive isolee.
- Interdit : fichiers ne contenant qu'une fonction triviale ou un type isole.
- Mauvais exemples : `resolveX.ts`, `computeY.ts`, `applyEffect.ts`.
- Bons exemples : `groundCombat.ts` (regroupe resolution de combat terrestre, calculs de degats, effets de terrain), `planetSurface.ts` (gestion de la surface planetaire, interactions de terrain et ressources).

### Types, interfaces et implementations
- Interdit : separer systematiquement en `*.types.ts`, `*.interfaces.ts`, `*.impl.ts` lorsqu'il n'existe qu'une seule implementation.
- Autorise : la separation uniquement en cas de besoin structurel avere (plusieurs implementations concurrentes, decouplage fort necessaire, contrat public partage entre paquets).
- Par defaut, types, interfaces et logique associee cohabitent dans le meme fichier tant qu'une seule implementation existe.

### Convention de nommage des fichiers
- Les noms doivent etre nominaux et decrire le domaine fonctionnel (ex. `fleetOperations.ts`, `worldGeneration.ts`).
- Interdit : noms verbaux ou orientes action unique (ex. `compute`, `resolve`, `handleX`), car ils favorisent la fragmentation et la proliferation de micro-fichiers.

### Exemples pedagogiques
- **Bon dossier (organisation compacte)**
  - `combat/`
    - `groundCombat.ts` : types, systemes et utilitaires pour le combat terrestre regroupes.
    - `spaceCombat.ts` : logique spatiale complete, partage des types communs avec `groundCombat.ts` si necessaire.
    - `index.ts` : exports publics uniques du domaine combat.
- **Mauvais dossier (explosion de micro-fichiers)**
  - `combat/`
    - `resolveMelee.ts`, `resolveRanged.ts`, `computeDamage.ts`, `applyBuff.ts`, `unitTypes.ts`, `damageTypes.ts`, `index.ts` : chaque action dans son fichier, imports croises internes, logique eclatee et difficile a maintenir.

### Regle de conformite des agents
- Tout agent qui cree des fichiers `.ts` inutiles, contourne les barrels (`index.ts`), ou fragmente excessivement la logique est non conforme. Sa contribution doit etre rejetee ou retravaillee avant fusion.
