import { GameEngine } from './GameEngine';
import { createEmptyAIState, getLegacyAiFactionId, planAiTurn } from './ai';
import { RNG } from './rng';
import { buildScenario } from '../scenarios';
import { generateWorld } from '../services/world/worldGenerator';
import { Fleet, GameState, StarSystem } from '../types';

const parseTurnCount = (): number => {
  const raw = process.env.SMOKE_TURNS ?? '100';
  const turns = Number.parseInt(raw, 10);

  if (!Number.isInteger(turns)) {
    throw new Error(`SMOKE_TURNS must be an integer (received: ${raw})`);
  }

  if (turns < 50 || turns > 200) {
    throw new Error(`SMOKE_TURNS must be between 50 and 200 (received: ${turns})`);
  }

  return turns;
};

const assertFiniteNumber = (value: number, label: string) => {
  if (!Number.isFinite(value)) {
    throw new Error(`Detected invalid number (${label}): ${value}`);
  }
};

const assertVectorFinite = (vec: { x: number; y: number; z: number }, label: string) => {
  assertFiniteNumber(vec.x, `${label}.x`);
  assertFiniteNumber(vec.y, `${label}.y`);
  assertFiniteNumber(vec.z, `${label}.z`);
};

const assertStateIsFinite = (state: GameState) => {
  assertFiniteNumber(state.day, 'state.day');
  assertFiniteNumber(state.startYear, 'state.startYear');
  assertFiniteNumber(state.rngState, 'state.rngState');

  state.systems.forEach((system: StarSystem) => {
    assertVectorFinite(system.position, `system:${system.id}.position`);
    assertFiniteNumber(system.size, `system:${system.id}.size`);
  });

  state.fleets.forEach((fleet: Fleet) => {
    assertVectorFinite(fleet.position, `fleet:${fleet.id}.position`);
    if (fleet.targetPosition) {
      assertVectorFinite(fleet.targetPosition, `fleet:${fleet.id}.targetPosition`);
    }

    assertFiniteNumber(fleet.radius, `fleet:${fleet.id}.radius`);
    assertFiniteNumber(fleet.stateStartTurn, `fleet:${fleet.id}.stateStartTurn`);

    fleet.ships.forEach(ship => {
      assertFiniteNumber(ship.hp, `ship:${ship.id}.hp`);
      assertFiniteNumber(ship.maxHp, `ship:${ship.id}.maxHp`);
    });
  });
};

const countAiOrders = (state: GameState, rngSnapshot: RNG): number => {
  if (!state.rules.aiEnabled) return 0;

  const aiFactions = state.factions.filter(faction => faction.aiProfile);
  const legacyAiFactionId = getLegacyAiFactionId(state.factions);
  let commandCount = 0;

  aiFactions
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach(faction => {
      const legacyState = faction.id === legacyAiFactionId ? state.aiState : undefined;
      const aiState = state.aiStates?.[faction.id] ?? legacyState ?? createEmptyAIState();
      const commands = planAiTurn(state, faction.id, aiState, rngSnapshot);
      commandCount += commands.filter(cmd => cmd.type !== 'AI_UPDATE_STATE').length;
    });

  return commandCount;
};

const runSmokeTest = () => {
  const turnsToPlay = parseTurnCount();
  const seed = Date.now();
  const scenario = buildScenario('conquest_sandbox', seed);
  const { state } = generateWorld(scenario);
  const engine = new GameEngine(state);
  const minActiveTurns = Math.max(2, Math.floor(turnsToPlay / 25));

  let lastTurnWithAiOrders = state.day;
  let aiOrderTurns = 0;
  let totalAiOrders = 0;

  for (let turnIndex = 0; turnIndex < turnsToPlay; turnIndex += 1) {
    const previewRng = new RNG(engine.state.seed);
    previewRng.setState(engine.rng.getState());

    const ordersThisTurn = countAiOrders(engine.state, previewRng);
    if (ordersThisTurn > 0) {
      lastTurnWithAiOrders = engine.state.day;
      aiOrderTurns += 1;
      totalAiOrders += ordersThisTurn;
    }

    engine.advanceTurn();
    assertStateIsFinite(engine.state);

    const turnsSinceAiOrders = engine.state.day - lastTurnWithAiOrders;
  }

  if (aiOrderTurns === 0) {
    throw new Error('AI inactivity detected: no orders were generated during the smoke run.');
  }

  if (aiOrderTurns < minActiveTurns) {
    throw new Error(`AI inactivity detected: orders were issued on ${aiOrderTurns} turns (minimum ${minActiveTurns}).`);
  }

  // Final validation after completing the loop
  const totalRuntimeTurns = engine.state.day - state.day;
  console.log(`AI smoke test completed: ${totalRuntimeTurns} turns with seed ${seed}.`);
  console.log(`AI issued ${totalAiOrders} commands across ${aiOrderTurns} active turns.`);
};

runSmokeTest();
