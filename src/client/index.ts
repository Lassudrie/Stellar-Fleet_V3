import { buildScenario, SCENARIO_TEMPLATES } from '../content/scenarios';
import { GameEngine } from '../engine/GameEngine';
import { generateWorld } from '../engine/worldgen/worldGenerator';
import { createScenarioView, syncSpaceViewWithState } from '../viewer';

const DEFAULT_SEED = 42;
const DEFAULT_TIME_SCALE = 0;
const TIME_SCALE_MIN = -5;
const TIME_SCALE_MAX = 5;

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
const scenarioSelect = getElement<HTMLSelectElement>('#scenario-select');
const seedInput = getElement<HTMLInputElement>('#seed-input');
const timeScaleInput = getElement<HTMLInputElement>('#time-scale');
const timeScaleValue = getElement<HTMLDivElement>('#time-scale-value');
const applyButton = getElement<HTMLButtonElement>('#apply-button');
const scenarioDescription = getElement<HTMLParagraphElement>('#scenario-description');

const scenarioById = new Map(SCENARIO_TEMPLATES.map(template => [template.id, template]));

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

const readSeed = (): number => Math.floor(parseNumberParam(seedInput.value, DEFAULT_SEED));
const readTimeScale = (): number => clamp(parseNumberParam(timeScaleInput.value, DEFAULT_TIME_SCALE), TIME_SCALE_MIN, TIME_SCALE_MAX);

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
  updateUrlParams(next.scenarioId, next.seed, next.timeScale);
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
timeScaleInput.value = String(initialTimeScale);
timeScaleValue.textContent = formatTimeScale(initialTimeScale);
updateDescription(initialScenarioId);

let runtime = createRuntime(initialScenarioId, initialSeed, initialTimeScale);

applyButton.addEventListener('click', () => {
  const nextScenarioId = resolveScenarioId(scenarioSelect.value);
  scenarioSelect.value = nextScenarioId;
  const nextSeed = readSeed();
  const nextTimeScale = readTimeScale();
  seedInput.value = String(nextSeed);
  timeScaleInput.value = String(nextTimeScale);
  timeScaleValue.textContent = formatTimeScale(nextTimeScale);
  runtime = applyScenario(runtime, nextScenarioId, nextSeed, nextTimeScale);
});

scenarioSelect.addEventListener('change', () => {
  updateDescription(resolveScenarioId(scenarioSelect.value));
});

seedInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  applyButton.click();
});

const onTimeScaleChange = () => {
  const value = readTimeScale();
  timeScaleInput.value = String(value);
  timeScaleValue.textContent = formatTimeScale(value);
  runtime.timeScale = value;
  runtime.view.setTimeScaleDaysPerSecond(value);
  updateUrlParams(runtime.scenarioId, runtime.seed, runtime.timeScale);
};

timeScaleInput.addEventListener('input', onTimeScaleChange);

timeScaleInput.addEventListener('change', onTimeScaleChange);

const resize = () => {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  runtime.view.resize(width, height);
};

window.addEventListener('resize', resize);
resize();

const pointerState: PointerState = {
  active: false,
  lastX: 0,
  lastY: 0,
  mode: 'orbit'
};

canvas.addEventListener('contextmenu', event => event.preventDefault());

canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  pointerState.active = true;
  pointerState.lastX = event.clientX;
  pointerState.lastY = event.clientY;
  pointerState.mode = event.button === 2 || event.shiftKey ? 'pan' : 'orbit';
});

canvas.addEventListener('pointermove', event => {
  if (!pointerState.active) return;
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
  if (!pointerState.active) return;
  pointerState.active = false;
  canvas.releasePointerCapture(event.pointerId);
};

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
  'wheel',
  event => {
    event.preventDefault();
    const delta = clamp(event.deltaY, -240, 240);
    runtime.view.applyZoomDelta(-delta / 240);
  },
  { passive: false }
);

let lastTime = performance.now();
const frame = (time: number) => {
  const dt = (time - lastTime) / 1000;
  lastTime = time;
  const dayOverride = Math.abs(runtime.timeScale) < 1e-6 ? runtime.engine.state.day : undefined;
  runtime.view.update(dt, dayOverride);
  window.requestAnimationFrame(frame);
};

window.requestAnimationFrame(frame);
