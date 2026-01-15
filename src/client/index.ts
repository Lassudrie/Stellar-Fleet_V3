import { buildScenario, SCENARIO_TEMPLATES } from '../content/scenarios';
import { GameEngine } from '../engine/GameEngine';
import { generateWorld } from '../engine/worldgen/worldGenerator';
import { createScenarioView, syncSpaceViewWithState } from '../viewer';

const DEFAULT_SEED = 42;
const DEFAULT_TIME_SCALE = 0;
const TIME_SCALE_MIN = -5;
const TIME_SCALE_MAX = 5;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 32;
const TAP_SLOP = 10;

type DragMode = 'orbit' | 'pan';

type PointerState = {
  active: boolean;
  lastX: number;
  lastY: number;
  mode: DragMode;
};

type Runtime = {
  scenarioId: string;
  seed: number;
  timeScale: number;
  engine: GameEngine;
  view: ReturnType<typeof createScenarioView>['view'];
  unsubscribe: () => void;
};

const parseNumberParam = (value: string | null, fallback: number): number => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const formatTimeScale = (value: number): string => {
  const text = value.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
};

const getElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
};

const canvas = getElement<HTMLCanvasElement>('#galaxy');
const menuScreen = getElement<HTMLDivElement>('#menu-screen');
const hud = getElement<HTMLDivElement>('#hud');
const scenarioSelect = getElement<HTMLSelectElement>('#scenario-select');
const seedInput = getElement<HTMLInputElement>('#seed-input');
const menuTimeScaleInput = getElement<HTMLInputElement>('#time-scale-menu');
const hudTimeScaleInput = getElement<HTMLInputElement>('#time-scale-hud');
const menuTimeScaleValue = getElement<HTMLDivElement>('#time-scale-value-menu');
const hudTimeScaleValue = getElement<HTMLDivElement>('#time-scale-value-hud');
const startButton = getElement<HTMLButtonElement>('#start-button');
const menuButton = getElement<HTMLButtonElement>('#menu-button');
const scenarioDescription = getElement<HTMLParagraphElement>('#scenario-description');

const scenarioById = new Map(SCENARIO_TEMPLATES.map(template => [template.id, template]));
const timeScaleInputs = [menuTimeScaleInput, hudTimeScaleInput];
const timeScaleValues = [menuTimeScaleValue, hudTimeScaleValue];

const resolveScenarioId = (candidate: string | null): string => {
  if (candidate && scenarioById.has(candidate)) return candidate;
  return SCENARIO_TEMPLATES[0]?.id ?? '';
};

const updateDescription = (scenarioId: string): void => {
  const template = scenarioById.get(scenarioId);
  scenarioDescription.textContent = template?.meta.description ?? 'Scenario not found.';
};

const updateUrlParams = (scenarioId: string, seed: number, timeScale: number): void => {
  const params = new URLSearchParams();
  params.set('scenario', scenarioId);
  params.set('seed', String(seed));
  params.set('timeScale', formatTimeScale(timeScale));
  window.history.replaceState(null, '', `?${params.toString()}`);
};

const populateScenarioOptions = () => {
  scenarioSelect.textContent = '';
  SCENARIO_TEMPLATES.forEach(template => {
    const option = document.createElement('option');
    option.value = template.id;
    option.textContent = template.meta.title;
    scenarioSelect.appendChild(option);
  });
};

const setMenuVisible = (visible: boolean): void => {
  menuScreen.classList.toggle('hidden', !visible);
  hud.classList.toggle('hidden', visible);
};

const setTimeScaleUI = (value: number): void => {
  const text = formatTimeScale(value);
  timeScaleInputs.forEach(input => {
    input.value = String(value);
  });
  timeScaleValues.forEach(label => {
    label.textContent = text;
  });
};

const readSeed = (): number => Math.floor(parseNumberParam(seedInput.value, DEFAULT_SEED));
const readTimeScale = (value: string): number => clamp(parseNumberParam(value, DEFAULT_TIME_SCALE), TIME_SCALE_MIN, TIME_SCALE_MAX);

const createRuntime = (scenarioId: string, seed: number, timeScale: number): Runtime => {
  const scenario = buildScenario(scenarioId, seed);
  const { state } = generateWorld(scenario);
  const engine = new GameEngine(state);
  document.title = `${scenario.meta.title} | Stellar Fleet`;

  const { view } = createScenarioView({
    canvas,
    state: engine.state,
    scenario,
    viewOptions: {
      timeScaleDaysPerSecond: timeScale
    }
  });

  const unsubscribe = engine.subscribe(() => {
    syncSpaceViewWithState(view, engine.state);
  });

  return { scenarioId, seed, timeScale, engine, view, unsubscribe };
};

