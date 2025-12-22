/**
 * Parses the unique ID format (prefix_hash) to return a displayable short code.
 * Handles cases where the ID might not follow the expected format.
 */
export const shortId = (id: string): string => {
  if (!id) return '???';
  const parts = id.split('_');
  const suffix = parts[parts.length - 1];
  if (!suffix) return '???';

  const uuidSegment = suffix.includes('-') ? suffix.split('-')[0] : suffix;
  if (!uuidSegment) return '???';

  const normalized = uuidSegment.replace(/[^a-zA-Z0-9]/g, '');
  if (!normalized) return '???';

  return normalized.slice(0, 8).toUpperCase();
};

/**
 * Returns a standardized label for fleets.
 * Example: "FLEET A1B2C3"
 */
export const fleetLabel = (id: string): string => {
  return `FLEET ${shortId(id)}`;
};
