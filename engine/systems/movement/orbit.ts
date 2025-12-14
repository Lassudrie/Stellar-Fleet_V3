
import { Fleet, StarSystem } from '../../../types';
import { ORBIT_RADIUS, ORBIT_SPEED } from '../../../data/static';

export const getOrbitAngle = (fleetId: string, timeInSeconds: number): number => {
  let hash = 0;
  for (let i = 0; i < fleetId.length; i++) {
    hash = (hash << 5) - hash + fleetId.charCodeAt(i);
    hash |= 0;
  }
  const offset = Math.abs(hash % 360) * (Math.PI / 180);
  return timeInSeconds * ORBIT_SPEED + offset;
};

export const snapToOrbit = (fleet: Fleet, system: StarSystem, time: number = 0): void => {
  const angle = getOrbitAngle(fleet.id, time);
  const x = system.position.x + Math.cos(angle) * ORBIT_RADIUS;
  const z = system.position.z + Math.sin(angle) * ORBIT_RADIUS;
  fleet.position.x = x;
  fleet.position.y = system.position.y;
  fleet.position.z = z;
};
