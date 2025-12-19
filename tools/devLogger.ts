const envMeta =
  typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: { DEV?: boolean } })
    : undefined;

const isDev = Boolean(envMeta?.env?.DEV);

export const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) {
    console.log(...args);
  }
};

export const devWarn = (...args: Parameters<typeof console.warn>) => {
  if (isDev) {
    console.warn(...args);
  }
};

export const devError = (...args: Parameters<typeof console.error>) => {
  if (isDev) {
    console.error(...args);
  }
};

export const devInfo = (...args: Parameters<typeof console.info>) => {
  if (isDev) {
    console.info(...args);
  }
};