const applyScenario = (runtime: Runtime, scenarioId: string, seed: number, timeScale: number): Runtime => {
  runtime.unsubscribe();
  runtime.view.dispose();
  updateDescription(scenarioId);

  const next = createRuntime(scenarioId, seed, timeScale);
  return next;
};

const params = new URLSearchParams(window.location.search);
populateScenarioOptions();

const initialScenarioId = resolveScenarioId(params.get('scenario'));
if (!initialScenarioId) {
  throw new Error('No scenarios available to load.');
}

const initialSeed = Math.floor(parseNumberParam(params.get('seed'), DEFAULT_SEED));
const initialTimeScale = clamp(parseNumberParam(params.get('timeScale'), DEFAULT_TIME_SCALE), TIME_SCALE_MIN, TIME_SCALE_MAX);

scenarioSelect.value = initialScenarioId;
seedInput.value = String(initialSeed);
setTimeScaleUI(initialTimeScale);
updateDescription(initialScenarioId);
setMenuVisible(true);

let runtime: Runtime | null = null;

const resize = () => {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  if (runtime) {
    runtime.view.resize(width, height);
  }
};

const launchScenario = (scenarioId: string, seed: number, timeScale: number): Runtime => {
  const next = runtime ? applyScenario(runtime, scenarioId, seed, timeScale) : createRuntime(scenarioId, seed, timeScale);
  updateUrlParams(next.scenarioId, next.seed, next.timeScale);
  resize();
  return next;
};

const openMenu = () => {
  if (runtime) {
    scenarioSelect.value = runtime.scenarioId;
    seedInput.value = String(runtime.seed);
    setTimeScaleUI(runtime.timeScale);
    updateDescription(runtime.scenarioId);
  }
  setMenuVisible(true);
};

startButton.addEventListener('click', () => {
  const nextScenarioId = resolveScenarioId(scenarioSelect.value);
  scenarioSelect.value = nextScenarioId;
  const nextSeed = readSeed();
  const nextTimeScale = readTimeScale(menuTimeScaleInput.value);
  seedInput.value = String(nextSeed);
  setTimeScaleUI(nextTimeScale);
  runtime = launchScenario(nextScenarioId, nextSeed, nextTimeScale);
  setMenuVisible(false);
});

menuButton.addEventListener('click', openMenu);

scenarioSelect.addEventListener('change', () => {
  updateDescription(resolveScenarioId(scenarioSelect.value));
});

seedInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  startButton.click();
});

const onTimeScaleChange = (event: Event) => {
  const target = event.target as HTMLInputElement | null;
  const value = readTimeScale(target?.value ?? menuTimeScaleInput.value);
  setTimeScaleUI(value);
  if (!runtime) return;
  runtime.timeScale = value;
  runtime.view.setTimeScaleDaysPerSecond(value);
  updateUrlParams(runtime.scenarioId, runtime.seed, runtime.timeScale);
};

timeScaleInputs.forEach(input => {
  input.addEventListener('input', onTimeScaleChange);
  input.addEventListener('change', onTimeScaleChange);
});

window.addEventListener('resize', resize);
resize();

const pointerState: PointerState = {
  active: false,
  lastX: 0,
  lastY: 0,
  mode: 'orbit'
};

const touchPoints = new Map<number, { x: number; y: number }>();
let lastPinchDistance = 0;
let lastPinchCenter: { x: number; y: number } | null = null;
const tapState = {
  activeId: null as number | null,
  startX: 0,
  startY: 0,
  moved: false,
  lastTapTime: 0,
  lastTapX: 0,
  lastTapY: 0
};

const registerTap = (x: number, y: number) => {
  const now = performance.now();
  const delta = now - tapState.lastTapTime;
  const dist = Math.hypot(x - tapState.lastTapX, y - tapState.lastTapY);
  if (delta <= DOUBLE_TAP_MS && dist <= DOUBLE_TAP_DIST) {
    tapState.lastTapTime = 0;
    if (runtime) {
      runtime.view.focusAtScreen(x, y);
    }
    return;
  }
  tapState.lastTapTime = now;
  tapState.lastTapX = x;
  tapState.lastTapY = y;
};

const resetPinch = () => {
  lastPinchDistance = 0;
  lastPinchCenter = null;
};

