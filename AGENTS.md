# Stellar Fleet — Agent Guide

This repo contains **Stellar Fleet**, a minimalist 3D space battle simulator (Vite/React + React Three Fiber) with a **strictly deterministic** simulation engine.

This file is a contract for coding agents: how to run checks, where to make changes, and the invariants you must not break.

## Must-know commands (match CI)

CI runs on **Node 20**. This repo pins Node via `.nvmrc` (currently **20.19.0**) and enforces Node/npm compatibility via `npm run check:runtime`.

```bash
npm run check:runtime
```

- Install (same as CI):

```bash
npm ci
```

- Validate before opening a PR:

```bash
npm run typecheck
npm test
```

- Useful checks (depending on your change):

```bash
npm run typecheck:strict   # strict on src/engine
npm run lint
npm run build
```

## Useful tools

- Smoke test (AI for many turns):

```bash
SMOKE_TURNS=100 npm run smoke
```

- Battle simulator / balance exploration:

```bash
npm run battle:sim -- --help
```

- Run a single test file:

```bash
npm run check:runtime && tsx src/engine/tests/rng.spec.ts
```

## Repo map (where to change what)

- `src/shared/`: shared runtime types/utilities. **Should not depend on other layers.**
- `src/content/`: static data, scenarios, (UI-only) audio assets. Depends only on `src/shared/`.
- `src/engine/`: deterministic simulation (turn loop, AI, movement, battle, generation, serialization). Depends on `src/shared/` and `src/content/`, **never** `src/ui/` or the DOM.
- `src/ui/`: React / R3F UI, screens, rendering, orchestration, i18n, audio.
- `docs/`: specs and architecture. Keep docs aligned when rules change.

Helpful entry points:
- Turn loop: `src/engine/runTurn.ts` and `src/engine/turn/phases/*`
- Commands: `src/engine/commands.ts`
- Saves/serialization: `src/engine/serialization.ts`, `src/engine/saveFormat.ts`
- Scenarios: `src/content/scenarios/*`

## Non-negotiable invariants

### 1) Determinism (engine/content/shared)

Goal: with the same `seed` and the same command sequence, the state at turn N must be identical (machine / browser / time independent).

Rules (see `docs/architecture/determinism-and-state.md`):
- Do not use `Math.random()`, `crypto.randomUUID()`, or any non-deterministic source in `src/engine`, `src/shared`, `src/content`.
- Do not use `Date.now()` / `performance.now()` to influence simulation logic. Logical time is discrete (`state.day`).
  - Exception: UI rendering/animation may use system time as long as it does not affect state.
- Use the single RNG: `RNG` (`src/engine/rng.ts`). The RNG cursor (`rngState`) is persisted in `GameState`.
- Keep iteration order stable for anything that consumes RNG:
  - Sort by `id` (or use `canonicalizeState`) before RNG-sensitive loops.
  - If iterating object keys (`Object.keys/entries`), sort keys explicitly.
- For complex subsystems (e.g. battle resolution), derive a local RNG from stable inputs to avoid “butterfly effects”.

### 2) Immutability (no in-place state mutation)

Engine updates are “Redux-like”: never mutate `state` in-place. In dev/test, `deepFreezeDev` may freeze objects to catch mutations.

Practical rules:
- Avoid mutating array ops on state-derived arrays (`push`, `pop`, `splice`, `reverse`, `sort`, …).
- If you must sort: sort a copy (`[...arr].sort(...)`).

### 3) Canonical ordering

`canonicalizeState` (`src/engine/state/canonicalize.ts`) enforces a canonical order (typically lexicographic by `id`). If you add a new `GameState` collection that is iterated or serialized/compared, you likely must update:
- `canonicalizeState` / `isCanonical`
- determinism/serialization tests

### 4) Save format / serialization

Everything in `GameState` must be JSON-serializable (plain objects/arrays/primitives). Never put Three.js instances into state; use engine math types (e.g. `Vec3`).

If you change serialized types:
- update DTO/types (`src/shared/types.ts`)
- update `SAVE_VERSION` and DTOs (`src/engine/saveFormat.ts`) if breaking
- update mapping/validation (`src/engine/serialization.ts`)
- update docs (`docs/specs/save-format.md`) when structure changes
- update relevant tests (e.g. `src/engine/tests/serializationRobustness.spec.ts`)

Rule of thumb: tolerant reads, strict writes.

### 5) Dependency boundaries

Respect:
- `src/shared` imports nothing from other layers
- `src/content` depends only on `src/shared`
- `src/engine` depends on `src/shared` and `src/content`, never `src/ui` / DOM
- `src/ui` may orchestrate everything

Audio assets under `src/content/audio/*` are **UI-only**: the engine must not reference them.

### 6) Imports + Node execution

The project is ESM (`"type": "module"`). Tests/scripts are executed with `tsx`.

Guidance:
- Prefer relative imports like the existing codebase.
- TS path alias `@/*` exists for bundling, but avoid introducing new hard dependencies on it in Node-executed code unless you’ve verified it works in the relevant script context.

## Contribution checklist (before PR)

- `npm run typecheck`
- `npm test`
- If engine logic changed: `npm run typecheck:strict`
- If refactor/style change: `npm run lint`
- If UI/build changed: `npm run build`

In the PR description, explicitly mention:
- determinism impact (or “no determinism impact”)
- any save-format changes (`SAVE_VERSION`)
- tests you ran

