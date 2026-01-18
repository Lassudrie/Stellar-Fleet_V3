import { buildScenario, SCENARIO_TEMPLATES } from '../content/scenarios';
import { GameEngine } from '../engine/GameEngine';
import { generateWorld } from '../engine/worldgen/worldGenerator';
import { createScenarioView, syncSpaceViewWithState } from '../viewer';

const DEFAULT_SEED = 42;
const SIM_SPEEDS = [1, 2, 4, 8, 16, 32, 64, 100];
const DEFAULT_SIM_SPEED = 1;
const SIM_STEP_MS = 50;
const MAX_STEPS_PER_FRAME = 40;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_DIST = 32;
const TAP_SLOP = 10;
const PINCH_ZOOM_BOOST = 40;
const PINCH_JITTER_THRESHOLD = 0.015;
let debugEnabled = true;

type DragMode = 'orbit' | 'pan';
type UiMode = 'mainMenu' | 'loading' | 'inGame';

type PointerState = {
  active: boolean;
  lastX: number;
  lastY: number;
  mode: DragMode;
};

type Runtime = {
  scenarioId: string;
  seed: number;
  simSpeedMultiplier: number;
  simPaused: boolean;
  engine: GameEngine;
  view: ReturnType<typeof createScenarioView>['view'];
  unsubscribe: () => void;
};

type PreparedScenario = {
  scenarioId: string;
  seed: number;
  scenario: ReturnType<typeof buildScenario>;
  state: ReturnType<typeof generateWorld>['state'];
};

const parseNumberParam = (value: string | null, fallback: number): number => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const formatSimSpeed = (value: number): string => `x${value}`;

const normalizeSimSpeed = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_SIM_SPEED;
  const min = SIM_SPEEDS[0];
  const max = SIM_SPEEDS[SIM_SPEEDS.length - 1];
  const clamped = Math.max(min, Math.min(max, value));
  return SIM_SPEEDS.reduce((closest, speed) =>
    Math.abs(speed - clamped) < Math.abs(closest - clamped) ? speed : closest,
    SIM_SPEEDS[0]
  );
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
const loadingScreen = getElement<HTMLDivElement>('#loading-screen');
const loadingStage = getElement<HTMLParagraphElement>('#loading-stage');
const loadingProgress = getElement<HTMLDivElement>('#loading-progress');
const burgerButton = getElement<HTMLButtonElement>('#burger-button');
const burgerDrawer = getElement<HTMLDivElement>('#burger-drawer');
const burgerBackdrop = getElement<HTMLDivElement>('#burger-backdrop');
const returnMenuButton = getElement<HTMLButtonElement>('#return-menu-button');
const debugOverlay = getElement<HTMLDivElement>('#debug-overlay');
const debugOverlayToggle = getElement<HTMLButtonElement>('#debug-overlay-toggle');
const debugOverlayContent = getElement<HTMLPreElement>('#debug-overlay-content');
const markerLayer = getElement<HTMLDivElement>('#marker-layer');
const labelLayer = getElement<HTMLDivElement>('#label-layer');
const scenarioSelect = getElement<HTMLSelectElement>('#scenario-select');
const seedInput = getElement<HTMLInputElement>('#seed-input');
const menuSimSpeedGroup = getElement<HTMLDivElement>('#sim-speed-menu');
const hudSimSpeedGroup = getElement<HTMLDivElement>('#sim-speed-hud');
const menuSimSpeedValue = getElement<HTMLDivElement>('#sim-speed-value-menu');
const hudSimSpeedValue = getElement<HTMLDivElement>('#sim-speed-value-hud');
const simPauseButton = getElement<HTMLButtonElement>('#sim-pause-button');
const startButton = getElement<HTMLButtonElement>('#start-button');
const scenarioDescription = getElement<HTMLParagraphElement>('#scenario-description');
const hudTabView = getElement<HTMLButtonElement>('#hud-tab-view');
const hudTabShips = getElement<HTMLButtonElement>('#hud-tab-ships');
const hudPanelView = getElement<HTMLDivElement>('#hud-panel-view');
const hudPanelShips = getElement<HTMLDivElement>('#hud-panel-ships');
const shipSelect = getElement<HTMLSelectElement>('#ship-select');

const scenarioById = new Map(SCENARIO_TEMPLATES.map(template => [template.id, template]));
const menuSpeedButtons = Array.from(menuSimSpeedGroup.querySelectorAll<HTMLButtonElement>('button[data-speed]'));
const hudSpeedButtons = Array.from(hudSimSpeedGroup.querySelectorAll<HTMLButtonElement>('button[data-speed]'));
const simSpeedButtons = [...menuSpeedButtons, ...hudSpeedButtons];
const simSpeedValues = [menuSimSpeedValue, hudSimSpeedValue];
const labelNodes = new Map<string, HTMLDivElement>();
const visibleLabelIds = new Set<string>();
const markerNodes = new Map<string, HTMLDivElement>();
const visibleMarkerIds = new Set<string>();

