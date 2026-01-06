# Ground battle v2 implementation plan

Goal: implement the v2 ground surface combat spec and keep determinism, save format, and UI in sync.

## Phase 0 - Data model + constants
- Update `src/shared/shared.ts`:
  - Army: add morale, fatigue, rangeMin/rangeMax, projectionRange, lastCombatTurn, landingOrder, groundOrders.
  - Settlement control state type (settlementControl map).
  - GroundBuilding tags if needed (supply_node, fortification).
- Update `src/content/data/groundUnits.ts`:
  - Add baseMorale, baseFatigue, rangeMin/rangeMax, projectionRange, landingResistance, antiOrbital, tags.
- Update `src/engine/state.ts`:
  - Canonicalize settlementControl ordering.
  - Validate new collections in isCanonical if needed.

## Phase 1 - Save format + serialization
- Update `src/engine/saveFormat.ts` and `src/engine/serialization.ts`:
  - Add new Army fields, settlementControl, landingOrder, groundOrders.
  - Add validation/sanitization for new fields.
  - Bump `SAVE_VERSION` and update `docs/specs/save-format.md`.

## Phase 2 - Engine core (phaseGround)
- Landing phase (new):
  - Add landing resolution in `src/engine/runTurn.ts` or `src/engine/ground.ts`.
  - Compute landing losses per hex, apply before placement.
  - Validate stacking cap and passable rules (amphibious exception).
- Supply:
  - Keep BFS, sources from settlementControl + ground buildings.
  - Apply supplyFactor + attack/def penalties in combat.
- ZOC + projection:
  - ZOC from projectionRange (members > 0, morale >= break).
  - Entering ZOC stops movement and can force assault.
- Movement:
  - MPeff = baseMP * condition * supply * fatigue.
  - Friendly pass cost x2; enemy hex blocked.
  - Stacking cap 10 on destination.
  - Apply fatigue after movement.
- Combat (multi attackers):
  - Group attackers by defender; validate range + LoS.
  - Compute AttackPower/DefensePower with RNG per engagement.
  - Distribute attacker losses by contribution.
  - Apply morale/condition loss, rout rules, fatigue add.
- Capture + victory:
  - Update settlementControl (capture if no enemy ZOC).
  - Evaluate body victory; apply post-battle morale cap + fatigue add.
  - Update body/system ownership and logs.
- Orbital interactions:
  - Tag bombarded hex per turn.
  - Apply anti-orbital mitigation to bombardment and landing losses.

## Phase 3 - Commands
- Add `ORDER_GROUND_LAND` in `src/engine/commands.ts` + `src/engine/GameEngine.ts` types.
- Update `ORDER_GROUND_MOVE` / `ORDER_GROUND_ATTACK` to write `groundOrders`.
- Keep `CANCEL_GROUND_ORDER` for move/attack only.

## Phase 4 - UI alignment
- Surface view:
  - Landing selection UI (hex pick per unit) in `src/ui/components/screens/surfaceViewCore.ts`.
  - Overlays: ZOC, supply, stacking count, settlement control, bombardedThisTurn.
  - Unit panel: morale, fatigue, condition, supply, range.
- System + galaxy views:
  - Settlement control ratio and ground combat badge in `src/ui/components/Galaxy.tsx` and `src/ui/components/screens/SystemView3D.tsx`.
  - Ground ops modal updates in `src/ui/components/ui/GroundOpsModal.tsx`.
- i18n updates in `src/ui/i18n/locales/en.ts` and `src/ui/i18n/locales/fr.ts`.

## Phase 5 - AI
- Update `src/engine/ai.ts`:
  - Landing zone selection (avoid stacking, prioritize settlements).
  - Attack priorities (settlements first, then units).
  - Retreat/abort landing decisions by profile.

## Phase 6 - Tests + validation
- Add / update tests in `src/engine/tests/engine.spec.ts`:
  - Landing losses (contested orbit, bombarded hex, anti-orbital).
  - Stacking penalty and cap.
  - Settlement capture rules (no enemy ZOC, control persists).
  - Victory conditions (all settlements, no-settlement bodies).
- Performance test for 200 units and pathfinding cap.
- Smoke sim for a multi-turn ground battle.

## Phase 7 - Docs sync
- Ensure `docs/specs/turn-loop.md`, `docs/specs/commands-and-player-actions.md`, and `docs/specs/save-format.md` match implementation.

## Dependencies / risks
- Save version bump blocks old saves (expected).
- UI landing selection depends on surface map readiness.
- Determinism requires stable sorting in every new loop.
