import { Fleet, FactionState } from '../../types';
import { fleetLabel, shortId } from '../../engine/idUtils';

export const resolveFactionColor = (factions: FactionState[], factionId: string): string => {
  return factions.find(faction => faction.id === factionId)?.color || '#999';
};

export const applyAlpha = (color: string, alpha: number): string => {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  if (color.startsWith('#') && color.length === 7) {
    const alphaHex = Math.round(normalizedAlpha * 255)
      .toString(16)
      .padStart(2, '0');
    return `${color}${alphaHex}`;
  }
  return color;
};

export const buildFactionLabel = (
  fleet: Fleet,
  factions: FactionState[],
  playerFactionId: string
): string => {
  if (fleet.factionId === playerFactionId) {
    return fleetLabel(fleet.id);
  }

  const factionName = factions.find(faction => faction.id === fleet.factionId)?.name || 'Unknown faction';
  return `${factionName} (${shortId(fleet.id)})`;
};
