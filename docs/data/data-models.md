
# Modèles de Données

## Entités Principales

### GameState
L'objet racine qui contient tout l'état de la simulation.
```typescript
interface GameState {
  seed: number;       // Seed initiale
  rngState: number;   // État courant du curseur RNG
  day: number;        // Tour actuel
  systems: StarSystem[];
  fleets: Fleet[];
  armies: Army[];     // Liste globale des armées (au sol ou embarquées)
  battles: Battle[];  // Liste des conflits (Actifs et Passés)
  logs: LogEntry[];   // Historique des événements
  winnerFactionId: string | 'draw' | null; // FactionId ou nul si la partie continue
}
```

### Army & Ground Forces
Représente une division d'infanterie planétaire.
```typescript
enum ArmyState {
  EMBARKED = 'embarked',   // Dans un vaisseau (Link via containerId = FleetID)
  IN_TRANSIT = 'inTransit', // Flotte en mouvement (Logique interne)
  DEPLOYED = 'deployed'    // Au sol (Link via containerId = SystemID)
}

interface Army {
  id: string;
  faction: Faction;
  strength: number;    // Effectif (Min 10,000)
  state: ArmyState;
  containerId: string; // ID du Système ou de la Flotte
}
```

### StarSystem
Représente un nœud sur la carte galactique.
```typescript
interface StarSystem {
  id: string;
  position: Vector3; // Three.js Vector3
  owner: Faction | null;
  resourceType: 'gas' | 'none';
  // ...props visuelles
}
```

### Fleet & Ships
Une flotte contient une liste de vaisseaux. Les vaisseaux sont des entités individuelles.
```typescript
interface Fleet {
  id: string;
  faction: Faction;
  state: 'orbit' | 'moving' | 'combat';
  position: Vector3;
  targetSystemId: string | null; // Destination si moving
  ships: ShipEntity[];
}

interface ShipEntity {
  id: string;
  type: ShipType; // 'carrier' | 'troop_transport' | ...
  hp: number;
  maxHp: number;
  carriedArmyId?: string | null; // ID de l'armée transportée (si Transport)
  consumables?: {
    offensiveMissiles: number;
    torpedoes: number;
    interceptors: number;
  }; // Stocks consommables courants
  killHistory?: Array<{
    id: string;
    day: number;
    turn: number;
    targetId: string;
    targetType: ShipType;
    targetFactionId: string;
  }>; // Historique des destructions confirmées par ce vaisseau
}
```

### GameCommand (Actions Joueur)
Commandes dispatchées au moteur pour modifier l'état.
```typescript
type GameCommand = 
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
  | { type: 'SPLIT_FLEET'; originalFleetId: string; shipIds: string[] }
  | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
  // Opérations Armée
  | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string };
```

### Battle (V1)
Structure persistante pour gérer les combats sur plusieurs phases.
```typescript
interface Battle {
  id: string;
  systemId: string;
  turnCreated: number;
  status: 'scheduled' | 'resolved';
  turnResolved?: number;
  involvedFleetIds: string[];
  logs: string[]; // Logs textuels détaillés du combat
  shipsLost?: Record<string, number>; // Clefs = FactionId
}
```

## Données Statiques (`data/static.ts`)
Les constantes d'équilibrage ne sont pas dans l'état, elles sont codées en dur ("Data-Driven" via code).

### ShipStats
Définit les capacités de chaque classe de vaisseau.
```typescript
interface ShipStats {
  maxHp: number;
  damage: number;       // Dégâts cinétiques
  speed: number;        // Modificateur de vitesse de flotte
  pdStrength: number;   // Capacité anti-missile
  evasion: number;      // 0.0 - 1.0
  offensiveMissileStock: number;
  missileDamage: number;
  torpedoStock: number;
  torpedoDamage: number;
  interceptorStock: number;
  role: 'capital' | 'screen' | 'striker' | 'transport';
}
```
