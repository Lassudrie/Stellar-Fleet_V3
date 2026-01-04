import { generateSurfaceMapForState, getAstroForBody, getSurfaceDescriptor } from '../../engine/planetSurface';
import { generateWorld } from '../../engine/worldgen/worldGenerator';
import { deserializeGameState } from '../../engine/serialization';
import { getPlanetById } from '../../engine/planets';
import type { GameScenario } from '../../content/scenarios';
import type { GameState, PlanetSurfaceDescriptor, PlanetSurfaceMap, StarSystem } from '../../shared/shared';
import type {
  SurfaceMapWorkerRequest,
  SurfaceMapWorkerResponseMessage,
  BootstrapWorkerResponseMessage,
  BootstrapWorkerRequestPayload,
  BootstrapProgressDetail
} from './surfaceMapWorker';

const canUseWorker = typeof window !== 'undefined' && typeof Worker !== 'undefined';

type PendingRequest = {
  resolve: (map: PlanetSurfaceMap | null) => void;
  reject: (error: Error) => void;
};

export type BootstrapProgressUpdate = {
  stage: 'worldgen' | 'deserialize';
  progress: number;
  detail?: BootstrapProgressDetail;
};

type PendingBootstrapRequest = {
  resolve: (state: GameState) => void;
  reject: (error: Error) => void;
  onProgress?: (update: BootstrapProgressUpdate) => void;
};

export type SurfaceMapRequestPayload = {
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  system: StarSystem;
};

export class SurfaceMapWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    if (!canUseWorker) {
      this.worker = null;
      return;
    }

    try {
      this.worker = new Worker(new URL('./surfaceMapWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = this.handleMessage;
      this.worker.onerror = this.handleError;
    } catch (error) {
      console.warn('[SurfaceMapWorkerClient] Worker instantiation failed, falling back to sync path', error);
      this.worker = null;
    }
  }

  requestSurfaceMap(request: SurfaceMapWorkerRequest): Promise<PlanetSurfaceMap | null> {
    if (!this.worker) {
      return Promise.resolve(this.generateSync(request));
    }

    const id = this.nextRequestId++;
    return new Promise<PlanetSurfaceMap | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ kind: 'surfaceMap', id, payload: request });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(new Error('Worker disposed')));
    this.pending.clear();
  }

  private generateSync(request: SurfaceMapWorkerRequest): PlanetSurfaceMap | null {
    return generateSurfaceMapForState(request.state as GameState, request.bodyId);
  }

  private handleMessage = (event: MessageEvent<SurfaceMapWorkerResponseMessage | BootstrapWorkerResponseMessage>) => {
    const data = event.data;
    if ((data as { kind?: string }).kind && data.kind !== 'surfaceMap') return;
    const { id, payload } = data as SurfaceMapWorkerResponseMessage;
    const pendingRequest = this.pending.get(id);
    if (!pendingRequest) return;
    this.pending.delete(id);
    if (payload.error) {
      pendingRequest.reject(new Error(payload.error));
      return;
    }
    pendingRequest.resolve(payload.map);
  };

  private handleError = (event: ErrorEvent) => {
    const error = new Error(event.message || 'Worker error');
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(error));
    this.pending.clear();
  };
}

export class BootstrapWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingBootstrapRequest>();

  constructor() {
    if (!canUseWorker) {
      this.worker = null;
      return;
    }

    try {
      this.worker = new Worker(new URL('./surfaceMapWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = this.handleMessage;
      this.worker.onerror = this.handleError;
    } catch (error) {
      console.warn('[BootstrapWorkerClient] Worker instantiation failed, falling back to sync path', error);
      this.worker = null;
    }
  }

  startNewGame(scenario: GameScenario, onProgress?: (update: BootstrapProgressUpdate) => void): Promise<GameState> {
    if (!this.worker) {
      return Promise.resolve(this.generateNewGameSync(scenario, onProgress));
    }

    const id = this.nextRequestId++;
    const payload: BootstrapWorkerRequestPayload = { type: 'START_NEW_GAME', scenario };
    return new Promise<GameState>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker?.postMessage({ kind: 'bootstrap', id, payload });
    });
  }

  loadGame(saveJson: string, onProgress?: (update: BootstrapProgressUpdate) => void): Promise<GameState> {
    if (!this.worker) {
      return Promise.resolve(this.loadGameSync(saveJson, onProgress));
    }

    const id = this.nextRequestId++;
    const payload: BootstrapWorkerRequestPayload = { type: 'LOAD_GAME', saveJson };
    return new Promise<GameState>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker?.postMessage({ kind: 'bootstrap', id, payload });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(new Error('Worker disposed')));
    this.pending.clear();
  }

  private generateNewGameSync(scenario: GameScenario, onProgress?: (update: BootstrapProgressUpdate) => void): GameState {
    return generateWorld(scenario, { onProgress: update => onProgress?.(update) }).state;
  }

  private loadGameSync(saveJson: string, onProgress?: (update: BootstrapProgressUpdate) => void): GameState {
    return deserializeGameState(saveJson, { onProgress: update => onProgress?.(update) });
  }

  private handleMessage = (event: MessageEvent<BootstrapWorkerResponseMessage | SurfaceMapWorkerResponseMessage>) => {
    if (event.data.kind !== 'bootstrap') return;
    const { id, payload } = event.data;
    const pendingRequest = this.pending.get(id);
    if (!pendingRequest) return;

    if (payload.type === 'progress') {
      pendingRequest.onProgress?.({ stage: payload.stage, progress: payload.progress, detail: payload.detail });
      return;
    }

    this.pending.delete(id);

    if (payload.type === 'done') {
      pendingRequest.resolve(payload.state);
      return;
    }

    pendingRequest.reject(new Error(payload.message));
  };

  private handleError = (event: ErrorEvent) => {
    const error = new Error(event.message || 'Worker error');
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(error));
    this.pending.clear();
  };
}

export const buildSurfaceMapWorkerRequest = (
  state: GameState,
  bodyId: string
): SurfaceMapWorkerRequest | null => {
  const descriptor = getSurfaceDescriptor(state, bodyId);
  if (!descriptor) return null;

  const match = getPlanetById(state.systems, bodyId);
  if (!match) return null;

  const astro = getAstroForBody(state, bodyId, descriptor);
  if (!astro) return null;

  const scopedSystem: StarSystem = {
    ...match.system,
    planets: match.system.planets.map(planet => (planet.id === bodyId ? { ...planet, ownerFactionId: astro.ownerFactionId ?? planet.ownerFactionId } : planet))
  };

  const scopedDescriptors: GameState['planetSurfaceDescriptorsByBodyId'] = {
    [bodyId]: descriptor
  };

  return {
    bodyId,
    state: {
      planetSurfaceDescriptorsByBodyId: scopedDescriptors,
      systems: [scopedSystem]
    }
  };
};
