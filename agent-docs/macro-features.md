# Macro features segmentation

This document groups the repository into macro functional areas for parallel audits.
It is based on current code and docs only.

## 1) Shared types and cross cutting utilities
- Role: runtime types and helpers used across engine, content, and UI.
- Main locations:
  - `src/shared/shared.ts`
- Responsibilities:
  - Game domain types (GameState, Fleet, StarSystem, etc).
  - Shared helpers (sorting, ids, logging, misc utilities).
- Technical concerns:
  - API stability across layers.
  - Keep the shared layer dependency free.
  - Determinism safe helpers (stable ordering, no side effects).

## 2) Content data and scenarios
- Role: data driven configuration for gameplay and scenario setup.
- Main locations:
  - `src/content/data/static.ts`
  - `src/content/data/groundUnits.ts`
  - `src/content/scenarios/*`
  - `src/content/scenarios.ts`
  - `docs/specs/scenario-spec.md`
- Responsibilities:
  - Ship and ground unit stats.
  - Scenario templates, registry, and schema validation.
- Technical concerns:
  - Data consistency with engine rules.
  - Schema versioning and validation coverage.
  - Balance impacts from data changes.

## 3) World generation and initialization
- Role: generate the initial GameState from scenario and seed.
- Main locations:
  - `src/engine/worldgen/*`
  - `src/engine/world.ts`
  - `src/engine/planets.ts`
  - `src/engine/planetSurface.ts`
  - `src/ui/workers/surfaceMapWorker.ts`
  - `docs/specs/world-generation.md`
  - `docs/specs/stellar-astro-generation.md`
  - `docs/specs/planet-map-v1.md`
  - `docs/specs/surface-view.md`
  - `docs/specs/worldgen-audit-log.md`
- Responsibilities:
  - Seeded RNG world generation (systems, planets, surface descriptors).
  - Scenario driven setup (factions, starting fleets, territory allocation).
  - Progress reporting and audit logs.
  - Bootstrap worker path for new game and load flows.
- Technical concerns:
  - Determinism and stable ordering.
  - Performance with large system counts or surface maps.
  - Worker message size and error handling.

## 4) Core engine, turn loop, and determinism
- Role: orchestrate simulation phases and maintain immutable deterministic state.
- Main locations:
  - `src/engine/GameEngine.ts`
  - `src/engine/runTurn.ts`
  - `src/engine/state.ts`
  - `src/engine/rng.ts`
  - `src/engine/commands.ts`
  - `docs/specs/turn-loop.md`
  - `docs/specs/commands-and-player-actions.md`
  - `docs/architecture/determinism-and-state.md`
  - `docs/specs/id-generation.md`
- Responsibilities:
  - Turn loop orchestration and phase order.
  - Command application and state transitions.
  - Canonicalization and immutability guards.
  - RNG state and id generation support.
- Technical concerns:
  - Strict phase ordering and deterministic iteration.
  - RNG isolation and reproducibility.
  - No in place mutation of state collections.

## 5) Space and fleet simulation
- Role: fleets, movement, orbit logic, and space battle resolution.
- Main locations:
  - `src/engine/movement.ts`
  - `src/engine/orbit.ts`
  - `src/engine/battle.ts`
  - `src/engine/fleetDerived.ts`
  - `src/engine/world.ts`
  - `src/engine/spatialIndex.ts`
  - `src/engine/logistics/fuel.ts`
  - `docs/specs/movement.md`
  - `docs/specs/battle-system-v1.md`
  - `docs/specs/battle-balance-v1_1.md`
- Responsibilities:
  - Fleet movement and target handling.
  - Orbit placement and visual state hooks.
  - Space battle resolution and balance configuration.
  - Derived fleet stats and spatial queries.
  - Fuel quantization and logistics helpers.
- Technical concerns:
  - Deterministic combat ordering and RNG usage.
  - Performance with many fleets or ships.
  - Consistency between movement, orbit, and battle triggers.

## 6) Ground ops and territory control
- Role: armies, ground combat, bombardment, and system ownership changes.
- Main locations:
  - `src/engine/army.ts`
  - `src/engine/armyOps.ts`
  - `src/engine/ground.ts`
  - `src/engine/orbitalBombardment.ts`
  - `src/engine/conquest.ts`
  - `src/engine/territory.ts`
  - `docs/specs/ground-surface-combat-v1.md`
  - `docs/specs/ground-surface-combat-v2.md`
  - `docs/specs/army-ops.md`
  - `docs/specs/orbital-bombardment-v1.md`
  - `docs/specs/territory-and-borders.md`
- Responsibilities:
  - Army creation, deployment, and transport orders.
  - Ground combat resolution and attrition.
  - Orbital bombardment effects and logging.
  - Territory capture rules and border updates.
- Technical concerns:
  - Deterministic combat math and thresholds.
  - Correct ownership transitions under contest rules.
  - Interactions with fog of war and orbit state.

## 7) Fog of war and intel
- Role: visibility rules and intel surfaces for the player.
- Main locations:
  - `src/engine/fogOfWar.ts`
  - `docs/specs/fog-of-war-and-intel.md`
  - `src/ui/components/IntelGhosts.tsx`
- Responsibilities:
  - Compute visible systems and fleets per faction.
  - Track and display enemy sightings in the UI.
- Technical concerns:
  - Deterministic visibility checks.
  - Performance on large states.
  - Consistent rules between engine and UI rendering.

