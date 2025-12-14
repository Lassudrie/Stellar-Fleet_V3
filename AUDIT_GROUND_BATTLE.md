# Audit of Ground Battle System

This document lists bugs and design issues detected during the audit of the Ground Battle system (`engine/conquest.ts` and related files).

## Critical Bugs

### 1. Hardcoded Factions in Combat Resolution
- **File:** `engine/conquest.ts`
- **Function:** `resolveGroundConflict`
- **Description:** The code explicitly filters armies by faction ID `'blue'` and `'red'`.
- **Impact:** Factions with other IDs (e.g., `'green'`, `'yellow'`, custom factions) are ignored. Their armies contribute 0 power to the battle, resulting in a stalemate (Power 0 vs 0). These factions cannot conquer systems or defend themselves effectively.
- **Snippet:**
  ```typescript
  const blueArmies = armiesOnGround.filter(a => a.factionId === 'blue');
  const redArmies = armiesOnGround.filter(a => a.factionId === 'red');
  ```

### 2. Hardcoded Factions in Orbital Contestation
- **File:** `engine/conquest.ts`
- **Function:** `resolveGroundConflict` (Orbital Contestation Logic)
- **Description:** The check for orbital supremacy specifically looks for `'blue'` and `'red'` fleets.
- **Impact:** Factions other than Blue and Red cannot enforce orbital contestation. If a Green fleet is in orbit, it will not prevent a Yellow faction from conquering the system.
- **Snippet:**
  ```typescript
  const hasBlueFleet = state.fleets.some(f => f.factionId === 'blue' ...);
  const hasRedFleet = state.fleets.some(f => f.factionId === 'red' ...);
  ```

### 3. Unopposed Conquest Logic Flaw
- **File:** `engine/conquest.ts`
- **Function:** `resolveGroundConflict`
- **Description:** The logic to detect unopposed conquest relies on `blueCount` and `redCount`.
- **Impact:** If a faction other than Blue or Red lands on an empty planet, `blueCount` and `redCount` are both 0. The code falls through to the combat block, resulting in a draw instead of an unopposed victory.

## Visual & UI Bugs

### 4. Hardcoded Colors in Ownership Update
- **File:** `engine/turn/phases/05_ground.ts`
- **Function:** `phaseGround`
- **Description:** When a system changes ownership, its color is updated using a hardcoded check.
- **Impact:** If a faction other than Blue wins a system, the system color defaults to Red (`COLORS.red`).
- **Snippet:**
  ```typescript
  color: result.winnerFactionId === 'blue' ? COLORS.blue : COLORS.red
  ```

### 5. Hardcoded Factions in UI
- **Files:** `components/UI.tsx`, `components/ui/SystemContextMenu.tsx`
- **Description:** The UI only calculates and displays ground forces for `'blue'` and `'red'`.
- **Impact:** Players controlling other factions cannot see their ground force summary in the UI.

## Logic & Design Issues

### 6. "Boots on the Ground" Violation / Zero-Troop Conquest
- **File:** `engine/conquest.ts`
- **Description:** If the winner suffers heavy attrition that destroys all their remaining armies, `conquestOccurred` is still set to `true`.
- **Impact:** A system can be conquered and flip ownership even if 0 troops remain alive to occupy it. This contradicts the code comment: *"A system can never change owner without at least one Army deployed on the ground"*.

### 7. Attrition Balancing
- **File:** `engine/conquest.ts`
- **Description:** Attrition is calculated as `floor((LoserPower / MIN_ARMY_STRENGTH) * 0.5)`.
- **Impact:** If the loser has less than 20,000 power (2x `MIN_ARMY_STRENGTH`), the winner suffers 0 casualties. This makes small-scale skirmishes risk-free for the winner.
