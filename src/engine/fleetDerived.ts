import { Fleet } from '../shared/types';

/**
 * Calculates the visual radius of a fleet based on its ship count.
 * Formula: 1 + ln(count + 1)
 */
export const computeFleetRadius = (shipCount: number): number => {
  return 1 + Math.log(shipCount + 1);
};

/**
 * Returns a new Fleet object with updated derived properties (radius).
 * Use this whenever the ship list of a fleet changes.
 */
export const withUpdatedFleetDerived = (fleet: Fleet): Fleet => {
  return {
    ...fleet,
    radius: computeFleetRadius(fleet.ships.length)
  };
};