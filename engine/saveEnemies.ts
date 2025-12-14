import { AIState, EnemySighting } from '../types';
import { EnemySightingDTO, Vector3DTO } from './saveFormat';

export const toEnemySightings = (aiState: AIState): EnemySightingDTO[] => {
  const result: EnemySightingDTO[] = [];
  
  Object.entries(aiState.enemySightings || {}).forEach(([factionId, sightings]) => {
    sightings.forEach(sighting => {
      result.push({
        fleetId: sighting.fleetId,
        systemId: null,
        position: {
          x: sighting.position.x,
          y: sighting.position.y,
          z: sighting.position.z
        },
        daySeen: sighting.lastSeen,
        estimatedPower: 0,
        confidence: 1.0
      });
    });
  });
  
  return result;
};

export const fromEnemySightings = (aiState: AIState, enemySightings?: EnemySightingDTO[]): AIState => {
  if (!enemySightings || enemySightings.length === 0) {
    return aiState;
  }
  
  const result: AIState = {
    enemySightings: { ...aiState.enemySightings }
  };
  
  enemySightings.forEach(dto => {
    // Group by faction (we'll use a default faction if not specified)
    const factionId = 'unknown';
    if (!result.enemySightings[factionId]) {
      result.enemySightings[factionId] = [];
    }
    
    result.enemySightings[factionId].push({
      fleetId: dto.fleetId,
      position: {
        x: dto.position.x,
        y: dto.position.y,
        z: dto.position.z
      },
      lastSeen: dto.daySeen
    });
  });
  
  return result;
};
