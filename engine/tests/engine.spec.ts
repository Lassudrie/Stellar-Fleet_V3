import assert from 'node:assert';
import path from 'node:path';
import { isOrbitContested, resolveGroundConflict } from '../conquest';
import { sanitizeArmyLinks } from '../army';
import { CAPTURE_RANGE, COLORS } from '../../data/static';
import { AI_HOLD_TURNS } from '../ai';
import { applyCommand } from '../commands';
import {
  Army,
  ArmyState,
  Battle,
  FactionState,
  Fleet,
  FleetState,
  GameObjectives,
  GameplayRules,
  GameState,
  LogEntry,
  ShipEntity,
  ShipType,
  StarSystem
} from '../../types';
import { Vec3 } from '../math/vec3';
import { runTurn } from '../runTurn';
import { RNG } from '../rng';
import { phaseGround } from '../turn/phases/05_ground';
import ts from 'typescript';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: COLORS.blue, isPlayable: true },
  { id: 'red', name: 'Red', color: COLORS.red, isPlayable: true },
  { id: 'green', name: 'Green', color: '#10b981', isPlayable: false, aiProfile: 'aggressive' }
];

const baseVec: Vec3 = { x: 0, y: 0, z: 0 };

const createSystem = (id: string, ownerFactionId: string | null): StarSystem => ({
  id,
  name: id,
  position: baseVec,
  color: ownerFactionId === 'blue' ? COLORS.blue : ownerFactionId === 'red' ? COLORS.red : COLORS.star,
  size: 1,
  ownerFactionId,
  resourceType: 'none',
  isHomeworld: false
});

const createFleet = (id: string, factionId: string, position: Vec3, ships: ShipEntity[]): Fleet => ({
  id,
  factionId,
  ships,
  position,
  state: FleetState.ORBIT,
  targetSystemId: null,
  targetPosition: null,
  radius: 1,
  stateStartTurn: 0
});

const createArmy = (
  id: string,
  factionId: string,
  strength: number,
  state: ArmyState,
  containerId: string
): Army => ({
  id,
  factionId,
  strength,
  maxStrength: strength,
  morale: 1,
  state,
  containerId
});

const createBaseState = (overrides: Partial<GameState>): GameState => {
  const defaultRules: GameplayRules = {
    fogOfWar: false,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: false
  };

  const defaultObjectives: GameObjectives = {
    conditions: []
  };

  const { rules = defaultRules, objectives = defaultObjectives, ...restOverrides } = overrides;

  return {
    scenarioId: 'test',
    playerFactionId: 'blue',
    factions,
    seed: 1,
    rngState: 1,
    startYear: 0,
    day: 0,
    systems: [],
    fleets: [],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    selectedFleetId: null,
    winnerFactionId: null,
    objectives,
    rules,
    ...restOverrides
  };
};

