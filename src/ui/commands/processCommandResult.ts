import { GameEngine } from '../../engine/GameEngine';
import { CommandResult } from '../../engine/commands';

export type ErrorNotifier = (message: string) => void;

export const processCommandResult = (
  result: Pick<CommandResult, 'ok' | 'error'>,
  notifyError: ErrorNotifier
): boolean => {
  if (result.ok) return true;

  if (!result.ok && 'error' in result && result.error) {
    notifyError(result.error);
  } else {
    notifyError('Unknown error');
  }
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
