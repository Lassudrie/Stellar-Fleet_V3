# Stellar Fleet

A minimalist 3D space battle simulator for mobile.

## Architecture

- **Engine**: Pure TypeScript, separated from UI.
- **State**: Immutable updates.
- **Determinism**: The simulation (world generation, combat, movement logs) is strictly deterministic based on the `seed` in `GameState`. `Math.random` and `Date.now` are prohibited in state-modifying logic. Visual animations (FleetRenderer) may use system time for smooth interpolation but do not affect logic.

## Tech Stack

- React 19 / Vite
- React Three Fiber / Three.js
- TailwindCSS