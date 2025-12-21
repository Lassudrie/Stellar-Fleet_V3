export interface PlayerCommandResult {
  ok: boolean;
  error?: string;
}

export interface CommandResultHandlers {
  onSuccess?: () => void;
  onError: (message: string) => void;
  formatError?: (error?: string) => string;
}

export const processCommandResult = (
  result: PlayerCommandResult,
  handlers: CommandResultHandlers
): boolean => {
  if (result.ok) {
    handlers.onSuccess?.();
    return true;
  }

  const formatted = handlers.formatError ? handlers.formatError(result.error) : result.error ?? 'Unknown error';
  handlers.onError(formatted);
  return false;
};
