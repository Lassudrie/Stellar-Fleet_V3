export interface PlayerCommandResult {
  ok: boolean;
  error?: string;
}

interface CommandResultHandlers {
  onSuccess?: () => void;
  onError?: (message: string) => void;
  formatError?: (raw?: string) => string;
}

export const handlePlayerCommandResult = (
  result: PlayerCommandResult,
  handlers: CommandResultHandlers
): boolean => {
  if (result.ok) {
    handlers.onSuccess?.();
    return true;
  }

  const formattedError = handlers.formatError?.(result.error) ?? result.error ?? '';
  handlers.onError?.(formattedError);
  return false;
};