const tests: TestCase[] = [
  {
    name: 'Unopposed conquest is blocked by contested orbit',
    run: () => {
      const system = createSystem('sys-1', 'red');

      const blueArmy = createArmy('army-blue', 'blue', 12000, ArmyState.DEPLOYED, system.id);
      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [
        { id: 'blue-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);
      const redFleet = createFleet('fleet-red', 'red', { x: CAPTURE_RANGE - 1, y: 0, z: 0 }, [
        { id: 'red-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const state = createBaseState({ systems: [system], armies: [blueArmy], fleets: [blueFleet, redFleet] });

      const result = resolveGroundConflict(system, state);
      assert.ok(result, 'Ground conflict should resolve');
      assert.strictEqual(result?.winnerFactionId, 'blue');
      assert.strictEqual(result?.conquestOccurred, false, 'Conquest must be blocked by contested orbit');
      assert.deepStrictEqual(result?.armiesDestroyed, [], 'Unopposed assault should not destroy armies');
    }
  },
  {
    name: 'Orbit is only contested when multiple factions are present',
    run: () => {
      const system = createSystem('sys-2a', 'blue');

      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [
        { id: 'blue-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const stateWithSingleFaction = createBaseState({ systems: [system], fleets: [blueFleet] });
      assert.strictEqual(
        isOrbitContested(system, stateWithSingleFaction),
        false,
        'Single faction presence should not contest orbit'
      );

      const greenFleet = createFleet('fleet-green', 'green', { x: CAPTURE_RANGE - 1, y: 0, z: 0 }, [
        { id: 'green-ship', type: ShipType.FIGHTER, hp: 50, maxHp: 50, carriedArmyId: null }
      ]);

      const stateWithTwoFactions = createBaseState({ systems: [system], fleets: [blueFleet, greenFleet] });
      assert.strictEqual(
        isOrbitContested(system, stateWithTwoFactions),
        true,
        'Different factions in range should contest orbit'
      );

      const emptyRedFleet = createFleet('fleet-red', 'red', { x: CAPTURE_RANGE - 1, y: 0, z: 0 }, []);
      const stateWithEmptyFleet = createBaseState({ systems: [system], fleets: [blueFleet, emptyRedFleet] });
      assert.strictEqual(
        isOrbitContested(system, stateWithEmptyFleet),
        false,
        'Fleets without ships should not contribute to contesting'
      );
    }
  },
  {
    name: '10k vs 10k armies survive initial clash under new threshold',
    run: () => {
      const system = createSystem('sys-2', 'blue');
      const blueArmy = createArmy('army-blue-10k', 'blue', 10000, ArmyState.DEPLOYED, system.id);
      const redArmy = createArmy('army-red-10k', 'red', 10000, ArmyState.DEPLOYED, system.id);

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system, state);
      assert.ok(result, 'Ground conflict should resolve');
      assert.strictEqual(result?.winnerFactionId, 'draw', 'Balanced forces should stalemate');
      assert.strictEqual(result?.conquestOccurred, false, 'Stalemate cannot trigger conquest');
      assert.deepStrictEqual(result?.armiesDestroyed, [], 'Threshold should prevent immediate destruction');

      const blueUpdate = result?.armyUpdates.find(update => update.armyId === blueArmy.id);
      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(blueUpdate && blueUpdate.strength > 2000, 'Blue army should survive above destruction threshold');
      assert.ok(redUpdate && redUpdate.strength > 2000, 'Red army should survive above destruction threshold');
    }
  },
  {
    name: 'Damaged attackers are still removed when defenders already own the system',
    run: () => {
      const system = createSystem('sys-5', 'blue');
      const blueArmy = createArmy('army-blue-hold', 'blue', 12000, ArmyState.DEPLOYED, system.id);
      const redArmy: Army = {
        id: 'army-red-broken',
        factionId: 'red',
        strength: 1500,
        maxStrength: 20000,
        morale: 0.5,
        state: ArmyState.DEPLOYED,
        containerId: system.id
      };

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const result = resolveGroundConflict(system, state);
      assert.ok(result, 'Ground conflict should be reported even without conquest');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Defenders should be considered the winners');
      assert.ok(result?.armiesDestroyed.includes(redArmy.id), 'Damaged attackers should be destroyed');

      const redUpdate = result?.armyUpdates.find(update => update.armyId === redArmy.id);
      assert.ok(redUpdate, 'Red army should receive an update before removal');
      assert.ok(redUpdate!.strength < redArmy.strength, 'Red army should lose strength from the fight');
    }
  },
  {
    name: 'Unloading proceeds safely when orbit is clear',
    run: () => {
      const system = createSystem('sys-unload-clear', null);
      const transport: ShipEntity = {
        id: 'blue-transport',
        type: ShipType.TROOP_TRANSPORT,
        hp: 50,
        maxHp: 50,
        carriedArmyId: 'army-blue-unload'
      };

      const blueArmy = createArmy(transport.carriedArmyId!, 'blue', 8000, ArmyState.EMBARKED, 'fleet-blue');
      const blueFleet = createFleet('fleet-blue', 'blue', { ...baseVec }, [transport]);

      const state = createBaseState({ systems: [system], fleets: [blueFleet], armies: [blueArmy] });
      const rng = new RNG(1);

      const updated = applyCommand(
        state,
        { type: 'UNLOAD_ARMY', fleetId: blueFleet.id, shipId: transport.id, armyId: blueArmy.id, systemId: system.id },
        rng
      );

      const unloadedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.ok(unloadedArmy, 'Army should still exist after unloading');
      assert.strictEqual(unloadedArmy?.state, ArmyState.DEPLOYED, 'Army must be deployed on the surface');
      assert.strictEqual(unloadedArmy?.containerId, system.id, 'Army container should move to the system');
      assert.strictEqual(unloadedArmy?.strength, blueArmy.strength, 'No risk should apply in a clear orbit');

      const combatLogs = updated.logs.filter(log => log.type === 'combat');
      assert.strictEqual(combatLogs.length, 0, 'No combat logs should be generated when orbit is clear');
    }
  },
  {
    name: 'Contested orbit applies deterministic risk to unloading armies',
    run: () => {
      const system = createSystem('sys-unload-risk', null);
      const transport: ShipEntity = {
        id: 'blue-risk-transport',
        type: ShipType.TROOP_TRANSPORT,
        hp: 50,
        maxHp: 50,
        carriedArmyId: 'army-blue-risk'
      };

      const blueArmy = createArmy(transport.carriedArmyId!, 'blue', 9000, ArmyState.EMBARKED, 'fleet-blue-risk');
      const blueFleet = createFleet('fleet-blue-risk', 'blue', { ...baseVec }, [transport]);
      const redFleet = createFleet(
        'fleet-red-risk',
        'red',
        { x: CAPTURE_RANGE - 0.5, y: 0, z: 0 },
        [{ id: 'red-escort', type: ShipType.FIGHTER, hp: 40, maxHp: 40, carriedArmyId: null }]
      );

      const state = createBaseState({ systems: [system], fleets: [blueFleet, redFleet], armies: [blueArmy] });
      const rng = new RNG(7); // Deterministic roll below threshold to trigger losses

      const updated = applyCommand(
        state,
        {
          type: 'UNLOAD_ARMY',
          fleetId: blueFleet.id,
          shipId: transport.id,
          armyId: blueArmy.id,
          systemId: system.id
        },
        rng
      );

      const unloadedArmy = updated.armies.find(army => army.id === blueArmy.id);
      assert.ok(unloadedArmy, 'Army should persist after contested unload');
      assert.strictEqual(unloadedArmy?.state, ArmyState.DEPLOYED, 'Army must still disembark');
      assert.strictEqual(unloadedArmy?.containerId, system.id, 'Army container should move to the system');
      assert.ok(
        (unloadedArmy?.strength ?? 0) < blueArmy.strength,
        'Contested unload should apply deterministic strength loss'
      );

      const combatLog = updated.logs.find(log => log.type === 'combat');
      assert.ok(combatLog, 'Risk resolution should produce a combat log');
      assert.ok(
        combatLog?.text.includes('took fire'),
        'Combat log should record the contested drop losses'
      );
    }
  },
  {
    name: 'Multi-faction ground battle with a defender uses the attacker coalition rule',
    run: () => {
      const system = createSystem('sys-coalition-hold', 'red');

      const redArmy = createArmy('army-red', 'red', 10000, ArmyState.DEPLOYED, system.id);
      const blueArmy = createArmy('army-blue', 'blue', 4000, ArmyState.DEPLOYED, system.id);
      const greenArmy = createArmy('army-green', 'green', 3000, ArmyState.DEPLOYED, system.id);

      const state = createBaseState({ systems: [system], armies: [redArmy, blueArmy, greenArmy] });

      const result = resolveGroundConflict(system, state);

      assert.ok(result, 'Ground conflict should be resolved when multiple factions are present');
      assert.strictEqual(result?.winnerFactionId, 'red', 'Defenders should keep control against a weaker coalition');
      assert.strictEqual(result?.casualties.length, 3, 'All involved factions should be tracked in the casualty report');
      assert.ok(
        result?.logs.some(log => log.includes('attacker coalition vs defender')),
        'Logs should describe the coalition vs defender resolution rule'
      );
    }
  },
  {
    name: 'The strongest surviving attacker claims conquest after a coalition victory',
    run: () => {
      const system = createSystem('sys-coalition-win', 'red');

      const redArmy = createArmy('army-red-win', 'red', 3000, ArmyState.DEPLOYED, system.id);
      const blueArmy = createArmy('army-blue-win', 'blue', 9000, ArmyState.DEPLOYED, system.id);
      const greenArmy = createArmy('army-green-win', 'green', 7000, ArmyState.DEPLOYED, system.id);

      const state = createBaseState({ systems: [system], armies: [redArmy, blueArmy, greenArmy] });

      const result = resolveGroundConflict(system, state);

      assert.ok(result, 'Ground conflict should resolve for coalition attacks');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Top surviving attacker should be credited with the coalition win');
      assert.ok(
        result?.logs.some(log => log.includes('attacker coalition vs defender')),
        'Logs should highlight the coalition rule when attackers cooperate'
      );
    }
  },
  {
    name: 'Free-for-all fights remain supported on neutral ground',
    run: () => {
      const system = createSystem('sys-ffa', null);

      const alphaArmy = createArmy('army-alpha', 'blue', 6000, ArmyState.DEPLOYED, system.id);
      const betaArmy = createArmy('army-beta', 'red', 4000, ArmyState.DEPLOYED, system.id);
      const gammaArmy = createArmy('army-gamma', 'green', 2000, ArmyState.DEPLOYED, system.id);

      const state = createBaseState({ systems: [system], armies: [alphaArmy, betaArmy, gammaArmy] });

      const result = resolveGroundConflict(system, state);

      assert.ok(result, 'Free-for-all ground conflicts should resolve');
      assert.strictEqual(result?.winnerFactionId, 'blue', 'Highest remaining ground power should win on neutral ground');
      assert.ok(result?.logs.some(log => log.includes('free-for-all')), 'Logs should describe the free-for-all rule');
    }
  },
  {
    name: 'Exhausted invaders are cleared so the ground battle does not loop',
    run: () => {
      const system = createSystem('sys-loop-1', 'blue');
      const blueArmy = createArmy('army-blue-loop', 'blue', 18000, ArmyState.DEPLOYED, system.id);
      const redArmy: Army = {
        id: 'army-red-loop',
        factionId: 'red',
        strength: 0,
        maxStrength: 20000,
        morale: 0.8,
        state: ArmyState.DEPLOYED,
        containerId: system.id
      };

      const state = createBaseState({ systems: [system], armies: [blueArmy, redArmy] });

      const firstResult = resolveGroundConflict(system, state);
      assert.ok(firstResult, 'Ground conflict should resolve even with exhausted invaders present');
      assert.strictEqual(firstResult?.winnerFactionId, 'blue', 'Defenders should secure their own system');
      assert.ok(firstResult?.armiesDestroyed.includes(redArmy.id), 'Invading army at zero strength must be removed');

      const updatedState: GameState = {
        ...state,
        armies: state.armies
          .map(army => {
            const update = firstResult?.armyUpdates.find(entry => entry.armyId === army.id);
            return update ? { ...army, strength: update.strength, morale: update.morale } : army;
          })
          .filter(army => !(firstResult?.armiesDestroyed || []).includes(army.id))
      };

      const followUp = resolveGroundConflict(system, updatedState);
      assert.strictEqual(followUp, null, 'Once the attacker is destroyed, the ground battle should not loop');
    }
  },
  {
    name: 'Embarked armies are lost if their transport dies before invasion',
    run: () => {
      const system = createSystem('sys-contested', 'red');

      const blueArmy = createArmy('army-blue-embarked', 'blue', 12000, ArmyState.EMBARKED, 'fleet-blue-transport');
      const blueTransport = createFleet('fleet-blue-transport', 'blue', { ...baseVec }, [
        { id: 'blue-transport', type: ShipType.TROOP_TRANSPORT, hp: 1, maxHp: 2000, carriedArmyId: blueArmy.id }
      ]);

      const redFleet = createFleet('fleet-red-intercept', 'red', { ...baseVec }, [
        { id: 'red-cruiser', type: ShipType.CRUISER, hp: 1200, maxHp: 1200, carriedArmyId: null }
      ]);

      const scheduledBattle: Battle = {
        id: 'battle-contested',
        systemId: system.id,
        turnCreated: 0,
        status: 'scheduled',
        involvedFleetIds: [blueTransport.id, redFleet.id],
        logs: []
      };

      const state = createBaseState({
        systems: [system],
        armies: [blueArmy],
        fleets: [
          { ...blueTransport, state: FleetState.COMBAT, invasionTargetSystemId: system.id },
          { ...redFleet, state: FleetState.COMBAT }
        ],
        battles: [scheduledBattle]
      });

      const nextState = runTurn(state, new RNG(7));

      const survivingBlueFleet = nextState.fleets.find(fleet => fleet.id === blueTransport.id);
      assert.strictEqual(survivingBlueFleet, undefined, 'Transport fleet should be destroyed in the space battle');

      const remainingArmy = nextState.armies.find(army => army.id === blueArmy.id);
      assert.ok(!remainingArmy || remainingArmy.state !== ArmyState.DEPLOYED, 'Embarked army must not land after carrier loss');

      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);
      assert.strictEqual(updatedSystem?.ownerFactionId, 'red', 'Defenders should retain control when orbit is contested and transport dies');
    }
  },
  {
    name: 'Phase ground conquest uses faction color and AI hold updates for any winner',
    run: () => {
      const system = createSystem('sys-green-capture', 'red');
      const greenArmy = createArmy('army-green', 'green', 8000, ArmyState.DEPLOYED, system.id);

      const state = createBaseState({ systems: [system], armies: [greenArmy], aiStates: {} });
      const ctx = { rng: new RNG(21), turn: state.day + 1 };

      const nextState = phaseGround(state, ctx);
      const updatedSystem = nextState.systems.find(sys => sys.id === system.id);

      assert.strictEqual(updatedSystem?.ownerFactionId, 'green', 'Green forces should capture an unopposed enemy world');
      assert.strictEqual(updatedSystem?.color, factions[2].color, 'Captured system color should match the winner faction color');
      assert.ok(nextState.aiStates?.green, 'AI state should be initialized for AI-controlled victors');
      assert.strictEqual(
        nextState.aiStates?.green?.holdUntilTurnBySystemId?.[system.id],
        ctx.turn + AI_HOLD_TURNS,
        'AI hold orders should be scheduled for newly conquered systems'
      );
    }
  },
  {
    name: 'Conquest exports remain referenced outside their module',
    run: () => {
      const projectRoot = path.resolve(new URL('../..', import.meta.url).pathname);
      const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
      const tsConfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(tsConfig.config, ts.sys, projectRoot);
      const fileNames = parsedConfig.fileNames.filter(file => !file.includes('node_modules'));

      const languageServiceHost: ts.LanguageServiceHost = {
        getScriptFileNames: () => fileNames,
        getScriptVersion: () => '0',
        getScriptSnapshot: fileName => {
          const fileText = ts.sys.readFile(fileName);
          return fileText === undefined ? undefined : ts.ScriptSnapshot.fromString(fileText);
        },
        getCurrentDirectory: () => projectRoot,
        getCompilationSettings: () => parsedConfig.options,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory
      };

      const service = ts.createLanguageService(languageServiceHost, ts.createDocumentRegistry());
      const program = service.getProgram();

      assert.ok(program, 'Unable to create TypeScript program for orphan helper detection');

      const conquestPath = path.join(projectRoot, 'engine', 'conquest.ts');
      const conquestSource = program!.getSourceFile(conquestPath);
      assert.ok(conquestSource, 'Conquest source should be part of the TypeScript program');

      const checker = program!.getTypeChecker();
      const conquestSymbol = checker.getSymbolAtLocation(conquestSource!);
      assert.ok(conquestSymbol, 'Conquest module symbol should be available for analysis');

      const exportedValues = checker
        .getExportsOfModule(conquestSymbol!)
        .filter(symbol => symbol.getEscapedName() !== 'default' && (symbol.getFlags() & ts.SymbolFlags.Value));

      const orphans: string[] = [];

      exportedValues.forEach(symbol => {
        const declarations = symbol.getDeclarations() ?? [];
        const hasExternalReference = declarations.some(declaration => {
          const identifier = declaration.name && ts.isIdentifier(declaration.name) ? declaration.name : null;
          if (!identifier) {
            return false;
          }

          const references = service.findReferences(conquestPath, identifier.getStart());
          return references?.flatMap(ref => ref.references).some(ref => ref.fileName !== conquestPath && !ref.isDefinition) ?? false;
        });

        if (!hasExternalReference) {
          orphans.push(symbol.getName());
        }
      });

      if (orphans.length > 0) {
        throw new Error(`Orphan exports in engine/conquest.ts: ${orphans.join(', ')}`);
      }
    }
  },
  {
    name: 'Orphan carriedArmyId is cleared during cleanup',
    run: () => {
      const system = createSystem('sys-3', 'blue');
      const fleet = createFleet('fleet-clean', 'blue', baseVec, [
        { id: 'transport-clean', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: 'missing-army' }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [] });

      const { state: sanitized, logs } = sanitizeArmyLinks(state);
      const cleanedShip = sanitized.fleets[0].ships[0];

      assert.strictEqual(cleanedShip.carriedArmyId, null, 'Transport should drop orphaned army reference');
      assert.ok(logs.some(entry => entry.includes('missing army missing-army')), 'Cleanup should log the fix');
    }
  },
  {
    name: 'Duplicate claims resolve deterministically to a single carrier',
    run: () => {
      const system = createSystem('sys-4', 'blue');
      const army = createArmy('army-shared', 'blue', 15000, ArmyState.EMBARKED, 'fleet-shared');

      const fleet = createFleet('fleet-shared', 'blue', baseVec, [
        { id: 'ship-a', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: army.id },
        { id: 'ship-b', type: ShipType.TROOP_TRANSPORT, hp: 2000, maxHp: 2000, carriedArmyId: army.id }
      ]);

      const state = createBaseState({ systems: [system], fleets: [fleet], armies: [army] });

      const { state: sanitized, logs } = sanitizeArmyLinks(state);
      const [shipA, shipB] = sanitized.fleets[0].ships;

      assert.strictEqual(shipA.carriedArmyId, army.id, 'Canonical carrier should retain the army');
      assert.strictEqual(shipB.carriedArmyId, null, 'Secondary carrier should be unlinked');
      assert.ok(logs.some(entry => entry.includes('canonical carrier is ship-a')), 'Cleanup log should cite canonical carrier');
      assert.strictEqual(sanitized.armies.length, 1, 'Army should survive cleanup with a single carrier');
    }
  }
];

const results: { name: string; success: boolean; error?: Error }[] = [];

for (const test of tests) {
  try {
    test.run();
    results.push({ name: test.name, success: true });
  } catch (error) {
    results.push({ name: test.name, success: false, error: error as Error });
  }
}

const successes = results.filter(result => result.success).length;
const failures = results.length - successes;

results.forEach(result => {
  if (result.success) {
    console.log(`✅ ${result.name}`);
  } else {
    console.error(`❌ ${result.name}`);
    console.error(result.error);
  }
});

if (failures > 0) {
  console.error(`Tests failed: ${failures}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`All tests passed (${successes}/${results.length}).`);
}
