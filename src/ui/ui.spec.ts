import assert from 'node:assert';
import { Vector3 } from 'three';
import { performance } from 'node:perf_hooks';

import { getFleetEligibility, isFleetEligibleForMode } from './components/ui/FleetPicker';
import { CAPTURE_RANGE_SQ } from '../content/data/static';
import { Fleet, FleetState, GameMessage, ShipType, StarSystem } from '../shared/shared';

import { computeHiddenToastState, selectActiveToastMessages } from './components/ui/MessageToasts';

import { clampCameraToBounds, createClampScratch, ClampBounds } from './hooks';

import { vec3 } from '../engine/math/vec3';
import { getSystemFleets, hashStringToAngle, layoutTacticalRing } from './components/screens';

import { dispatchAndProcess, processCommandResult } from './commands/processCommandResult';

import { getInitialLocale } from './i18n/index';

import { computeConstrainedMenuPosition, SafeAreaInsets, ViewportRect } from './components/ui/SystemContextMenu';

import { getDefaultSolidPlanet, getPlanetById } from '../engine/planets';

// ============================================================
// FleetPicker eligibility (was: ui/components/ui/FleetPicker.spec.ts)
// ============================================================

{
  const buildFleet = (overrides: Partial<Fleet>): Fleet => ({
    id: overrides.id ?? 'f-1',
    factionId: 'blue',
    ships: overrides.ships ?? [],
    position: overrides.position ?? { x: 0, y: 0, z: 0 },
    state: overrides.state ?? FleetState.ORBIT,
    stateStartTurn: 0,
    targetSystemId: null,
    targetPosition: null,
    radius: 1,
    invasionTargetSystemId: null,
    loadTargetSystemId: null,
    unloadTargetSystemId: null,
    retreating: false
  });

  const targetSystem: StarSystem = {
    id: 'target',
    name: 'Target',
    position: { x: 50, y: 0, z: 0 },
    color: '#fff',
    size: 1,
    ownerFactionId: null,
    resourceType: 'none',
    isHomeworld: false,
    planets: []
  };
  const systems: StarSystem[] = [
    targetSystem,
    {
      ...targetSystem,
      id: 'source',
      name: 'Source',
      position: { x: 0, y: 0, z: 0 }
    }
  ];

  {
    const inRangeFleet = buildFleet({
      id: 'f-near',
      position: { x: targetSystem.position.x - (Math.sqrt(CAPTURE_RANGE_SQ) - 0.1), y: 0, z: 0 }
    });
    assert.strictEqual(
      getFleetEligibility(inRangeFleet, 'MOVE', targetSystem, systems).reason,
      'captureRange',
      'Fleets already within capture range should be flagged for captureRange'
    );
  }

  {
    const farFleet = buildFleet({
      id: 'f-far',
      position: systems[1].position
    });
    assert.strictEqual(
      isFleetEligibleForMode(farFleet, 'ATTACK', targetSystem, systems),
      true,
      'Fleets outside capture range should be selectable for ATTACK'
    );
  }

  {
    const transportFleet = buildFleet({
      id: 'f-transport',
      position: { x: targetSystem.position.x - 5, y: 0, z: 0 },
      ships: [{ id: 's1', type: ShipType.TRANSPORTER, hp: 1, maxHp: 1, fuel: 100, carriedArmyId: 'army-1' }]
    });
    assert.strictEqual(
      getFleetEligibility(transportFleet, 'UNLOAD', targetSystem, systems).eligible,
      true,
      'Fleets with transports should be allowed for UNLOAD when in range'
    );
  }

  {
    const noTransportFleet = buildFleet({
      id: 'f-no-transport',
      ships: [{ id: 's1', type: ShipType.FRIGATE, hp: 1, maxHp: 1, fuel: 50, carriedArmyId: null }]
    });
    assert.strictEqual(
      getFleetEligibility(noTransportFleet, 'LOAD', targetSystem, systems).reason,
      'missingTransport',
      'Fleets without transports should be rejected for LOAD'
    );
  }

  {
    const lowFuelFleet = buildFleet({
      id: 'f-low-fuel',
      position: { x: 0, y: 0, z: 0 },
      ships: [{ id: 's1', type: ShipType.FRIGATE, hp: 1, maxHp: 1, fuel: 0.05, carriedArmyId: null }]
    });
    assert.strictEqual(
      getFleetEligibility(lowFuelFleet, 'MOVE', targetSystem, systems).reason,
      'insufficientFuel',
      'Fleets without enough fuel should show an insufficientFuel restriction'
    );
  }

  {
    const distantFleet = buildFleet({
      id: 'f-out-of-range',
      position: { x: targetSystem.position.x + 500, y: 0, z: 0 },
      ships: [{ id: 's1', type: ShipType.TRANSPORTER, hp: 1, maxHp: 1, fuel: 999, carriedArmyId: 'army-1' }]
    });
    assert.strictEqual(
      getFleetEligibility(distantFleet, 'UNLOAD', targetSystem, systems).reason,
      'outOfRange',
      'Fleets beyond jump range should be flagged as outOfRange'
    );
  }
}

