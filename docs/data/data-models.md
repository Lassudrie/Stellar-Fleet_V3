
# Modèles de Données

Ce document résume les structures décrites dans `src/shared/types.ts` pour les factions, flottes, armées, combats, objectifs, règles et données astro. Les exemples sont donnés en minuscules pour les valeurs d'enum et utilisent les clés mises à jour (`winnerFactionId`, `ownerFactionId`).

## Types de base et identifiants

```typescript
export type FactionId = string;
export type ResourceType = 'none' | 'gas';
export type PlanetBodyType = 'planet' | 'moon';
export type PlanetClass = 'solid' | 'gas_giant' | 'ice_giant';
```

### États et valeurs

```typescript
export enum FleetState {
  ORBIT = 'ORBIT',
  MOVING = 'MOVING',
  COMBAT = 'COMBAT',
}

export enum ArmyState {
  EMBARKED = 'EMBARKED',
  DEPLOYED = 'DEPLOYED',
  IN_TRANSIT = 'IN_TRANSIT',
}
```

Valeurs suggérées dans les exemples JSON :
* `FleetState` : `'orbit'`, `'moving'`, `'combat'`
* `ArmyState` : `'embarked'`, `'deployed'`, `'in_transit'`

## Factions

```typescript
export interface FactionState {
  id: FactionId;
  name: string;
  color: string;
  isPlayable: boolean;
  aiProfile?: string;
}
```

## Systèmes et astro

```typescript
export interface PlanetBody {
  id: string;
  systemId: string;
  name: string;
  bodyType: PlanetBodyType;
  class: PlanetClass;
  ownerFactionId?: FactionId | null;
  size: number;
  isSolid: boolean;
}

export interface StarSystem {
  id: string;
  name: string;
  position: Vec3;
  color: string;
  size: number;
  ownerFactionId: FactionId | null;
  resourceType: ResourceType;
  isHomeworld: boolean;
  planets: PlanetBody[];
  astro?: StarSystemAstro;
}
```

### Données astro procédurales (résumé)

```typescript
export interface StarSystemAstro {
  seed: number;
  primarySpectralType: SpectralType;
  starCount: number;
  metallicityFeH: number;
  derived: {
    luminosityTotalLSun: number;
    snowLineAu: number;
    hzInnerAu: number;
    hzOuterAu: number;
  };
  stars: StarData[];
  planets: PlanetData[];
}
```

Les types `SpectralType`, `PlanetType`, `MoonType` et `AtmosphereType` sont des littéraux de chaînes décrits dans `src/shared/types.ts`. Les champs numériques sont directement sérialisables pour les sauvegardes.

## Flottes et vaisseaux

```typescript
export interface Fleet {
  id: string;
  factionId: FactionId;
  ships: ShipEntity[];
  position: Vec3;
  state: FleetState;
  targetSystemId: string | null;
  targetPosition: Vec3 | null;
  radius: number;
  stateStartTurn: number;
  retreating?: boolean;
  invasionTargetSystemId?: string | null;
  loadTargetSystemId?: string | null;
  unloadTargetSystemId?: string | null;
}

export interface ShipEntity {
  id: string;
  type: ShipType;
  hp: number;
  maxHp: number;
  carriedArmyId: string | null;
  transferBusyUntilDay?: number;
  consumables?: ShipConsumables;
  offensiveMissilesLeft?: number;
  torpedoesLeft?: number;
  interceptorsLeft?: number;
  killHistory?: ShipKillRecord[];
}
```

Types de vaisseaux et statistiques associées :

```typescript
export enum ShipType {
  CARRIER = 'carrier',
  CRUISER = 'cruiser',
  DESTROYER = 'destroyer',
  FRIGATE = 'frigate',
  FIGHTER = 'fighter',
  BOMBER = 'bomber',
  TROOP_TRANSPORT = 'troop_transport',
}

export interface ShipStats {
  maxHp: number;
  damage: number;
  speed: number;
  cost: number;
  pdStrength: number;
  evasion: number;
  maneuverability: number;
  offensiveMissileStock: number;
  missileDamage: number;
  torpedoStock: number;
  torpedoDamage: number;
  interceptorStock: number;
  role: 'capital' | 'screen' | 'striker' | 'transport';
}
```

