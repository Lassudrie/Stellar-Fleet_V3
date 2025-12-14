
import React, { useMemo } from 'react';
import { Color, DoubleSide, BufferGeometry, BufferAttribute } from 'three';
import { StarSystem, FactionId } from '../types';
import { COLORS, TERRITORY_RADIUS } from '../data/static';

// --- CONFIGURATION ---
const CIRCLE_SEGMENTS = 64;  

type Point = { x: number; y: number };
type Segment = [Point, Point];

// --- GEOMETRY UTILS ---

const createCircle = (center: Point, radius: number): Point[] => {
  const pts: Point[] = [];
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const theta = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    pts.push({ 
        x: center.x + Math.cos(theta) * radius, 
        y: center.y + Math.sin(theta) * radius 
    });
  }
  return pts;
};

// Remove duplicate/too-close points
const cleanPolygon = (poly: Point[]): Point[] => {
    if (poly.length < 3) return [];
    const clean: Point[] = [poly[0]];
    for(let i=1; i<poly.length; i++) {
        const last = clean[clean.length-1];
        const curr = poly[i];
        const d2 = (curr.x - last.x)**2 + (curr.y - last.y)**2;
        if (d2 > 0.001) { // Tolerance
            clean.push(curr);
        }
    }
    // Check loop closure with first point
    if (clean.length > 2) {
        const last = clean[clean.length-1];
        const first = clean[0];
        const d2 = (first.x - last.x)**2 + (first.y - last.y)**2;
        if (d2 < 0.001) {
            clean.pop();
        }
    }
    return clean.length >= 3 ? clean : [];
};

const clipPolygon = (
  poly: Point[],
  M: Point,
  N: Point
): { poly: Point[]; newEdge: Segment | null } => {
  if (poly.length < 3) return { poly, newEdge: null };

  const newPoly: Point[] = [];
  const isInside = (p: Point) => (p.x - M.x) * N.x + (p.y - M.y) * N.y <= 0;

  const intersection = (a: Point, b: Point): Point => {
    const dotNum = (M.x - a.x) * N.x + (M.y - a.y) * N.y;
    const dotDenom = (b.x - a.x) * N.x + (b.y - a.y) * N.y;
    if (Math.abs(dotDenom) < 1e-9) return a;
    const t = dotNum / dotDenom;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  };

  let startPt: Point | null = null; 
  let endPt: Point | null = null;   

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const aIn = isInside(a);
    const bIn = isInside(b);

    if (aIn) newPoly.push(a);

    if (aIn !== bIn) {
      const p = intersection(a, b);
      newPoly.push(p);
      if (aIn && !bIn) startPt = p; 
      if (!aIn && bIn) endPt = p;   
    }
  }

  let newEdge: Segment | null = null;
  if (startPt && endPt) {
    newEdge = [startPt, endPt];
  }

  return { poly: newPoly, newEdge };
};

interface TerritoryBordersProps {
    systems: StarSystem[];
    signature: string; // Used to trigger re-renders only when ownership changes
    factions: any[]; // Used for coloring
}

