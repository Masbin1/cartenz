import type { AiOfficePhase } from '@/lib/types';

/**
 * Where everything sits in the office drawing.
 *
 * The layout is a top-down floor read at a shallow angle: each room is a
 * parallelogram, its walls rise from the back edge, and its desks are placed on
 * the floor plane. The projection follows the standard isometric convention of
 * a measured polygon rather than one fixed linear map, because rooms need a
 * *width* as well as a position; a single linear map would force every room to
 * be measured from one origin, which makes the rows overlap as soon as they
 * differ in size.
 *
 * Coordinates are "floor" units: x increases to the right along one floor axis,
 * y increases into the room. `project` converts them for the drawing.
 *
 * `depth` shifts a drawing along the viewer-facing direction. A figure standing
 * further forward must be drawn later (on top) and uses a larger depth.
 */

export interface Point {
  x: number;
  y: number;
}

/** Horizontal foreshortening. 0.866 = cos(30 degrees), the isometric standard. */
export const ISO_X = 0.866;
/** Vertical foreshortening. 0.5 = sin(30 degrees). */
export const ISO_Y = 0.5;

export interface RoomLayout {
  id: AiOfficePhase;
  /** Floor-space origin of the room's back corner. */
  origin: Point;
  /** Room size along the floor axes. */
  width: number;
  depth: number;
  /** Height of the back walls, in drawing units. */
  wallHeight: number;
}

/**
 * Four rooms around a central open floor.
 *
 * The arrangement is the one the office needs to read as a workplace: the two
 * rooms a request enters first sit at the back, the two it leaves through sit at
 * the front, and the dispatch point holds the middle where everything crosses.
 * Room sizes differ slightly so the drawing does not read as a grid of cards.
 */
export const ROOM_LAYOUT: readonly RoomLayout[] = [
  { id: 'research', origin: { x: 46, y: 30 }, width: 250, depth: 120, wallHeight: 62 },
  { id: 'development', origin: { x: 404, y: 30 }, width: 356, depth: 130, wallHeight: 62 },
  { id: 'quality', origin: { x: 76, y: 344 }, width: 320, depth: 128, wallHeight: 58 },
  { id: 'operations', origin: { x: 450, y: 322 }, width: 310, depth: 140, wallHeight: 58 },
];

/** The open floor the dispatch point stands on. */
// Screen position ~(130, 270): the gap between Research's front tip, Development's
// left edge, Quality's right edge and the Operations wall label. Placed in floor
// space so the "inside no room" invariant stays testable.
export const DISPATCH_LAYOUT = { center: { x: 345, y: 195 }, radius: 30 };

export function project(point: Point): Point {
  return { x: (point.x - point.y) * ISO_X, y: (point.x + point.y) * ISO_Y };
}

/** Shift a drawing forward along the viewer-facing direction. */
export function isoOffset(depth: number): string {
  return `translate(${(-depth * ISO_X).toFixed(2)} ${(depth * ISO_Y).toFixed(2)})`;
}

/** A floor polygon as an SVG path, in drawing coordinates. */
export function floorPath(origin: Point, width: number, depth: number): string {
  const corners = [
    origin,
    { x: origin.x + width, y: origin.y },
    { x: origin.x + width, y: origin.y + depth },
    { x: origin.x, y: origin.y + depth },
  ].map(project);

  return `M${corners.map((corner) => `${corner.x.toFixed(2)} ${corner.y.toFixed(2)}`).join('L')}Z`;
}

/**
 * Where a desk sits on a room's floor.
 *
 * Desks form a two-column grid measured as fractions of the room, so a bigger
 * room spreads the same desks further apart instead of cramming more in. Each
 * desk returns its floor point and a draw depth (projected screen y): figures
 * are painted in depth order, which is what keeps a person from being drawn
 * over by the desk in front of them.
 */
export function deskLayout(room: RoomLayout, count: number): { point: Point; depth: number }[] {
  const columns = 2;
  const rows = Math.max(1, Math.ceil(count / columns));
  const desks: { point: Point; depth: number }[] = [];

  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const point = {
      x: room.origin.x + room.width * (0.24 + 0.52 * column),
      y: room.origin.y + room.depth * (rows === 1 ? 0.6 : 0.3 + (0.6 * row) / (rows - 1)),
    };
    desks.push({ point, depth: project(point).y });
  }

  return desks;
}

/** The centre of a room's floor. */
export function roomAnchor(room: RoomLayout): Point {
  return project({ x: room.origin.x + room.width / 2, y: room.origin.y + room.depth / 2 });
}

/**
 * The point on a room's edge that faces `toward`, inset into the room.
 *
 * A route drawn to a room's centre would cross the floor and pass through the
 * desks on it. Terminating on the nearest edge instead keeps the route where it
 * belongs - on the open floor between rooms - and leaves the room's interior to
 * the people who work in it.
 */
export function edgeAnchor(room: RoomLayout, toward: Point, inset = 12): Point {
  const { origin, width, depth } = room;
  const corners = [
    { x: origin.x, y: origin.y },
    { x: origin.x + width, y: origin.y },
    { x: origin.x + width, y: origin.y + depth },
    { x: origin.x, y: origin.y + depth },
  ];

  const target = project(toward);
  let best: Point = project(corners[0]);
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index];
    const b = corners[(index + 1) % corners.length];
    const mid = project({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const distance = Math.hypot(mid.x - target.x, mid.y - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mid;
    }
  }

  // Pull the point back towards the room centre so the route stops just inside
  // the floor rather than exactly on the edge line.
  const centre = roomAnchor(room);
  const length = Math.hypot(best.x - centre.x, best.y - centre.y) || 1;
  return {
    x: best.x - ((best.x - centre.x) / length) * inset,
    y: best.y - ((best.y - centre.y) / length) * inset,
  };
}

export function roomById(id: AiOfficePhase): RoomLayout {
  const room = ROOM_LAYOUT.find((candidate) => candidate.id === id);
  if (!room) throw new Error(`No layout for room ${id}`);
  return room;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The drawing's extent: every room's floor and wall tops, plus room for the
 * figures standing at the front edge and their name chips. The viewBox is this,
 * so moving a room in `ROOM_LAYOUT` can never push it off-canvas.
 */
export function worldBounds(padding = 36): Bounds {
  const xs: number[] = [];
  const ys: number[] = [];

  for (const room of ROOM_LAYOUT) {
    const corners = [
      room.origin,
      { x: room.origin.x + room.width, y: room.origin.y },
      { x: room.origin.x + room.width, y: room.origin.y + room.depth },
      { x: room.origin.x, y: room.origin.y + room.depth },
    ].map(project);
    for (const corner of corners) {
      xs.push(corner.x);
      ys.push(corner.y, corner.y - room.wallHeight - 22);
    }
  }

  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export const WORLD = worldBounds();

/**
 * Points along a straight path, used to build the connection curves.
 * A straight line between two rooms would cut across unrelated floors; the path
 * is bowed slightly so it reads as a route rather than a chord.
 */
export function bowPath(from: Point, to: Point, bow = 0.16): string {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const nx = -(to.y - from.y);
  const ny = to.x - from.x;
  const length = Math.hypot(nx, ny) || 1;
  const control = {
    x: mid.x + (nx / length) * length * bow,
    y: mid.y + (ny / length) * length * bow,
  };
  return `M${from.x.toFixed(1)} ${from.y.toFixed(1)} Q${control.x.toFixed(1)} ${control.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}
