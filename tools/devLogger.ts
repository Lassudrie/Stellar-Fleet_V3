const envMeta =
  typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: { DEV?: boolean; VITE_LOG_LEVEL?: string } })
    : undefined;

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

const parseLogLevel = (value?: string): LogLevel | null => {
  if (!value) return null;
  const normalized = value.toLowerCase() as LogLevel;
  return normalized in LEVEL_ORDER ? normalized : null;
};

const defaultLevel: LogLevel = envMeta?.env?.DEV ? 'debug' : 'warn';
let currentLevel: LogLevel = parseLogLevel(envMeta?.env?.VITE_LOG_LEVEL) ?? defaultLevel;

const shouldLog = (level: LogLevel) => LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];

const logWithLevel =
  <T extends keyof Console>(level: LogLevel, method: T) =>
  (...args: Parameters<Console[T]>) => {
    if (shouldLog(level)) {
      // Some environments may not implement console.debug explicitly.
      const fallbackMethod = console[method] ?? console.log;
      fallbackMethod(...args);
    }
  };

export const setLogLevel = (level: LogLevel): void => {
  currentLevel = level;
};

export const getLogLevel = (): LogLevel => currentLevel;

export const logger = {
  error: logWithLevel('error', 'error'),
  warn: logWithLevel('warn', 'warn'),
  info: logWithLevel('info', 'info'),
  debug: logWithLevel('debug', 'debug')
};

// Backward-compatible helpers
export const devLog = (...args: Parameters<typeof console.log>) => logger.debug(...args);
export const devWarn = (...args: Parameters<typeof console.warn>) => logger.warn(...args);
export const devError = (...args: Parameters<typeof console.error>) => logger.error(...args);
export const devInfo = (...args: Parameters<typeof console.info>) => logger.info(...args);
