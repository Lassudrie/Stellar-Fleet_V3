
import { GameState, Battle, FactionId, Fleet, ShipEntity, ShipType, FleetState, BattleShipSnapshot } from '../../types';
import { RNG } from '../../engine/rng';
import { SHIP_STATS } from '../../data/static';
import { BattleShipState, Projectile } from './types';
import { selectTarget } from './targeting';
import {
  MAX_ROUNDS, ETA_MISSILE, ETA_TORPEDO,
  BASE_ACCURACY, LOCK_GAIN_PER_ROUND, MAX_LAUNCH_PER_ROUND,
  INTERCEPTION_BASE_CHANCE, PD_DAMAGE_PER_POINT, MISSILE_HP, TORPEDO_HP
} from './constants';
import { withUpdatedFleetDerived } from '../../engine/fleetDerived';

const SURVIVOR_ATTRITION_RATIO = 0.1;
const SURVIVOR_MIN_POST_BATTLE_DAMAGE = 15;

// --- HELPERS ---

const createBattleShip = (ship: ShipEntity, fleetId: string, faction: FactionId): BattleShipState | null => {
  if (!ship || !ship.type) {
      console.error(`[Battle] Invalid ship passed to createBattleShip: ${JSON.stringify(ship)}. Skipping.`);
      return null;
  }
  const stats = SHIP_STATS[ship.type];
  if (!stats) {
       console.warn(`[Battle] Unknown ship type '${ship.type}' for ship ${ship.id}. Using fallback stats.`);
  }

  const maxHp = ship.maxHp ?? stats?.maxHp ?? 100;
  const currentHp = Math.min(ship.hp, maxHp);
  const missilesLeft = stats?.missileStock ?? 0;
  const torpedoesLeft = stats?.torpedoStock ?? 0;
  const evasion = stats?.evasion ?? 0.1;
  const pdStrength = stats?.pdStrength ?? 0;
  const damage = stats?.damage ?? 10;
  const missileDamage = stats?.missileDamage ?? 0;
  const torpedoDamage = stats?.torpedoDamage ?? 0;

  return {
    shipId: ship.id,
    fleetId,
    faction,
    type: ship.type,
    currentHp,
    maxHp,
    missilesLeft,
    torpedoesLeft,
    fireControlLock: 0,
    maneuverBudget: 0.5,
    targetId: null,
    evasion,
    pdStrength,
    damage,
    missileDamage,
    torpedoDamage
  };
};

const short = (id: string) => id.split('_').pop()?.toUpperCase() || '???';

// --- RESOLVER ---