Exemple d'état de flotte (valeurs d'enum en minuscules) :

```json
{
  "id": "fleet_01",
  "factionId": "red",
  "state": "orbit",
  "targetSystemId": null,
  "ships": [
    { "id": "ship_a", "type": "carrier", "hp": 120, "maxHp": 200, "carriedArmyId": null }
  ]
}
```

## Armées

```typescript
export interface Army {
  id: string;
  factionId: FactionId;
  strength: number;
  maxStrength: number;
  morale: number;
  state: ArmyState;
  containerId: string;
}
```

`containerId` référence soit une flotte (armée embarquée), soit un système stellaire (armée déployée).

## Combats

```typescript
export type BattleStatus = 'scheduled' | 'resolved';

export interface Battle {
  id: string;
  systemId: string;
  turnCreated: number;
  turnResolved?: number;
  status: BattleStatus;
  involvedFleetIds: string[];
  logs: string[];
  initialShips?: BattleShipSnapshot[];
  survivorShipIds?: string[];
  winnerFactionId?: FactionId | 'draw';
  roundsPlayed?: number;
  shipsLost?: Record<FactionId, number>;
  missilesIntercepted?: number;
  projectilesDestroyedByPd?: number;
  ammunitionByFaction?: BattleAmmunitionByFaction;
}
```

Exemple minimal :

```json
{
  "id": "battle_alpha",
  "systemId": "sol",
  "turnCreated": 12,
  "status": "resolved",
  "involvedFleetIds": ["fleet_01", "fleet_02"],
  "winnerFactionId": "red"
}
```

## Objectifs et règles de partie

```typescript
export type VictoryType = 'elimination' | 'domination' | 'survival' | 'king_of_the_hill';

export interface VictoryCondition {
  type: VictoryType;
  value?: number | string;
}

export interface GameObjectives {
  conditions: VictoryCondition[];
  maxTurns?: number;
}

export interface GameplayRules {
  fogOfWar: boolean;
  useAdvancedCombat: boolean;
  aiEnabled: boolean;
  totalWar: boolean;
}
```

## Messages et journaux

```typescript
export interface LogEntry {
  id: string;
  day: number;
  text: string;
  type: 'info' | 'combat' | 'move' | 'ai';
}

export interface GameMessage {
  id: string;
  day: number;
  type: string;
  priority: number;
  title: string;
  subtitle: string;
  lines: string[];
  payload: Record<string, unknown>;
  read: boolean;
  dismissed: boolean;
  createdAtTurn: number;
}
```

## GameState (agrégat)

```typescript
export interface GameState {
  scenarioId: string;
  scenarioTitle?: string;
  playerFactionId: FactionId;
  factions: FactionState[];
  seed: number;
  rngState: number;
  startYear: number;
  day: number;
  systems: StarSystem[];
  fleets: Fleet[];
  armies: Army[];
  lasers: LaserShot[];
  battles: Battle[];
  logs: LogEntry[];
  messages: GameMessage[];
  selectedFleetId: string | null;
  winnerFactionId: FactionId | 'draw' | null;
  aiStates?: Record<FactionId, AIState>;
  aiState?: AIState;
  objectives: GameObjectives;
  rules: GameplayRules;
}
```

## Commandes moteur (`GameCommand`)

```typescript
export type GameCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'AI_UPDATE_STATE'; factionId: FactionId; newState: AIState; primaryAi?: boolean }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; planetId: string; reason?: string }
  | { type: 'TRANSFER_ARMY_PLANET'; armyId: string; fromPlanetId: string; toPlanetId: string; systemId: string; reason?: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_LOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_UNLOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number };
```
