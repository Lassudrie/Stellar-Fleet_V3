const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV);

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
