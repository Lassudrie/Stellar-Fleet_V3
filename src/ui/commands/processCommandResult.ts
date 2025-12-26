import { GameEngine } from '../../engine/GameEngine';
import { CommandResult } from '../../engine/commands';

export type ErrorNotifier = (message: string) => void;

const formatErrorMessage = (error: CommandResult['error']): string => {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || 'Unknown error';
};

export const processCommandResult = (
  res: Pick<CommandResult, 'ok'> & Partial<Pick<CommandResult, 'error'>>,
  notifyError: ErrorNotifier
): boolean => {
  if (res.ok) return true;

  if (!res.ok && 'error' in res && res.error) {
    notifyError(formatErrorMessage(res.error));
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