// ============================================================
// MessageToasts logic (was: ui/components/ui/MessageToasts.logic.spec.ts)
// ============================================================

{
  const initial = new Set<string>();
  const { next, changed } = computeHiddenToastState(initial, 'm1');
  assert.strictEqual(changed, true, 'First hide should be reported as changed');
  assert.ok(next.has('m1'), 'Toast id should be added to hidden set');
}

{
  const initial = new Set<string>(['m1']);
  const { next, changed } = computeHiddenToastState(initial, 'm1');
  assert.strictEqual(changed, false, 'Hiding the same toast twice should be ignored');
  assert.strictEqual(next, initial, 'Hidden set should be reused when nothing changes');
}

{
  const messages: GameMessage[] = [
    {
      id: 'toast-1',
      day: 1,
      createdAtTurn: 10,
      priority: 1,
      read: false,
      dismissed: false,
      title: 'Status report',
      subtitle: 'Automated update',
      type: 'status',
      lines: ['All systems nominal.'],
      payload: {}
    }
  ];

  const hidden = computeHiddenToastState(new Set<string>(), 'toast-1').next;
  const activeToasts = selectActiveToastMessages(messages, hidden);
  assert.strictEqual(activeToasts.length, 0, 'Auto-hidden toast should not render again');

  const visibleMessages = messages.filter(msg => !msg.dismissed);
  assert.strictEqual(visibleMessages.length, 1, 'Auto-hidden toast should remain in the message list');
}

// ============================================================
// GameCamera clamp (was: ui/components/GameCamera.spec.ts)
// ============================================================

