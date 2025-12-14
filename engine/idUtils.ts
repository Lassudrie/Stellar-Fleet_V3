/**
 * Parses the unique ID format (prefix_hash) to return a displayable short code.
 * Handles cases where the ID might not follow the expected format.
 */
export const shortId = (id: string): string => {
  if (!id) return '???';
  const parts = id.split('_');
  // Return the last segment (the hash), uppercase for better visibility
  return parts[parts.length - 1].toUpperCase();
};

/**
 * Returns a standardized label for fleets.
 * Example: "FLEET A1B2C3"
 */
export const fleetLabel = (id: string): string => {
  return `FLEET ${shortId(id)}`;
};
