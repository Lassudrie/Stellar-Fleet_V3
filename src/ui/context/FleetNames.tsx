import React, { createContext, useContext, useMemo } from 'react';
import { Fleet } from '../../shared/types';
import { shortId } from '../../engine/idUtils';
import { sorted } from '../../shared/sorting';

const GREEK_LETTERS = [
  'Alpha',
  'Beta',
  'Gamma',
  'Delta',
  'Epsilon',
  'Zeta',
  'Eta',
  'Theta',
  'Iota',
  'Kappa',
  'Lambda',
  'Mu',
  'Nu',
  'Xi',
  'Omicron',
  'Pi',
  'Rho',
  'Sigma',
  'Tau',
  'Upsilon',
  'Phi',
  'Chi',
  'Psi',
  'Omega',
];

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

const formatFleetName = (index: number): string => {
  const base = GREEK_LETTERS[index % GREEK_LETTERS.length];
  const cycle = Math.floor(index / GREEK_LETTERS.length);
  return cycle === 0 ? base : `${base}-${cycle}`;
};

const buildFleetNameRegistry = (fleets: Fleet[]): Record<string, string> => {
  const byFaction = new Map<string, Fleet[]>();
  fleets.forEach((fleet) => {
    const bucket = byFaction.get(fleet.factionId);
    if (bucket) {
      bucket.push(fleet);
    } else {
      byFaction.set(fleet.factionId, [fleet]);
    }
  });

  const registry: Record<string, string> = {};
  byFaction.forEach((factionFleets) => {
    const orderedFleets = sorted(factionFleets, (a, b) => compareIds(a.id, b.id));
    orderedFleets.forEach((fleet, index) => {
      registry[fleet.id] = formatFleetName(index);
    });
  });

  return registry;
};

type FleetNameResolver = (fleetId: string) => string;

const FleetNameContext = createContext<FleetNameResolver | null>(null);

export const FleetNameProvider: React.FC<{ fleets: Fleet[]; children: React.ReactNode }> = ({ fleets, children }) => {
  const registry = useMemo(() => buildFleetNameRegistry(fleets), [fleets]);
  const resolve = useMemo<FleetNameResolver>(
    () => (fleetId: string) => registry[fleetId] ?? `Fleet ${shortId(fleetId)}`,
    [registry]
  );

  return <FleetNameContext.Provider value={resolve}>{children}</FleetNameContext.Provider>;
};

export const useFleetName = (): FleetNameResolver => {
  const ctx = useContext(FleetNameContext);
  if (ctx) return ctx;
  return (fleetId: string) => `Fleet ${shortId(fleetId)}`;
};
