import { GameEngine } from './GameEngine';
import { createEmptyAIState, getLegacyAiFactionId, planAiTick } from './ai';
import { RNG } from './rng';
import { buildScenario } from '../content/scenarios';
import { generateWorld } from './worldgen/worldGenerator';
import { Fleet, GameState, StarSystem, MS_PER_MINUTE } from '../shared/shared';
import { devLog } from '../shared/shared';
import { sorted } from '../shared/shared';

const parseMinuteCount = (): number => {
  const raw = process.env.SMOKE_MINUTES ?? process.env.SMOKE_TURNS ?? '100';
  const minutes = Number.parseInt(raw, 10);

  if (!Number.isInteger(minutes)) {
    throw new Error(`SMOKE_MINUTES must be an integer (received: ${raw})`);
  }

  if (minutes < 50 || minutes > 200) {
    throw new Error(`SMOKE_MINUTES must be between 50 and 200 (received: ${minutes})`);
  }

  return minutes;
};

const parseSeed = (): number => {
  const raw = process.env.SMOKE_SEED;
  if (raw === undefined || raw === '') {
    return 1337;
  }

  const seed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`SMOKE_SEED must be a safe integer (received: ${raw})`);
  }

  return seed;
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
  assertFiniteNumber(state.timeMs, 'state.timeMs');
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

    assertFiniteNumber(fleet.stateStartTimeMs, `fleet:${fleet.id}.stateStartTimeMs`);

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

  sorted(aiFactions, (a, b) => a.id.localeCompare(b.id)).forEach(faction => {
    const legacyState = faction.id === legacyAiFactionId ? state.aiState : undefined;
    const aiState = state.aiStates?.[faction.id] ?? legacyState ?? createEmptyAIState();
    const commands = planAiTick(state, faction.id, aiState, rngSnapshot);
    commandCount += commands.filter(cmd => cmd.type !== 'AI_UPDATE_STATE').length;
  });

  return commandCount;
};

const runSmokeTest = () => {
  const minutesToPlay = parseMinuteCount();
  const seed = parseSeed();
  const scenario = buildScenario('conquest_sandbox', seed);
  const { state } = generateWorld(scenario);
  const engine = new GameEngine(state);
  const minActiveTicks = Math.max(2, Math.floor(minutesToPlay / 25));

  let aiOrderTicks = 0;
  let totalAiOrders = 0;

  for (let tickIndex = 0; tickIndex < minutesToPlay; tickIndex += 1) {
    const previewRng = new RNG(engine.state.seed);
    previewRng.setState(engine.rng.getState());

    const ordersThisTick = countAiOrders(engine.state, previewRng);
    if (ordersThisTick > 0) {
      aiOrderTicks += 1;
      totalAiOrders += ordersThisTick;
    }

    engine.advanceTime(MS_PER_MINUTE);
    assertStateIsFinite(engine.state);

  }

  if (aiOrderTicks === 0) {
    throw new Error('AI inactivity detected: no orders were generated during the smoke run.');
  }

  if (aiOrderTicks < minActiveTicks) {
    throw new Error(`AI inactivity detected: orders were issued on ${aiOrderTicks} ticks (minimum ${minActiveTicks}).`);
  }

  // Final validation after completing the loop
  const totalRuntimeMinutes = (engine.state.timeMs - state.timeMs) / MS_PER_MINUTE;
  devLog(`AI smoke test completed: ${totalRuntimeMinutes} minutes with seed ${seed}.`);
  devLog(`AI issued ${totalAiOrders} commands across ${aiOrderTicks} active ticks.`);
};

runSmokeTest();
