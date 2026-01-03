import { generateSurfaceMapForState, getAstroForBody, getSurfaceDescriptor } from '../../engine/planetSurface';
import { getPlanetById } from '../../engine/planets';
import type { GameState, PlanetSurfaceDescriptor, PlanetSurfaceMap, StarSystem } from '../../shared/shared';
import type { SurfaceMapWorkerRequest, SurfaceMapWorkerResponseMessage } from './surfaceMapWorker';

const canUseWorker = typeof window !== 'undefined' && typeof Worker !== 'undefined';

type PendingRequest = {
  resolve: (map: PlanetSurfaceMap | null) => void;
  reject: (error: Error) => void;
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
      this.worker?.postMessage({ id, payload: request });
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

  private handleMessage = (event: MessageEvent<SurfaceMapWorkerResponseMessage>) => {
    const { id, payload } = event.data;
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