{
  const bounds: ClampBounds = {
    minX: -50,
    maxX: 50,
    minZ: -50,
    maxZ: 50
  };

  {
    const camera = new Vector3(100, 20, 100);
    const target = new Vector3(100, 0, 100);
    const scratch = createClampScratch();

    const { targetChanged, positionChanged } = clampCameraToBounds(camera, target, bounds, { min: 10, max: 120 }, scratch);

    assert.strictEqual(targetChanged, true, 'Target should be clamped inside bounds');
    assert.strictEqual(positionChanged, true, 'Camera should move when target is clamped');
    assert.ok(camera.x <= bounds.maxX && camera.x >= bounds.minX, 'Camera X should be inside bounds');
    assert.ok(camera.z <= bounds.maxZ && camera.z >= bounds.minZ, 'Camera Z should be inside bounds');
  }

  {
    const iterations = 5000;
    const camera = new Vector3(10, 30, 10);
    const target = new Vector3(10, 0, 10);
    const scratch = createClampScratch();
    const start = performance.now();

    for (let i = 0; i < iterations; i += 1) {
      target.x = 60 + (i % 5);
      target.z = 60 - (i % 7);
      clampCameraToBounds(camera, target, bounds, { min: 5, max: 150 }, scratch);
    }

    const duration = performance.now() - start;
    assert.ok(duration < 200, `Clamping should remain fast (took ${duration.toFixed(2)}ms)`);
  }

  {
    const camera = new Vector3(0, 40, 40);
    const target = new Vector3(0, 0, 0);
    const scratch = createClampScratch();

    clampCameraToBounds(camera, target, bounds, { min: 20, max: 60 }, scratch);

    const distance = camera.distanceTo(target);
    assert.ok(
      Math.abs(distance - Math.sqrt(40 * 40 + 40 * 40)) < 0.001,
      'Camera should respect desired distance within bounds'
    );
    assert.ok(camera.x <= bounds.maxX && camera.x >= bounds.minX, 'Camera X should stay within bounds');
    assert.ok(camera.z <= bounds.maxZ && camera.z >= bounds.minZ, 'Camera Z should stay within bounds');
  }

  {
    const camera = new Vector3(70, 10, 0);
    const target = new Vector3(40, 0, 0);
    const scratch = createClampScratch();

    const initialOffset = camera.clone().sub(target);
    const expectedDirection = initialOffset.clone().normalize();
    const expectedDistance = (bounds.maxX - target.x) / expectedDirection.x;

    clampCameraToBounds(camera, target, bounds, { min: 20, max: 120 }, scratch);

    const distance = camera.distanceTo(target);
    assert.ok(Math.abs(distance - expectedDistance) < 0.001, 'Camera should stop at the boundary-constrained distance');
    assert.ok(camera.x <= bounds.maxX && camera.x >= bounds.minX, 'Camera X should stay within bounds after boundary clamp');
    assert.ok(camera.z <= bounds.maxZ && camera.z >= bounds.minZ, 'Camera Z should stay within bounds after boundary clamp');
  }
}

// ============================================================
// systemViewLayout (was: ui/components/screens/systemViewLayout.spec.ts)
// ============================================================

{
  const createSystem = (): StarSystem => ({
    id: 'sys-1',
    name: 'Test',
    position: vec3(0, 0, 0),
    color: '#ffffff',
    size: 1,
    ownerFactionId: null,
    resourceType: 'none',
    isHomeworld: false,
    planets: []
  });

  const createFleet = (id: string, x: number, z: number): Fleet => ({
    id,
    factionId: 'blue',
    ships: [],
    position: vec3(x, 0, z),
    state: FleetState.ORBIT,
    targetSystemId: null,
    targetPosition: null,
    radius: 1,
    stateStartTurn: 0
  });

  {
    const angleA = hashStringToAngle('fleet-alpha');
    const angleB = hashStringToAngle('fleet-alpha');
    const angleC = hashStringToAngle('fleet-beta');
    assert.strictEqual(angleA, angleB, 'hashStringToAngle should be deterministic');
    assert.notStrictEqual(angleA, angleC, 'hashStringToAngle should vary across ids');
  }

  {
    const system = createSystem();
    const fleetNear = createFleet('fleet-near', 0, 0);
    const fleetFar = createFleet('fleet-far', 100, 0);
    const fleets = getSystemFleets(system, [fleetFar, fleetNear]);
    assert.deepStrictEqual(fleets.map(fleet => fleet.id), ['fleet-near'], 'getSystemFleets should filter by orbit proximity');
  }

  {
    const fleetA = createFleet('a-fleet', 0, 0);
    const fleetB = createFleet('b-fleet', 0, 0);
    const layout = layoutTacticalRing([fleetB, fleetA], {
      baseRadius: 5,
      ringSpacing: 2,
      maxPerRing: 1,
      yOffset: 0.1,
      rotationSpeed: 0
    });

    assert.strictEqual(layout[0].entity.id, 'a-fleet', 'layout should sort entities by id');
    assert.strictEqual(layout[0].ringIndex, 0, 'first entity should be in ring 0');
    assert.strictEqual(layout[1].ringIndex, 1, 'second entity should roll into ring 1');
    assert.strictEqual(layout[1].radius, 7, 'ring radius should include spacing offset');
  }
}