## 8) AI and automation
- Role: AI decision making and automation helpers.
- Main locations:
  - `src/engine/ai.ts`
  - `src/engine/aiDebugger.ts`
  - `src/engine/aiSmoke.ts`
  - `docs/specs/ai-system.md`
- Responsibilities:
  - AI planning and command generation.
  - Debug and smoke utilities for AI behavior.
- Technical concerns:
  - Deterministic behavior and ordering.
  - Controlled debug output volume.

## 9) Objectives and victory conditions
- Role: evaluate win conditions per scenario.
- Main locations:
  - `src/engine/objectives.ts`
  - `docs/specs/objectives.md`
- Responsibilities:
  - Evaluate elimination, domination, king of the hill, survival.
  - Resolve draw or multi faction outcomes.
- Technical concerns:
  - Ordering and tie break behavior.
  - Consistency with scenario config.

## 10) Serialization and save/load
- Role: JSON save format and DTO mapping for GameState.
- Main locations:
  - `src/engine/serialization.ts`
  - `docs/specs/save-format.md`
- Responsibilities:
  - Serialize and deserialize runtime state.
  - Versioned save format and validation.
  - Persist and restore RNG state.
- Technical concerns:
  - Backward compatibility and migration paths.
  - Validation robustness and error handling.

## 11) Rendering and 3D scene (R3F)
- Role: 3D rendering of galaxy, system, and surface views.
- Main locations:
  - `src/ui/components/GameScene.tsx`
  - `src/ui/components/Galaxy.tsx`
  - `src/ui/components/FleetRenderer.tsx`
  - `src/ui/components/TerritoryBorders.tsx`
  - `src/ui/components/IntelGhosts.tsx`
  - `src/ui/components/screens/SystemView3D.tsx`
  - `src/ui/components/screens/SurfaceView.tsx`
  - `src/ui/components/screens/systemViewLayout.ts`
  - `src/ui/components/screens/surfaceViewCore.ts`
  - `docs/specs/surface-view.md`
  - `docs/specs/planet-map-v1.md`
- Responsibilities:
  - R3F scene setup and render pipeline.
  - Galaxy map, system view, and surface view rendering.
  - Overlays for borders, intel, and battle visuals.
- Technical concerns:
  - Frame rate and draw call pressure.
  - Correct mapping from engine state to visuals.
  - Interpolation vs discrete turn state.

## 12) UI overlay, UX flow, and input
- Role: menus, panels, modals, and user input flow.
- Main locations:
  - `src/ui/App.tsx`
  - `src/ui/components/UI.tsx`
  - `src/ui/components/ui/*`
  - `src/ui/components/screens/*`
  - `src/ui/commands/processCommandResult.ts`
  - `src/ui/context/FleetNames.tsx`
  - `src/ui/format/units.ts`
  - `src/ui/i18n/*`
  - `src/ui/index.css`
  - `docs/specs/ui-controls-and-flows.md`
- Responsibilities:
  - Screen flow (menu, load, scenario select, game, system, surface).
  - In game panels and modals for fleets, battles, ground ops.
  - Command dispatch wiring and UI state management.
  - Localization strings and unit formatting.
- Technical concerns:
  - UI state consistency with engine updates.
  - Input edge cases and modal state transitions.
  - Localization coverage and key hygiene.

## 13) Camera and navigation
- Role: camera controls, bounds, and view transitions.
- Main locations:
  - `src/ui/components/GameCamera.tsx`
  - `src/ui/hooks/useMapControlsCamera.ts`
  - `docs/manual-camera-bounds.md`
  - `docs/specs/ui-controls-and-flows.md`
- Responsibilities:
  - Pan, zoom, and focus behavior.
  - Map bounds and camera constraints.
- Technical concerns:
  - Smooth transitions and input responsiveness.
  - Consistency between map bounds and layout.

## 14) Audio, assets, and localization data
- Role: UI audio assets and visual sprites.
- Main locations:
  - `src/content/audio/*`
  - `src/ui/audio/useButtonClickSound.ts`
  - `src/ui/assets/ships/*`
  - `src/ui/i18n/locales/*`
- Responsibilities:
  - Audio asset storage and usage by UI.
  - Ship sprites and UI art assets.
  - Locale string files.
- Technical concerns:
  - Asset loading and bundle size.
  - Consistent locale key usage.

## 15) Background workers and async bootstrapping
- Role: off main thread worldgen and surface map work.
- Main locations:
  - `src/ui/workers/index.ts`
  - `src/ui/workers/surfaceMapWorker.ts`
- Responsibilities:
  - Worker bootstrap for new game and load flows.
  - Surface map generation requests.
  - Progress and error reporting to UI.
- Technical concerns:
  - Message payload size and serialization costs.
  - Error propagation and recovery.

## 16) Tooling, tests, and documentation
- Role: test harnesses, scripts, build config, and specs.
- Main locations:
  - `tools/*`
  - `src/engine/tests/*`
  - `src/ui/ui.spec.ts`
  - `docs/*`
  - `package.json`
  - `vite.config.ts`
  - `tsconfig*.json`
  - `eslint.config.js`
  - `tailwind.config.cjs`
- Responsibilities:
  - Smoke tests, battle simulation, worldgen audits.
  - Specs and architecture documentation.
  - Build, lint, and typecheck configuration.
- Technical concerns:
  - Keeping tests aligned with deterministic behavior.
  - ESM loader and Node runtime constraints.
  - CI parity and script ergonomics.