// Optimization: Removed unused masterRng param. The battle creates its own isolated RNG.
export const resolveBattle = (
  battle: Battle,
  state: GameState,
  turn: number
): { updatedBattle: Battle, survivingFleets: Fleet[] } => {
  // 1. SETUP - Isolate Determinism
  let seedHash = 0;
  const seedString = `${battle.id}_${battle.turnCreated}`;
  for (let i = 0; i < seedString.length; i++) seedHash = (seedHash << 5) - seedHash + seedString.charCodeAt(i);
  
  const rng = new RNG(state.seed + seedHash); 

  // 2. INITIALIZE BATTLE STATE
  const involvedFleets = state.fleets.filter(f => battle.involvedFleetIds.includes(f.id));
  
  // --- CAPTURE SNAPSHOT BEFORE SIMULATION ---
  const initialShips: BattleShipSnapshot[] = [];
  
  // Deterministic ship initialization
  const battleShips: BattleShipState[] = [];
  
  // We use a Map for O(1) lookups during the hot loop
  const shipMap = new Map<string, BattleShipState>();

  involvedFleets.forEach(f => {
    f.ships.forEach(s => {
      if (s && s.type) {
        // State - create battle ship first to validate
        const bs = createBattleShip(s, f.id, f.factionId);
        if (!bs) {
          // Skip invalid ships - already logged in createBattleShip
          return;
        }
        // Snapshot (only if ship is valid)
        initialShips.push({
            shipId: s.id,
            fleetId: f.id,
            factionId: f.factionId,
            type: s.type,
            maxHp: s.maxHp,
            startingHp: s.hp
        });
        battleShips.push(bs);
        shipMap.set(s.id, bs);
      }
    });
  });
  
  // Deterministic Sort of snapshot and logic array
  initialShips.sort((a, b) => a.shipId.localeCompare(b.shipId));
  battleShips.sort((a, b) => a.shipId.localeCompare(b.shipId));

  // Safety guard: if no valid ships, return early with a draw
  if (battleShips.length === 0) {
    console.warn(`[Battle] No valid ships in battle ${battle.id}. Resolving as draw.`);
    return {
      updatedBattle: {
        ...battle,
        turnResolved: turn,
        status: 'resolved',
        initialShips: [],
        logs: [...battle.logs, 'Battle resolved as draw - no valid combatants.'],
        winnerFactionId: 'draw',
        roundsPlayed: 0,
        shipsLost: {},
        survivorShipIds: [],
        missilesIntercepted: 0,
        projectilesDestroyedByPd: 0
      },
      survivingFleets: involvedFleets // Return fleets unchanged
    };
  }

  const projectiles: Projectile[] = [];
  const logs: string[] = [];
  let roundsPlayed = 0;
  
  // Stats
  let totalMissilesIntercepted = 0;
  let totalProjectilesDestroyedByPd = 0;

  // 3. ROUND LOOP
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    roundsPlayed = round;

    // Check for combat viability at start of round
    const aliveFactions = new Set(battleShips.filter(s => s.currentHp > 0).map(s => s.faction));
    if (aliveFactions.size <= 1) break;

    logs.push(`--- ROUND ${round} ---`);
    
    // --- PHASE 1: FLIGHT UPDATES ---
    // Update ETA for EXISTING projectiles. 
    for(const p of projectiles) {
        if (p.eta > 0) p.eta--;
    }

    // Identify active participants (Array iteration is fine here as we need to process all)
    const activeShips = battleShips.filter(s => s.currentHp > 0);

    // --- PHASE 2: TARGETING ---
    for (const ship of activeShips) {
      const enemies = battleShips.filter(
        s => s.currentHp > 0 && s.faction !== ship.faction
      );
      ship.targetId = selectTarget(ship, enemies, rng.next());
    }

    // --- PHASE 3: MANEUVER ---
    for (const ship of activeShips) {
      if (ship.targetId) {
        ship.fireControlLock = Math.min(1.0, ship.fireControlLock + LOCK_GAIN_PER_ROUND);
      } else {
        ship.fireControlLock = Math.max(0, ship.fireControlLock - 0.1);
      }
    }

    // --- PHASE 4: LAUNCH ---
    for (const ship of activeShips) {
      if (!ship.targetId) continue;

      if (ship.torpedoesLeft > 0) {
        const count = Math.min(ship.torpedoesLeft, MAX_LAUNCH_PER_ROUND);
        for (let k = 0; k < count; k++) {
          projectiles.push({
            id: rng.id('torp'),
            type: 'torpedo',
            sourceId: ship.shipId,
            sourceFaction: ship.faction,
            targetId: ship.targetId,
            eta: ETA_TORPEDO,
            damage: ship.torpedoDamage,
            hp: TORPEDO_HP
          });
        }
        ship.torpedoesLeft -= count;
        if (count > 0) logs.push(`${short(ship.shipId)} (${ship.type}) fired ${count} torpedoes [ETA:${ETA_TORPEDO}].`);
      } 
      else if (ship.missilesLeft > 0) {
        const count = Math.min(ship.missilesLeft, MAX_LAUNCH_PER_ROUND);
        for (let k = 0; k < count; k++) {
          projectiles.push({
            id: rng.id('msl'),
            type: 'missile',
            sourceId: ship.shipId,
            sourceFaction: ship.faction,
            targetId: ship.targetId,
            eta: ETA_MISSILE,
            damage: ship.missileDamage,
            hp: MISSILE_HP
          });
        }
        ship.missilesLeft -= count;
        if (count > 0) logs.push(`${short(ship.shipId)} (${ship.type}) fired ${count} missiles [ETA:${ETA_MISSILE}].`);
      }
    }

    // --- PHASE 5: INTERCEPTION (Soft Kill) ---
    // Optimization: Build a ThreatQueue to avoid repeated filters
    const interceptionThreats = new Map<string, Projectile[]>();
    
    // Filter potential threats (ETA 0 or 1) and group by target
    for (const p of projectiles) {
        if ((p.eta === 0 || p.eta === 1) && p.hp > 0) {
            if (!interceptionThreats.has(p.targetId)) interceptionThreats.set(p.targetId, []);
            interceptionThreats.get(p.targetId)!.push(p);
        }
    }

    // Deterministic Iteration: Sort Target IDs
    const interceptionTargets = Array.from(interceptionThreats.keys()).sort();

    for (const targetId of interceptionTargets) {
        const defender = shipMap.get(targetId);
        if (!defender || defender.currentHp <= 0) continue;

        const incoming = interceptionThreats.get(targetId)!;
        
        // Try to intercept each incoming missile
        for (const p of incoming) {
            if (p.hp <= 0) continue; // Already destroyed by another interceptor (rare in 1v1 mapping but possible in future)

            if (defender.missilesLeft > 0 && rng.next() > 0.5) {
                defender.missilesLeft--;
                if (rng.next() < INTERCEPTION_BASE_CHANCE) {
                    p.hp = 0; 
                    logs.push(`>> ${short(defender.shipId)} intercepted incoming ${p.type}.`);
                    totalMissilesIntercepted++;
                }
            }
        }
    }

    // Cleanup dead projectiles
    let aliveCount = 0;
    for(let i=0; i<projectiles.length; i++) {
        if (projectiles[i].hp > 0) {
            projectiles[aliveCount++] = projectiles[i];
        }
    }
    projectiles.length = aliveCount;


    // --- PHASE 6: PD (Hard Kill) ---
    // Only affects projectiles hitting THIS round (ETA 0)
    const pdThreats = new Map<string, Projectile[]>();
    for (const p of projectiles) {
        if (p.eta === 0 && p.hp > 0) {
            if (!pdThreats.has(p.targetId)) pdThreats.set(p.targetId, []);
            pdThreats.get(p.targetId)!.push(p);
        }
    }

    const pdTargets = Array.from(pdThreats.keys()).sort();

    for (const targetId of pdTargets) {
        const defender = shipMap.get(targetId);
        if (!defender || defender.currentHp <= 0) continue;

        let pdOutput = defender.pdStrength * PD_DAMAGE_PER_POINT;
        const incoming = pdThreats.get(targetId)!;

        for (const threat of incoming) {
            if (pdOutput <= 0) break;

            const dmg = Math.min(threat.hp, pdOutput);
            threat.hp -= dmg;
            pdOutput -= dmg;

            if (threat.hp <= 0) {
                 logs.push(`>> PD from ${short(defender.shipId)} destroyed ${threat.type}.`);
                 totalProjectilesDestroyedByPd++;
            }
        }
    }

    // --- PHASE 7: IMPACTS & KINETIC ---
    // We reuse the cleaned projectiles array, but check HP and ETA again.
    // (PD might have killed some with ETA 0 just now)
    
    // Process Missile/Torpedo Impacts
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        if (p.eta === 0) {
            // It hit this round (if alive)
            if (p.hp > 0) {
                const target = shipMap.get(p.targetId);
                if (target && target.currentHp > 0) {
                    target.currentHp -= p.damage;
                    logs.push(`!! ${short(target.shipId)} hit by ${p.type} for ${p.damage} dmg.`);
                }
            }
            // Remove from simulation (Hit or Killed by PD)
            projectiles.splice(i, 1);
        }
    }

    // Kinetic Fire (Instant)
    for (const attacker of activeShips) {
        if (!attacker.targetId) continue;
        const target = shipMap.get(attacker.targetId);
        
        if (!target || target.currentHp <= 0) continue;

        const hitChance = BASE_ACCURACY * Math.max(0.1, attacker.fireControlLock) * (1 - target.evasion);
        if (rng.next() < hitChance) {
            const dmg = attacker.damage;
            target.currentHp -= dmg;
            logs.push(`  ${short(attacker.shipId)} guns hit ${short(target.shipId)} [${dmg} dmg]`);
        }
    }
  }

  // 4. FINALIZE & APPLY RESULTS
  
  const survivingFleets: Fleet[] = [];
  const survivorShipIds: string[] = [];

  involvedFleets.forEach(oldFleet => {
    const newShips: ShipEntity[] = [];
    oldFleet.ships.forEach(oldShip => {
        // Optimized O(1) Lookup
        const battleState = shipMap.get(oldShip.id);
        if (battleState && battleState.currentHp > 0) {
            newShips.push({
                ...oldShip,
                hp: battleState.currentHp
            });
            survivorShipIds.push(oldShip.id); // Collect survivor ID
        }
    });

    if (newShips.length > 0) {
        // Update fleet with new ships AND new derived stats (radius)
        const updatedFleet = withUpdatedFleetDerived({
            ...oldFleet,
            ships: newShips,
            state: FleetState.ORBIT,
            stateStartTurn: turn // Correctly update state timestamp to current turn
        });
        survivingFleets.push(updatedFleet);
    }
  });

  // Apply post-battle attrition so survivors need repairs before returning to duty
  const attritionLogs: string[] = [];
  const adjustedSurvivorIds: string[] = [];
  const attritionAdjustedFleets: Fleet[] = [];

  survivingFleets.forEach(fleet => {
    const penalizedShips: ShipEntity[] = [];

    fleet.ships.forEach(ship => {
      const attritionDamage = Math.max(
        Math.floor(ship.maxHp * SURVIVOR_ATTRITION_RATIO),
        SURVIVOR_MIN_POST_BATTLE_DAMAGE
      );
      const remainingHp = Math.max(0, ship.hp - attritionDamage);
      const battleState = shipMap.get(ship.id);

      if (battleState) {
        battleState.currentHp = remainingHp;
      }

      if (remainingHp > 0) {
        penalizedShips.push({ ...ship, hp: remainingHp });
        adjustedSurvivorIds.push(ship.id);
        attritionLogs.push(`-- ${short(ship.id)} is undergoing repairs (-${attritionDamage} hp).`);
      } else {
        attritionLogs.push(`xx ${short(ship.id)} was lost to post-battle failures.`);
      }
    });

    if (penalizedShips.length > 0) {
      attritionAdjustedFleets.push(
        withUpdatedFleetDerived({ ...fleet, ships: penalizedShips, stateStartTurn: turn })
      );
    }
  });

  survivorShipIds.length = 0;
  survivorShipIds.push(...adjustedSurvivorIds);

  survivingFleets.length = 0;
  survivingFleets.push(...attritionAdjustedFleets);

  logs.push(...attritionLogs);

  const aliveFactions = new Set(battleShips.filter(s => s.currentHp > 0).map(s => s.faction));
  const winnerFactionId: FactionId | 'draw' = aliveFactions.size === 1
    ? (Array.from(aliveFactions)[0] as FactionId)
    : 'draw';

  logs.push(`BATTLE ENDED. Winner: ${winnerFactionId.toUpperCase()}`);

  const shipsLost: Record<FactionId, number> = {};
  battleShips.forEach(s => {
      if (s.currentHp <= 0) {
          shipsLost[s.faction] = (shipsLost[s.faction] ?? 0) + 1;
      } else {
          shipsLost[s.faction] = shipsLost[s.faction] ?? 0;
      }
  });

  const updatedBattle: Battle = {
      ...battle,
      turnResolved: turn,
      status: 'resolved',
      initialShips: initialShips,
      logs: [...battle.logs, ...logs],
      winnerFactionId,
      roundsPlayed,
      shipsLost,
      survivorShipIds, // Store survivor list
      missilesIntercepted: totalMissilesIntercepted,
      projectilesDestroyedByPd: totalProjectilesDestroyedByPd
  };

  return { updatedBattle, survivingFleets };
};