const TerritoryBorders: React.FC<TerritoryBordersProps> = React.memo(({ systems, signature }) => {

  const meshes = useMemo(() => {
    if (!systems || systems.length === 0) return [];

    const groups: Record<string, StarSystem[]> = {
        'blue': systems.filter(s => s.ownerFactionId === 'blue'),
        'red': systems.filter(s => s.ownerFactionId === 'red'),
    };

    const resultMeshes: any[] = [];

    Object.entries(groups).forEach(([factionStr, mySystems]) => {
        if (mySystems.length === 0) return;

        const baseColor = new Color(factionStr === 'blue' ? COLORS.blue : COLORS.red);
        const borderColor = factionStr === 'blue' ? COLORS.blueHighlight : COLORS.redHighlight;
        
        // Glassy fill color
        const fillColor = baseColor.clone().lerp(new Color('#0f172a'), 0.5);

        const polygons: Point[][] = [];
        const borders: Segment[] = [];
        const bisectorSegments = new Map<string, Segment[]>();

        mySystems.forEach(sys => {
            const center = { x: sys.position.x, y: sys.position.z };
            let poly = createCircle(center, TERRITORY_RADIUS);
            
            const myBisectorEdges: { segment: Segment; key: string }[] = [];

            systems.forEach(other => {
                if (sys.id === other.id) return;

                const dx = other.position.x - sys.position.x;
                const dy = other.position.z - sys.position.z; 
                const distSq = dx*dx + dy*dy;

                if (distSq > (TERRITORY_RADIUS * 2.5) ** 2) return;

                const mid = { x: sys.position.x + dx * 0.5, y: sys.position.z + dy * 0.5 };
                const normal = { x: dx, y: dy };
                const key = sys.id < other.id ? `${sys.id}:${other.id}` : `${other.id}:${sys.id}`;

                const { poly: newPoly, newEdge } = clipPolygon(poly, mid, normal);
                poly = newPoly;

                if (newEdge) {
                    myBisectorEdges.push({ segment: newEdge, key });
                }
            });

            const cleanPoly = cleanPolygon(poly);
            if (cleanPoly.length < 3) return;

            polygons.push(cleanPoly);

            // Edge Classification
            for (let k = 0; k < cleanPoly.length; k++) {
                const p1 = cleanPoly[k];
                const p2 = cleanPoly[(k + 1) % cleanPoly.length];
                
                let matchedKey: string | null = null;
                
                for (const meta of myBisectorEdges) {
                    const midX = (p1.x + p2.x) * 0.5;
                    const midY = (p1.y + p2.y) * 0.5;
                    const seg = meta.segment;
                    const l2 = (seg[1].x - seg[0].x)**2 + (seg[1].y - seg[0].y)**2;
                    if (l2 > 0) {
                        const t = ((midX - seg[0].x) * (seg[1].x - seg[0].x) + (midY - seg[0].y) * (seg[1].y - seg[0].y)) / l2;
                        if (t >= 0 && t <= 1) {
                             const projX = seg[0].x + t * (seg[1].x - seg[0].x);
                             const projY = seg[0].y + t * (seg[1].y - seg[0].y);
                             const d = (midX - projX)**2 + (midY - projY)**2;
                             if (d < 0.01) {
                                 matchedKey = meta.key;
                                 break;
                             }
                        }
                    }
                }

                if (matchedKey) {
                    const list = bisectorSegments.get(matchedKey) || [];
                    list.push([p1, p2]);
                    bisectorSegments.set(matchedKey, list);
                } else {
                    borders.push([p1, p2]);
                }
            }
        });

        // Resolve Bisectors
        bisectorSegments.forEach((segments, key) => {
            const [id1, id2] = key.split(':');
            const sys1 = systems.find(s => s.id === id1);
            const sys2 = systems.find(s => s.id === id2);

            if (sys1?.ownerFactionId !== sys2?.ownerFactionId) {
                segments.forEach(s => borders.push(s));
                return;
            }

            if (segments.length === 0) return;

            const refStart = segments[0][0];
            const refEnd = segments[0][1];
            let dx = refEnd.x - refStart.x;
            let dy = refEnd.y - refStart.y;
            const len = Math.sqrt(dx*dx + dy*dy);
            if (len < 1e-6) return;
            dx /= len; dy /= len;

            const project = (p: Point) => (p.x - refStart.x) * dx + (p.y - refStart.y) * dy;
            const unproject = (t: number) => ({ x: refStart.x + t * dx, y: refStart.y + t * dy });

            type Event = { t: number, type: 1 | -1 };
            const events: Event[] = [];

            segments.forEach(([p1, p2]) => {
                let t1 = project(p1);
                let t2 = project(p2);
                if (t1 > t2) [t1, t2] = [t2, t1];
                t1 += 0.01; 
                t2 -= 0.01;
                if (t1 < t2) {
                    events.push({ t: t1, type: 1 });
                    events.push({ t: t2, type: -1 });
                }
            });

            events.sort((a, b) => a.t - b.t);

            let depth = 0;
            let prevT = events[0]?.t || 0;

            for (const e of events) {
                const dist = e.t - prevT;
                if (dist > 0.02) {
                    if (depth === 1) {
                        borders.push([unproject(prevT), unproject(e.t)]);
                    }
                }
                depth += e.type;
                prevT = e.t;
            }
        });

        const fillPos: number[] = [];
        const linePos: number[] = [];

        polygons.forEach(poly => {
            if (poly.length < 3) return;
            let cx = 0, cy = 0;
            for(const p of poly) { cx += p.x; cy += p.y; }
            cx /= poly.length;
            cy /= poly.length;

            for (let i = 0; i < poly.length; i++) {
                const p1 = poly[i];
                const p2 = poly[(i + 1) % poly.length];
                fillPos.push(cx, 0, cy);
                fillPos.push(p1.x, 0, p1.y);
                fillPos.push(p2.x, 0, p2.y);
            }
        });

        borders.forEach(([p1, p2]) => {
            linePos.push(p1.x, 0, p1.y);
            linePos.push(p2.x, 0, p2.y);
        });

        const m: any = {
            id: factionStr,
            color: fillColor,
            borderColor,
            fillGeo: null,
            lineGeo: null
        };

        // Strict checks for geometry creation to avoid invalid typed array length errors
        if (fillPos.length > 0) {
            const fillGeo = new BufferGeometry();
            fillGeo.setAttribute('position', new BufferAttribute(new Float32Array(fillPos), 3));
            m.fillGeo = fillGeo;
        }

        if (linePos.length > 0) {
            const lineGeo = new BufferGeometry();
            lineGeo.setAttribute('position', new BufferAttribute(new Float32Array(linePos), 3));
            m.lineGeo = lineGeo;
        }

        if (m.fillGeo || m.lineGeo) {
            resultMeshes.push(m);
        }
    });

    return resultMeshes;
    
    // CRITICAL OPTIMIZATION:
    // Only recalculate when the ownership signature changes (capture event), or the number of systems changes (init).
    // Positional updates (which don't happen for systems) are irrelevant.
  }, [signature, systems.length]);

  if (meshes.length === 0) return null;

  return (
    <group>
        {meshes.map(m => (
            <group key={m.id}>
                {/* Fill Mesh */}
                {m.fillGeo && (
                    <mesh 
                        geometry={m.fillGeo}
                        position={[0, -2, 0]} 
                        renderOrder={-10}
                    >
                        <meshBasicMaterial 
                            color={m.color} 
                            transparent 
                            opacity={0.2} 
                            depthWrite={false}
                            depthTest={false}
                            side={DoubleSide} 
                        />
                    </mesh>
                )}

                {/* Border Lines */}
                {m.lineGeo && (
                    <lineSegments 
                        geometry={m.lineGeo}
                        position={[0, -1.9, 0]}
                        renderOrder={-9}
                    >
                        <lineBasicMaterial 
                            color={m.borderColor} 
                            transparent 
                            opacity={0.8} 
                            linewidth={2} 
                            depthTest={false}
                            depthWrite={false}
                        />
                    </lineSegments>
                )}
            </group>
        ))}
    </group>
  );
});

export default TerritoryBorders;