const resolveScenarioId = (candidate: string | null): string => {
  if (candidate && scenarioById.has(candidate)) return candidate;
  return SCENARIO_TEMPLATES[0]?.id ?? '';
};

const updateDescription = (scenarioId: string): void => {
  const template = scenarioById.get(scenarioId);
  scenarioDescription.textContent = template?.meta.description ?? 'Scenario not found.';
};

const simSpeedStorageKey = 'stellarFleet:simSpeedMultiplier';
const legacySimSpeedStorageKey = 'stellarFleet:simSpeedDaysPerSecond';
const lastScenarioStorageKey = 'stellarFleet:lastScenario';
const lastSeedStorageKey = 'stellarFleet:lastSeed';

const updateUrlParams = (scenarioId: string, seed: number, simSpeedMultiplier: number): void => {
  const params = new URLSearchParams();
  params.set('scenario', scenarioId);
  params.set('seed', String(seed));
  params.set('simSpeed', String(simSpeedMultiplier));
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

const setLoadingProgress = (stage: string, progress: number): void => {
  loadingStage.textContent = stage;
  loadingProgress.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
};

const setSimSpeedUI = (value: number, paused = false): void => {
  const text = paused ? `Paused (${formatSimSpeed(value)})` : formatSimSpeed(value);
  simSpeedButtons.forEach(button => {
    const speed = Number(button.dataset.speed ?? NaN);
    button.classList.toggle('is-active', Number.isFinite(speed) && speed === value);
  });
  simSpeedValues.forEach(label => {
    label.textContent = text;
  });
  simPauseButton.classList.toggle('is-active', paused);
  simPauseButton.textContent = paused ? 'Resume' : 'Pause';
};

const setBurgerOpen = (open: boolean): void => {
  if (uiMode !== 'inGame') {
    burgerOpen = false;
    burgerDrawer.classList.remove('is-open');
    burgerBackdrop.classList.remove('is-visible');
    burgerButton.classList.remove('is-active');
    return;
  }

  burgerOpen = open;
  burgerDrawer.classList.toggle('is-open', open);
  burgerBackdrop.classList.toggle('is-visible', open);
  burgerButton.classList.toggle('is-active', open);
};

const setUiMode = (mode: UiMode): void => {
  uiMode = mode;
  const inGame = mode === 'inGame';
  menuScreen.classList.toggle('hidden', mode !== 'mainMenu');
  loadingScreen.classList.toggle('hidden', mode !== 'loading');
  burgerButton.classList.toggle('hidden', !inGame);
  burgerDrawer.classList.toggle('hidden', !inGame);
  burgerBackdrop.classList.toggle('hidden', !inGame);
  labelLayer.classList.toggle('hidden', !inGame);
  markerLayer.classList.toggle('hidden', !inGame);
  if (!inGame) {
    setBurgerOpen(false);
  }
};

const setHudTab = (tab: 'view' | 'ships'): void => {
  const isView = tab === 'view';
  hudTabView.classList.toggle('is-active', isView);
  hudTabShips.classList.toggle('is-active', !isView);
  hudPanelView.classList.toggle('is-active', isView);
  hudPanelShips.classList.toggle('is-active', !isView);
};

const clearLabels = (): void => {
  labelNodes.clear();
  labelLayer.textContent = '';
  markerNodes.clear();
  markerLayer.textContent = '';
};

const populateShipSelect = (view: Runtime['view']): void => {
  shipSelect.textContent = '';
  const noneOption = document.createElement('option');
  noneOption.value = 'none';
  noneOption.textContent = 'None';
  shipSelect.appendChild(noneOption);

  const options = view.getShipOptions();
  if (options.length === 0) {
    shipSelect.disabled = true;
    shipSelect.value = 'none';
    return;
  }

  options.forEach(option => {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    shipSelect.appendChild(node);
  });
  shipSelect.disabled = false;
  shipSelect.value = 'none';
};

const applyShipSelection = (): void => {
  if (!runtime) return;
  const value = shipSelect.value;
  runtime.view.setShipFocus(value === 'none' ? null : value);
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

const updateMarkers = (): void => {
  if (!runtime || markerLayer.classList.contains('hidden')) return;

  const markers = runtime.view.getScreenMarkers();
  visibleMarkerIds.clear();

  markers.forEach(marker => {
    visibleMarkerIds.add(marker.id);
    let node = markerNodes.get(marker.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'marker';
      markerLayer.appendChild(node);
      markerNodes.set(marker.id, node);
    }
    node.dataset.kind = marker.kind;
    node.style.left = `${Math.round(marker.x)}px`;
    node.style.top = `${Math.round(marker.y)}px`;
    node.style.display = 'block';
  });

  markerNodes.forEach((node, id) => {
    if (visibleMarkerIds.has(id)) return;
    node.style.display = 'none';
  });
};

const readSeed = (): number => Math.floor(parseNumberParam(seedInput.value, DEFAULT_SEED));
const parseSimSpeedParam = (value: string | null, fallback: number): number => {
  if (value === null || value === '') return fallback;
  const cleaned = value.startsWith('x') || value.startsWith('X') ? value.slice(1) : value;
  return normalizeSimSpeed(parseNumberParam(cleaned, fallback));
};

const createRuntime = (prepared: PreparedScenario, simSpeedMultiplier: number): Runtime => {
  const engine = new GameEngine(prepared.state);
  document.title = `${prepared.scenario.meta.title} | Stellar Fleet`;

  const { view } = createScenarioView({
    canvas,
    state: engine.state,
    scenario: prepared.scenario,
    viewOptions: {
      timeScaleSecondsPerSecond: 0
    }
  });

  const unsubscribe = engine.subscribe(() => {
    syncSpaceViewWithState(view, engine.state);
  });

  return {
    scenarioId: prepared.scenarioId,
    seed: prepared.seed,
    simSpeedMultiplier,
    simPaused: false,
    engine,
    view,
    unsubscribe
  };
};

const applyScenario = (
  runtime: Runtime,
  prepared: PreparedScenario,
  simSpeedMultiplier: number
): Runtime => {
  runtime.unsubscribe();
  runtime.view.dispose();
  clearLabels();
  updateDescription(prepared.scenarioId);

  const next = createRuntime(prepared, simSpeedMultiplier);
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

const storedScenarioId = resolveScenarioId(localStorage.getItem(lastScenarioStorageKey));
const storedSeed = Math.floor(parseNumberParam(localStorage.getItem(lastSeedStorageKey), DEFAULT_SEED));
const storedSimSpeed = parseSimSpeedParam(
  localStorage.getItem(simSpeedStorageKey) ?? localStorage.getItem(legacySimSpeedStorageKey),
  DEFAULT_SIM_SPEED
);

const initialScenarioId = resolveScenarioId(params.get('scenario') ?? storedScenarioId);
if (!initialScenarioId) {
  throw new Error('No scenarios available to load.');
}

const initialSeed = Math.floor(parseNumberParam(params.get('seed'), storedSeed));
const simSpeedParam = params.get('simSpeed') ?? params.get('speed') ?? params.get('timeScale');
const initialSimSpeed = parseSimSpeedParam(simSpeedParam, storedSimSpeed);

scenarioSelect.value = initialScenarioId;
seedInput.value = String(initialSeed);
setSimSpeedUI(initialSimSpeed);
updateDescription(initialScenarioId);
let uiMode: UiMode = 'mainMenu';
let burgerOpen = false;
setUiMode('mainMenu');

let selectedSimSpeed = initialSimSpeed;
let runtime: Runtime | null = null;
let simAccumulatorMs = 0;

const updateDebugOverlay = () => {
  if (!debugEnabled) return;
  if (!runtime) {
    const stage = uiMode === 'loading' ? 'loading' : 'menu';
    debugOverlayContent.textContent = `Stage: ${stage}`;
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

const persistScenarioInputs = (scenarioId: string, seed: number): void => {
  localStorage.setItem(lastScenarioStorageKey, scenarioId);
  localStorage.setItem(lastSeedStorageKey, String(seed));
};

const persistSimSpeed = (value: number): void => {
  localStorage.setItem(simSpeedStorageKey, String(value));
};

const setSimSpeed = (value: number): void => {
  const normalized = normalizeSimSpeed(value);
  selectedSimSpeed = normalized;
  persistSimSpeed(normalized);
  if (!runtime) {
    updateUrlParams(resolveScenarioId(scenarioSelect.value), readSeed(), normalized);
    setSimSpeedUI(normalized);
    return;
  }
  runtime.simSpeedMultiplier = normalized;
  updateUrlParams(runtime.scenarioId, runtime.seed, runtime.simSpeedMultiplier);
  setSimSpeedUI(runtime.simSpeedMultiplier, runtime.simPaused);
};

const setSimPaused = (paused: boolean): void => {
  if (!runtime) return;
  runtime.simPaused = paused;
  setSimSpeedUI(runtime.simSpeedMultiplier, runtime.simPaused);
};

const applyPreparedScenario = (prepared: PreparedScenario, simSpeedMultiplier: number): Runtime => {
  const next = runtime ? applyScenario(runtime, prepared, simSpeedMultiplier) : createRuntime(prepared, simSpeedMultiplier);
  updateUrlParams(next.scenarioId, next.seed, next.simSpeedMultiplier);
  persistScenarioInputs(next.scenarioId, next.seed);
  persistSimSpeed(next.simSpeedMultiplier);
  populateShipSelect(next.view);
  next.view.setShipFocus(null);
  setHudTab('view');
  resize();
  return next;
};

const destroyRuntime = (): void => {
  if (!runtime) return;
  runtime.unsubscribe();
  runtime.view.dispose();
  clearLabels();
  runtime = null;
  simAccumulatorMs = 0;
};

const startScenario = async (scenarioId: string, seed: number, simSpeedMultiplier: number): Promise<void> => {
  setUiMode('loading');
  setLoadingProgress('Preparing scenario', 0.25);
  await new Promise(requestAnimationFrame);
  const scenario = buildScenario(scenarioId, seed);
  setLoadingProgress('Generating world', 0.5);
  const { state } = generateWorld(scenario);
  setLoadingProgress('Initializing viewer', 0.75);
  const prepared: PreparedScenario = { scenarioId, seed, scenario, state };
  runtime = applyPreparedScenario(prepared, simSpeedMultiplier);
  simAccumulatorMs = 0;
  setLoadingProgress('Finalizing', 1);
  setUiMode('inGame');
};

const returnToMainMenu = (): void => {
  if (runtime) {
    scenarioSelect.value = runtime.scenarioId;
    seedInput.value = String(runtime.seed);
    selectedSimSpeed = runtime.simSpeedMultiplier;
    setSimSpeedUI(selectedSimSpeed);
    updateDescription(runtime.scenarioId);
  }
  destroyRuntime();
  setUiMode('mainMenu');
};

startButton.addEventListener('click', async () => {
  const nextScenarioId = resolveScenarioId(scenarioSelect.value);
  scenarioSelect.value = nextScenarioId;
  const nextSeed = readSeed();
  const nextSimSpeed = selectedSimSpeed;
  seedInput.value = String(nextSeed);
  setSimSpeedUI(nextSimSpeed);
  await startScenario(nextScenarioId, nextSeed, nextSimSpeed);
});

scenarioSelect.addEventListener('change', () => {
  updateDescription(resolveScenarioId(scenarioSelect.value));
});

hudTabView.addEventListener('click', () => setHudTab('view'));
hudTabShips.addEventListener('click', () => setHudTab('ships'));
shipSelect.addEventListener('change', applyShipSelection);

seedInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  startButton.click();
});

const onSpeedButtonClick = (event: Event) => {
  const target = event.currentTarget as HTMLButtonElement | null;
  const value = Number(target?.dataset.speed ?? NaN);
  if (!Number.isFinite(value)) return;
  setSimSpeed(value);
};

simSpeedButtons.forEach(button => {
  button.addEventListener('click', onSpeedButtonClick);
});

simPauseButton.addEventListener('click', () => {
  if (!runtime) return;
  setSimPaused(!runtime.simPaused);
});

burgerButton.addEventListener('click', () => {
  setBurgerOpen(!burgerOpen);
});

burgerBackdrop.addEventListener('click', () => {
  setBurgerOpen(false);
});

returnMenuButton.addEventListener('click', () => {
  setBurgerOpen(false);
  returnToMainMenu();
});

window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    setBurgerOpen(false);
  }
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
  const dtSeconds = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;
  if (runtime) {
    const canSimulate = uiMode === 'inGame' && !burgerOpen && !runtime.simPaused;
    const effectiveSimSpeed = canSimulate ? runtime.simSpeedMultiplier : 0;
    if (effectiveSimSpeed > 0) {
      simAccumulatorMs += dtSeconds * 1000 * effectiveSimSpeed;
      const steps = Math.min(Math.floor(simAccumulatorMs / SIM_STEP_MS), MAX_STEPS_PER_FRAME);
      if (steps > 0) {
        const advanceMs = steps * SIM_STEP_MS;
        runtime.engine.advanceTime(advanceMs);
        simAccumulatorMs -= advanceMs;
      }
    }
    const simTimeSeconds = (runtime.engine.state.timeMs + simAccumulatorMs) / 1000;
    runtime.view.update(dtSeconds, simTimeSeconds);
  }
  updateDebugOverlay();
  updateLabels();
  updateMarkers();
  window.requestAnimationFrame(frame);
};

window.requestAnimationFrame(frame);