// ============================================================
// processCommandResult (was: ui/commands/processCommandResult.spec.ts)
// ============================================================

{
  const createNotifier = () => {
    const calls: string[] = [];
    const notify = (message: string) => {
      calls.push(message);
    };
    return { calls, notify };
  };

  {
    const { calls, notify } = createNotifier();
    const result = processCommandResult({ ok: true }, notify);
    assert.strictEqual(result, true, 'processCommandResult should return true for ok results');
    assert.deepStrictEqual(calls, [], 'No error should be reported on success');
  }

  {
    const { calls, notify } = createNotifier();
    const result = processCommandResult({ ok: false, error: 'Blocked' }, notify);
    assert.strictEqual(result, false, 'processCommandResult should return false on error');
    assert.deepStrictEqual(calls, ['Blocked'], 'Error message should be forwarded to notifier');
  }

  {
    const { calls, notify } = createNotifier();
    const result = processCommandResult(
      {
        ok: false,
        error: { code: 'INSUFFICIENT_FUEL', message: 'Insufficient fuel details', shortages: [] }
      },
      notify
    );
    assert.strictEqual(result, false, 'processCommandResult should return false on structured errors');
    assert.deepStrictEqual(calls, ['Insufficient fuel details'], 'Structured error messages should be forwarded');
  }

  {
    const { calls, notify } = createNotifier();
    const result = processCommandResult({ ok: false }, notify);
    assert.strictEqual(result, false, 'processCommandResult should return false when error is missing');
    assert.deepStrictEqual(calls, ['Unknown error'], 'Missing errors should fall back to a generic message');
  }

  {
    const { calls, notify } = createNotifier();
    const mockEngine = {
      dispatchPlayerCommand: () => ({ ok: false, error: 'Out of range', state: {} as any })
    };
    const processed = dispatchAndProcess(mockEngine, { type: 'MOVE_FLEET', fleetId: 'f1', targetSystemId: 's1' } as any, notify);
    assert.strictEqual(processed, false, 'dispatchAndProcess should return false when engine rejects command');
    assert.deepStrictEqual(calls, ['Out of range']);
  }
}

// ============================================================
// i18n (was: ui/i18n/tests/i18n.spec.ts)
// ============================================================

assert.strictEqual(getInitialLocale(), 'en');

// ============================================================
// computeConstrainedMenuPosition (was: ui/components/ui/positioning/computeConstrainedMenuPosition.spec.ts)
// ============================================================

{
  const viewport: ViewportRect = { left: 0, top: 0, width: 500, height: 500 };
  const safe: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  const menuSize = { width: 100, height: 100 };
  const offset = 10;
  const padding = 8;

  {
    const position = computeConstrainedMenuPosition({
      anchor: { x: 100, y: 100 },
      menuSize,
      viewport,
      safeInsets: safe,
      offset,
      padding
    });
    assert.deepStrictEqual(position, { x: 110, y: 110 }, 'Menu should appear bottom-right of anchor when space permits');
  }

  {
    const position = computeConstrainedMenuPosition({
      anchor: { x: 480, y: 100 },
      menuSize,
      viewport,
      safeInsets: safe,
      offset,
      padding
    });
    assert.deepStrictEqual(position, { x: 370, y: 110 }, 'Menu should flip to the left when there is no room on the right');
  }

  {
    const position = computeConstrainedMenuPosition({
      anchor: { x: 100, y: 480 },
      menuSize,
      viewport,
      safeInsets: safe,
      offset,
      padding
    });
    assert.deepStrictEqual(position, { x: 110, y: 370 }, 'Menu should flip above when there is no room below');
  }

  {
    const position = computeConstrainedMenuPosition({
      anchor: { x: 490, y: 490 },
      menuSize,
      viewport,
      safeInsets: safe,
      offset,
      padding
    });
    assert.deepStrictEqual(
      position,
      { x: 380, y: 380 },
      'Menu should flip both directions near the bottom-right corner and clamp inside the viewport'
    );
  }

  {
    const safeInsets: SafeAreaInsets = { top: 20, right: 12, bottom: 16, left: 14 };
    const position = computeConstrainedMenuPosition({
      anchor: { x: 5, y: 5 },
      menuSize,
      viewport,
      safeInsets,
      offset,
      padding
    });
    const expectedX = viewport.left + safeInsets.left + padding;
    const expectedY = viewport.top + safeInsets.top + padding;
    assert.deepStrictEqual(position, { x: expectedX, y: expectedY }, 'Menu should clamp within safe-area insets');
  }

  {
    const shortViewport: ViewportRect = { left: 0, top: 0, width: 200, height: 150 };
    const tallMenu = { width: 180, height: 200 };

    const position = computeConstrainedMenuPosition({
      anchor: { x: 50, y: 50 },
      menuSize: tallMenu,
      viewport: shortViewport,
      safeInsets: safe,
      offset,
      padding
    });

    assert.strictEqual(position.y, padding, 'Menu taller than viewport height should clamp to top with padding');
  }
}

