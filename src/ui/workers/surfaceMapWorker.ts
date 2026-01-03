import { generateSurfaceMapForState } from '../../engine/planetSurface';
import type { GameState, PlanetSurfaceMap } from '../../shared/shared';

export interface SurfaceMapWorkerState {
  planetSurfaceDescriptorsByBodyId: GameState['planetSurfaceDescriptorsByBodyId'];
  systems: GameState['systems'];
}

export interface SurfaceMapWorkerRequest {
  bodyId: string;
  state: SurfaceMapWorkerState;
}

export interface SurfaceMapWorkerResponseMessage {
  id: number;
  payload: {
    map: PlanetSurfaceMap | null;
    error?: string;
  };
}

type SurfaceMapWorkerRequestMessage = {
  id: number;
  payload: SurfaceMapWorkerRequest;
};

const postResponse = (message: SurfaceMapWorkerResponseMessage) => {
  (self as unknown as { postMessage: (message: SurfaceMapWorkerResponseMessage) => void }).postMessage(message);
};

self.onmessage = (event: MessageEvent<SurfaceMapWorkerRequestMessage>) => {
  const { id, payload } = event.data;
  try {
    const map = generateSurfaceMapForState(payload.state as GameState, payload.bodyId);
    postResponse({ id, payload: { map } });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    postResponse({ id, payload: { map: null, error: errorMessage } });
  }
};
