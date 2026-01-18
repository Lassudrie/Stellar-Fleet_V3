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
const PINCH_ZOOM_BOOST = 40;
const PINCH_JITTER_THRESHOLD = 0.015;
let debugEnabled = true;

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

const formatMeters = (value: number): string => {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}e12 m`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}e9 m`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}e6 m`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}e3 m`;
  return `${value.toFixed(0)} m`;
};

const formatKilometers = (valueMeters: number | null | undefined): string => {
  if (!Number.isFinite(valueMeters ?? NaN)) return 'n/a';
  return `${((valueMeters ?? 0) / 1000).toFixed(1)} km`;
};

const formatVec3 = (value: { x: number; y: number; z: number } | null | undefined): string => {
  if (!value) return 'n/a';
  return `(${formatMeters(value.x)}, ${formatMeters(value.y)}, ${formatMeters(value.z)})`;
};

const getCanvasPoint = (event: MouseEvent | PointerEvent): { x: number; y: number } => {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

const getElement = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
};

const canvas = getElement<HTMLCanvasElement>('#galaxy');
const menuScreen = getElement<HTMLDivElement>('#menu-screen');
const hud = getElement<HTMLDivElement>('#hud');
const debugOverlay = getElement<HTMLDivElement>('#debug-overlay');
const debugOverlayToggle = getElement<HTMLButtonElement>('#debug-overlay-toggle');
const debugOverlayContent = getElement<HTMLPreElement>('#debug-overlay-content');
const labelLayer = getElement<HTMLDivElement>('#label-layer');
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
const labelNodes = new Map<string, HTMLDivElement>();
const visibleLabelIds = new Set<string>();

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
  if (debugEnabled) {
    params.set('debug', '1');
  }
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
  labelLayer.classList.toggle('hidden', visible);
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

const clearLabels = (): void => {
  labelNodes.clear();
  labelLayer.textContent = '';
};