const updatePinch = () => {
  if (!runtime || touchPoints.size < 2) {
    resetPinch();
    return;
  }
  const iterator = touchPoints.values();
  const first = iterator.next();
  const second = iterator.next();
  if (first.done || second.done) {
    resetPinch();
    return;
  }
  const pointA = first.value;
  const pointB = second.value;
  const centerX = (pointA.x + pointB.x) * 0.5;
  const centerY = (pointA.y + pointB.y) * 0.5;
  const distance = Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);

  if (lastPinchCenter) {
    runtime.view.applyPan(centerX - lastPinchCenter.x, centerY - lastPinchCenter.y);
  }

  if (lastPinchDistance > 0 && Number.isFinite(distance)) {
    const scale = distance / lastPinchDistance;
    if (scale > 0 && Number.isFinite(scale)) {
      runtime.view.applyZoomDelta(-Math.log2(scale));
    }
  }

  lastPinchCenter = { x: centerX, y: centerY };
  lastPinchDistance = distance;
};

canvas.addEventListener('contextmenu', event => event.preventDefault());

canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  if (event.pointerType === 'touch') {
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchPoints.size === 1) {
      tapState.activeId = event.pointerId;
      tapState.startX = event.clientX;
      tapState.startY = event.clientY;
      tapState.moved = false;
    } else {
      tapState.activeId = null;
    }
    if (touchPoints.size >= 2) {
      updatePinch();
    }
    return;
  }
  pointerState.active = true;
  pointerState.lastX = event.clientX;
  pointerState.lastY = event.clientY;
  pointerState.mode = event.button === 2 || event.shiftKey ? 'pan' : 'orbit';
});

canvas.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') {
    const point = touchPoints.get(event.pointerId);
    if (!point) return;
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (tapState.activeId === event.pointerId) {
      const dx = event.clientX - tapState.startX;
      const dy = event.clientY - tapState.startY;
      if (Math.hypot(dx, dy) > TAP_SLOP) {
        tapState.moved = true;
      }
    }
    if (!runtime) return;
    if (touchPoints.size === 1) {
      const deltaX = event.clientX - point.x;
      const deltaY = event.clientY - point.y;
      runtime.view.applyOrbit(-deltaX, -deltaY);
      return;
    }
    updatePinch();
    return;
  }

  if (!pointerState.active || !runtime) return;
  const deltaX = event.clientX - pointerState.lastX;
  const deltaY = event.clientY - pointerState.lastY;
  pointerState.lastX = event.clientX;
  pointerState.lastY = event.clientY;

  if (pointerState.mode === 'pan') {
    runtime.view.applyPan(deltaX, deltaY);
  } else {
    runtime.view.applyOrbit(-deltaX, -deltaY);
  }
});

const endDrag = (event: PointerEvent) => {
  if (event.pointerType === 'touch') {
    const wasSingleTouch = touchPoints.size === 1;
    touchPoints.delete(event.pointerId);
    if (tapState.activeId === event.pointerId) {
      const dx = event.clientX - tapState.startX;
      const dy = event.clientY - tapState.startY;
      const moved = tapState.moved || Math.hypot(dx, dy) > TAP_SLOP;
      tapState.activeId = null;
      tapState.moved = false;
      if (wasSingleTouch && !moved) {
        registerTap(event.clientX, event.clientY);
      }
    }
    if (touchPoints.size < 2) {
      resetPinch();
    }
    canvas.releasePointerCapture(event.pointerId);
    return;
  }
  if (!pointerState.active) {
    canvas.releasePointerCapture(event.pointerId);
    return;
  }
  pointerState.active = false;
  canvas.releasePointerCapture(event.pointerId);
};

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  event => {
    event.preventDefault();
    if (!runtime) return;
    const delta = clamp(event.deltaY, -240, 240);
    runtime.view.applyZoomDelta(-delta / 240);
  },
  { passive: false }
);

canvas.addEventListener('dblclick', event => {
  if (!runtime) return;
  runtime.view.focusAtScreen(event.clientX, event.clientY);
});

let lastTime = performance.now();
const frame = (time: number) => {
  const dt = (time - lastTime) / 1000;
  lastTime = time;
  if (runtime) {
    const dayOverride = Math.abs(runtime.timeScale) < 1e-6 ? runtime.engine.state.day : undefined;
    runtime.view.update(dt, dayOverride);
  }
  window.requestAnimationFrame(frame);
};

window.requestAnimationFrame(frame);