// ============================================================
// surfaceNavigation (was: ui/navigation/surfaceNavigation.spec.ts)
// ============================================================

{
  const resolveSurfaceContext = ({
    systems,
    preferredSystemId,
    bodyId
  }: {
    systems: StarSystem[];
    preferredSystemId?: string | null;
    bodyId?: string | null;
  }) => {
    if (bodyId) {
      const match = getPlanetById(systems, bodyId);
      if (match && match.planet.isSolid) {
        return { system: match.system, body: match.planet };
      }
    }

    if (preferredSystemId) {
      const system = systems.find(entry => entry.id === preferredSystemId);
      if (system) {
        const fallback = getDefaultSolidPlanet(system);
        if (fallback) return { system, body: fallback };
      }
    }

    for (const system of systems) {
      const fallback = getDefaultSolidPlanet(system);
      if (fallback) return { system, body: fallback };
    }

    return null;
  };

  const makeSystem = (id: string, planets: Array<Partial<StarSystem['planets'][number]>>): StarSystem => ({
    id,
    name: id.toUpperCase(),
    position: { x: 0, y: 0, z: 0 },
    color: '#fff',
    size: 1,
    ownerFactionId: null,
    resourceType: 'none',
    isHomeworld: false,
    planets: planets.map((planet, index) => ({
      id: planet.id ?? `${id}-planet-${index + 1}`,
      systemId: id,
      name: planet.name ?? `${id} Planet ${index + 1}`,
      bodyType: planet.bodyType ?? 'planet',
      class: planet.class ?? 'solid',
      ownerFactionId: planet.ownerFactionId ?? null,
      size: planet.size ?? 1,
      isSolid: planet.isSolid ?? true
    }))
  });

  const systems: StarSystem[] = [
    makeSystem('alpha', [{ id: 'alpha-gas', class: 'gas_giant', isSolid: false }]),
    makeSystem('beta', [{ id: 'beta-one', class: 'solid', isSolid: true }]),
    makeSystem('gamma', [{ id: 'gamma-a', class: 'solid', isSolid: true }])
  ];

  {
    const context = resolveSurfaceContext({ systems, bodyId: 'beta-one' });
    assert.ok(context, 'Context should be resolved for explicit solid planet');
    assert.strictEqual(context?.body.id, 'beta-one');
    assert.strictEqual(context?.system.id, 'beta');
  }

  {
    const context = resolveSurfaceContext({ systems, bodyId: 'alpha-gas', preferredSystemId: 'gamma' });
    assert.ok(context, 'Preferred system should be used when body is invalid');
    assert.strictEqual(context?.system.id, 'gamma');
    assert.strictEqual(context?.body.isSolid, true);
  }

  {
    const barrenSystems: StarSystem[] = [makeSystem('void', [{ id: 'void-1', class: 'gas_giant', isSolid: false }])];
    const context = resolveSurfaceContext({ systems: barrenSystems, bodyId: 'void-1' });
    assert.strictEqual(context, null, 'No surface context when no solid planets exist');
  }
}

console.log('ui tests passed');
