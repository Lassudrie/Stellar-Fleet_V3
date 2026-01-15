# 3D Viewer Foundations

## Goal
Provide a scalable, robust 3D visualization layer (galaxy -> system -> planet) with seamless multi-scale transitions, strict spatial coherence, and performance-first rendering.

## Plan of action
1. Reference frames (galaxy/system/planet) with deterministic transforms and explicit unit conversions.
2. Floating origin to keep render-space coordinates stable and prevent jitter.
3. Multi-pass renderer (galaxy/system/planet) with tuned near/far ranges per pass.
4. LOD + cross-fade + hysteresis to remove pop and oscillation.
5. Exponential zoom controller with adaptive pan speed and distance clamps.
6. Deterministic streaming + cache with seeded generation.

## Implementation map
- `src/viewer/spaceView.ts`: core viewer, reference frames, floating origin, multi-pass render, LOD and transitions, camera rig, streaming queue.
- `src/viewer/index.ts`: public barrel for the viewer domain.
- `buildGalaxyViewDataFromState`: converts `GameState` into render data (systems, planets, fleets).

## Integration notes
- Build data with `buildGalaxyViewDataFromState(state)`.
- Create `SpaceView` with a canvas and call `update(dtSeconds)` each frame.
- For deterministic time, pass `timeDaysOverride` into `update` or set `timeScaleDaysPerSecond`.
- Use `applyZoomDelta`, `applyOrbit`, `applyPan` to feed input.
- `resolveScenarioViewSettings` and `createScenarioView` apply scenario `view` defaults (focus + camera) without touching simulation state.
- Use `syncSpaceViewWithState` to refresh the render data after a state update.

## Local viewer run
- `npm run viewer:dev`
- Optional URL params: `?scenario=spiral_convergence&seed=42&timeScale=0.5`

## Determinism and performance
- No `Math.random` usage: colors and phases come from seeded RNG derived from the root seed.
- Rendering uses local scales per pass to avoid large float ranges and z-fighting.
- Transitions rely on screen-space metrics and hysteresis to avoid flicker.
