import { GameEngine } from '../../engine/GameEngine';

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export type ErrorNotifier = (message: string) => void;

export const processCommandResult = (
  result: CommandResult,
  notifyError: ErrorNotifier
): boolean => {
  if (result.ok) return true;

  notifyError(result.error ?? 'Unknown error');
  return false;
};

// Utility to help with handler unit tests without wiring a real engine
export const dispatchAndProcess = (
  engine: Pick<GameEngine, 'dispatchPlayerCommand'>,
  command: Parameters<GameEngine['dispatchPlayerCommand']>[0],
  notifyError: ErrorNotifier
): boolean => {
  const result = engine.dispatchPlayerCommand(command);
  return processCommandResult(result, notifyError);
};
