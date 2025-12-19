const DEFAULT_FALLBACK = '—';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const formatAu = (value: number | undefined, fallback = DEFAULT_FALLBACK): string => {
  if (!isFiniteNumber(value)) return fallback;
  return `${value.toFixed(2)} AU`;
};

export const formatKm = (value: number | undefined, fallback = DEFAULT_FALLBACK): string => {
  if (!isFiniteNumber(value)) return fallback;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;
};

export const formatGravity = (value: number | undefined, fallback = DEFAULT_FALLBACK): string => {
  if (!isFiniteNumber(value)) return fallback;
  return `${value.toFixed(2)} g`;
};

export const formatCelsius = (temperatureK: number | undefined, fallback = DEFAULT_FALLBACK): string => {
  if (!isFiniteNumber(temperatureK)) return fallback;
  return `${(temperatureK - 273.15).toFixed(1)} °C`;
};