const updateLabels = (): void => {
  if (!runtime || labelLayer.classList.contains('hidden')) return;

  const labels = runtime.view.getScreenLabels();
  visibleLabelIds.clear();

  labels.forEach(label => {
    visibleLabelIds.add(label.id);
    let node = labelNodes.get(label.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'label';
      labelLayer.appendChild(node);
      labelNodes.set(label.id, node);
    }
    if (node.textContent !== label.name) {
      node.textContent = label.name;
    }
    node.dataset.kind = label.kind;
    node.style.left = `${Math.round(label.x)}px`;
    node.style.top = `${Math.round(label.y)}px`;
    node.style.opacity = '1';
    node.style.display = 'block';
  });

  labelNodes.forEach((node, id) => {
    if (visibleLabelIds.has(id)) return;
    node.style.display = 'none';
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
  clearLabels();
  updateDescription(scenarioId);

  const next = createRuntime(scenarioId, seed, timeScale);
  return next;
};

const params = new URLSearchParams(window.location.search);
const debugParam = params.get('debug');
debugEnabled = debugParam === null ? true : debugParam === '1';
debugOverlay.classList.toggle('hidden', !debugEnabled);
const debugCollapsedStorageKey = 'stellarFleet:debugOverlayCollapsed';
const initialDebugCollapsed = localStorage.getItem(debugCollapsedStorageKey) === '1';
debugOverlay.classList.toggle('is-collapsed', initialDebugCollapsed);
debugOverlayToggle.textContent = initialDebugCollapsed ? 'Show' : 'Hide';
debugOverlayToggle.addEventListener('click', () => {
  const nextCollapsed = !debugOverlay.classList.contains('is-collapsed');
  debugOverlay.classList.toggle('is-collapsed', nextCollapsed);
  debugOverlayToggle.textContent = nextCollapsed ? 'Show' : 'Hide';
  localStorage.setItem(debugCollapsedStorageKey, nextCollapsed ? '1' : '0');
});
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

const updateDebugOverlay = () => {
  if (!debugEnabled) return;
  if (!runtime) {
    debugOverlayContent.textContent = 'Stage: menu';
    return;
  }
  const info = runtime.view.getDebugInfo();
  const bodyInfo = info.activeBodyInfo;
  const targetDistanceMeters =
    info.targetMeters && info.cameraMeters
      ? Math.hypot(
          info.cameraMeters.x - info.targetMeters.x,
          info.cameraMeters.y - info.targetMeters.y,
          info.cameraMeters.z - info.targetMeters.z
        )
      : null;
  const targetPlanetPx = info.activePlanetId ? info.planetScreenPx.toFixed(1) : 'n/a';
  const lines = [
    `Stage: ${info.stage}`,
    `Zoom: ${formatMeters(info.zoomDistanceMeters)}`,
    `System px: ${info.systemScreenPx.toFixed(1)}`,
    `Target planet px: ${targetPlanetPx}`,
    `Camera->target: ${formatKilometers(targetDistanceMeters)}`,
    `System fade: ${info.systemFade.toFixed(2)}`,
    `Planet fade: ${info.planetFade.toFixed(2)}`,
    `Active system: ${info.activeSystemId ?? 'none'}`,
    `Active planet: ${info.activePlanetId ?? 'none'}`,
    `Focus system: ${info.focusSystemId ?? 'none'}`,
    `Focus planet: ${info.focusPlanetId ?? 'none'}`,
    `Target: ${formatVec3(info.targetMeters)}`,
    `Target->system: ${info.targetToSystemDistanceMeters !== null ? formatMeters(info.targetToSystemDistanceMeters) : 'n/a'}`,
    `Active planet world: ${formatVec3(info.activePlanetWorldMeters)}`,
    bodyInfo
      ? `Body: ${bodyInfo.kind} ${bodyInfo.id} parent=${bodyInfo.parentId ?? 'none'}`
      : 'Body: none',
    bodyInfo ? `Body radius: ${formatMeters(bodyInfo.radiusMeters)}` : 'Body radius: n/a',
    bodyInfo?.orbit
      ? `Orbit: a=${formatMeters(bodyInfo.orbit.aMeters)} e=${bodyInfo.orbit.e.toFixed(3)} i=${bodyInfo.orbit.iDeg.toFixed(1)}° Ω=${bodyInfo.orbit.omegaDeg.toFixed(1)}° ω=${bodyInfo.orbit.argPeriapsisDeg.toFixed(1)}° M0=${bodyInfo.orbit.meanAnomalyDeg.toFixed(1)}° P=${bodyInfo.orbit.periodDays.toFixed(1)}d`
      : 'Orbit: n/a',
    bodyInfo
      ? `AstroRef: p=${bodyInfo.astroRef?.planetIndex ?? '-'} m=${bodyInfo.astroRef?.moonIndex ?? '-'} s=${bodyInfo.astroRef?.starIndex ?? '-'} ok=${bodyInfo.hasAstroRef ? 'yes' : 'no'}`
      : 'AstroRef: n/a',
    `Loaded systems: ${info.loadedSystems}`,
    `Loaded planets: ${info.loadedPlanets}`,
    `Planet assets: ${info.planetAssetsLoaded ? 'loaded' : 'missing'} (${info.planetAssetState})`,
    `Planet preload px: ${info.planetPreloadPx.toFixed(1)}`,
    `Planet asset queued: ${info.planetAssetQueued ? 'yes' : 'no'}`,
    `Active planet index: ${info.activePlanetIndex ?? 'none'}`,
    `Draw calls: ${info.drawCalls}`,
    `Triangles: ${info.triangles}`
  ];
  debugOverlayContent.textContent = lines.join('\n');
};

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
  const isNewPinch = lastPinchDistance === 0 || !lastPinchCenter;

  if (isNewPinch) {
    runtime.view.focusAtScreen(centerX, centerY);
  }

  if (lastPinchCenter) {
    runtime.view.applyPan(centerX - lastPinchCenter.x, centerY - lastPinchCenter.y);
  }

  if (lastPinchDistance > 0 && Number.isFinite(distance)) {
    const scale = distance / lastPinchDistance;
    if (scale > 0 && Number.isFinite(scale)) {
      const jitter = Math.abs(scale - 1);
      if (jitter >= PINCH_JITTER_THRESHOLD) {
        runtime.view.applyZoomDelta(-Math.log2(scale) * PINCH_ZOOM_BOOST);
      }
    }
  }

  lastPinchCenter = { x: centerX, y: centerY };
  lastPinchDistance = distance;
};

canvas.addEventListener('contextmenu', event => event.preventDefault());

canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  const point = getCanvasPoint(event);
  if (event.pointerType === 'touch') {
    touchPoints.set(event.pointerId, { x: point.x, y: point.y });
    if (touchPoints.size === 1) {
      tapState.activeId = event.pointerId;
      tapState.startX = point.x;
      tapState.startY = point.y;
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
  pointerState.lastX = point.x;
  pointerState.lastY = point.y;
  pointerState.mode = event.button === 2 || event.shiftKey ? 'pan' : 'orbit';
});

canvas.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') {
    const point = touchPoints.get(event.pointerId);
    if (!point) return;
    const nextPoint = getCanvasPoint(event);
    touchPoints.set(event.pointerId, { x: nextPoint.x, y: nextPoint.y });
    if (tapState.activeId === event.pointerId) {
      const dx = nextPoint.x - tapState.startX;
      const dy = nextPoint.y - tapState.startY;
      if (Math.hypot(dx, dy) > TAP_SLOP) {
        tapState.moved = true;
      }
    }
    if (!runtime) return;
    if (touchPoints.size === 1) {
      const deltaX = nextPoint.x - point.x;
      const deltaY = nextPoint.y - point.y;
      runtime.view.applyOrbit(-deltaX, -deltaY);
      return;
    }
    updatePinch();
    return;
  }

  if (!pointerState.active || !runtime) return;
  const point = getCanvasPoint(event);
  const deltaX = point.x - pointerState.lastX;
  const deltaY = point.y - pointerState.lastY;
  pointerState.lastX = point.x;
  pointerState.lastY = point.y;

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
      const point = getCanvasPoint(event);
      const dx = point.x - tapState.startX;
      const dy = point.y - tapState.startY;
      const moved = tapState.moved || Math.hypot(dx, dy) > TAP_SLOP;
      tapState.activeId = null;
      tapState.moved = false;
      if (wasSingleTouch && !moved) {
        registerTap(point.x, point.y);
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
  const point = getCanvasPoint(event);
  runtime.view.focusAtScreen(point.x, point.y);
});

let lastTime = performance.now();
const frame = (time: number) => {
  const dt = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;
  if (runtime) {
    const dayOverride = Math.abs(runtime.timeScale) < 1e-6 ? runtime.engine.state.day : undefined;
    runtime.view.update(dt, dayOverride);
  }
  updateDebugOverlay();
  updateLabels();
  window.requestAnimationFrame(frame);
};

window.requestAnimationFrame(frame);
