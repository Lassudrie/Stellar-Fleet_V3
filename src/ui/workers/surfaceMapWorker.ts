import { generateSurfaceMapForState } from '../../engine/planetSurface';
import { generateWorld } from '../../engine/worldgen/worldGenerator';
import { deserializeGameState } from '../../engine/serialization';
import type { GameScenario } from '../../content/scenarios';
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
  kind: 'surfaceMap';
  id: number;
  payload: {
    map: PlanetSurfaceMap | null;
    error?: string;
  };
}

export type BootstrapWorkerRequestPayload =
  | { type: 'START_NEW_GAME'; scenario: GameScenario }
  | { type: 'LOAD_GAME'; saveJson: string };

export type BootstrapProgressDetail = { current: number; total: number };

export type BootstrapWorkerResponseMessage =
  | {
      kind: 'bootstrap';
      id: number;
      payload: {
        type: 'progress';
        stage: 'worldgen' | 'deserialize';
        progress: number;
        detail?: BootstrapProgressDetail;
      };
    }
  | {
      kind: 'bootstrap';
      id: number;
      payload: {
        type: 'done';
        state: GameState;
      };
    }
  | {
      kind: 'bootstrap';
      id: number;
      payload: {
        type: 'error';
        message: string;
      };
    };

type SurfaceMapWorkerRequestMessage = {
  kind: 'surfaceMap';
  id: number;
  payload: SurfaceMapWorkerRequest;
};

type BootstrapWorkerRequestMessage = {
  kind: 'bootstrap';
  id: number;
  payload: BootstrapWorkerRequestPayload;
};

type WorkerRequestMessage =
  | SurfaceMapWorkerRequestMessage
  | BootstrapWorkerRequestMessage
  | { id: number; payload: SurfaceMapWorkerRequest };

const postResponse = (message: SurfaceMapWorkerResponseMessage | BootstrapWorkerResponseMessage) => {
  (self as unknown as { postMessage: (message: SurfaceMapWorkerResponseMessage | BootstrapWorkerResponseMessage) => void }).postMessage(message);
};

const postBootstrapProgress = (id: number, update: { stage: 'worldgen' | 'deserialize'; progress: number; detail?: BootstrapProgressDetail }) => {
  postResponse({
    kind: 'bootstrap',
    id,
    payload: {
      type: 'progress',
      stage: update.stage,
      progress: update.progress,
      detail: update.detail
    }
  });
};

const postBootstrapDone = (id: number, state: GameState) => {
  postResponse({ kind: 'bootstrap', id, payload: { type: 'done', state } });
};

const postBootstrapError = (id: number, error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  postResponse({ kind: 'bootstrap', id, payload: { type: 'error', message: errorMessage } });
};

self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data;
  const kind = (message as { kind?: string }).kind;

  if (kind === 'bootstrap') {
    const { id, payload } = message as BootstrapWorkerRequestMessage;
    try {
      if (payload.type === 'START_NEW_GAME') {
        const { state } = generateWorld(payload.scenario, {
          onProgress: update => postBootstrapProgress(id, update)
        });
        postBootstrapDone(id, state);
        return;
      }
      if (payload.type === 'LOAD_GAME') {
        const state = deserializeGameState(payload.saveJson, {
          onProgress: update => postBootstrapProgress(id, update)
        });
        postBootstrapDone(id, state);
        return;
      }
      postBootstrapError(id, `Unknown bootstrap payload type: ${(payload as { type?: string }).type}`);
    } catch (error) {
      postBootstrapError(id, error);
    }
    return;
  }

  const { id, payload } = message as SurfaceMapWorkerRequestMessage | { id: number; payload: SurfaceMapWorkerRequest };
  try {
    const map = generateSurfaceMapForState(payload.state as GameState, payload.bodyId);
    postResponse({ kind: 'surfaceMap', id, payload: { map } });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    postResponse({ kind: 'surfaceMap', id, payload: { map: null, error: errorMessage } });
  }
};
