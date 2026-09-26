import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_LAYOUT,
  ROOM_LAYOUT,
  WORLD,
  bowPath,
  deskLayout,
  edgeAnchor,
  floorPath,
  project,
  roomAnchor,
} from './layout';

test('project keeps the isometric axes: origin is the back corner, both axes descend', () => {
  const origin = project({ x: 0, y: 0 });
  const right = project({ x: 10, y: 0 });
  assert.ok(right.x > origin.x);
  assert.ok(right.y > origin.y);
});

test('project keeps the isometric axes: increasing y moves left and down (into the room)', () => {
  const origin = project({ x: 0, y: 0 });
  const forward = project({ x: 0, y: 10 });
  assert.ok(forward.x < origin.x);
  assert.ok(forward.y > origin.y);
});

test('floorPath returns a closed 4-point path', () => {
  const path = floorPath({ x: 0, y: 0 }, 100, 80);
  assert.match(path, /^M[\d.\- ]+L[\d.\- ]+L[\d.\- ]+L[\d.\- ]+Z$/);
});

test('every room has a distinct id and none overlap in floor space', () => {
  const ids = ROOM_LAYOUT.map((room) => room.id);
  assert.equal(new Set(ids).size, ids.length);

  for (let i = 0; i < ROOM_LAYOUT.length; i += 1) {
    for (let j = i + 1; j < ROOM_LAYOUT.length; j += 1) {
      const a = ROOM_LAYOUT[i];
      const b = ROOM_LAYOUT[j];
      const disjointX = a.origin.x + a.width <= b.origin.x || b.origin.x + b.width <= a.origin.x;
      const disjointY = a.origin.y + a.depth <= b.origin.y || b.origin.y + b.depth <= a.origin.y;
      assert.ok(disjointX || disjointY, `${a.id} and ${b.id} overlap`);
    }
  }
});

test('deskLayout places every requested desk inside the room bounds', () => {
  const room = ROOM_LAYOUT[0];
  const desks = deskLayout(room, 4);
  assert.equal(desks.length, 4);
  for (const desk of desks) {
    assert.ok(desk.point.x >= room.origin.x && desk.point.x <= room.origin.x + room.width);
    assert.ok(desk.point.y >= room.origin.y && desk.point.y <= room.origin.y + room.depth);
  }
});

test('deskLayout with zero desks returns an empty list', () => {
  assert.deepEqual(deskLayout(ROOM_LAYOUT[0], 0), []);
});

test('deskLayout reports each desk depth as its projected screen y (for painter order)', () => {
  for (const desk of deskLayout(ROOM_LAYOUT[1], 4)) {
    assert.equal(desk.depth, project(desk.point).y);
  }
});

test('desks in one room never share a spot', () => {
  const desks = deskLayout(ROOM_LAYOUT[2], 4);
  const spots = new Set(desks.map((d) => `${d.point.x.toFixed(1)},${d.point.y.toFixed(1)}`));
  assert.equal(spots.size, 4);
});

test('the dispatch point is on open floor, inside no room', () => {
  const { x, y } = DISPATCH_LAYOUT.center;
  for (const room of ROOM_LAYOUT) {
    const inside =
      x >= room.origin.x &&
      x <= room.origin.x + room.width &&
      y >= room.origin.y &&
      y <= room.origin.y + room.depth;
    assert.equal(inside, false, `dispatch sits inside ${room.id}`);
  }
});

test('the dispatch point sits between the rooms on screen, not off to one side', () => {
  const centre = project(DISPATCH_LAYOUT.center);
  const anchors = ROOM_LAYOUT.map(roomAnchor);
  const minX = Math.min(...anchors.map((a) => a.x));
  const maxX = Math.max(...anchors.map((a) => a.x));
  const minY = Math.min(...anchors.map((a) => a.y));
  const maxY = Math.max(...anchors.map((a) => a.y));
  assert.ok(centre.x > minX && centre.x < maxX);
  assert.ok(centre.y > minY && centre.y < maxY);
});

test('the world bounds contain every room corner and its wall top', () => {
  for (const room of ROOM_LAYOUT) {
    const corners = [
      room.origin,
      { x: room.origin.x + room.width, y: room.origin.y + room.depth },
      { x: room.origin.x, y: room.origin.y + room.depth },
      { x: room.origin.x + room.width, y: room.origin.y },
    ].map(project);
    for (const corner of corners) {
      assert.ok(corner.x >= WORLD.x && corner.x <= WORLD.x + WORLD.width, `${room.id} x`);
      assert.ok(corner.y - room.wallHeight >= WORLD.y, `${room.id} wall top`);
      assert.ok(corner.y <= WORLD.y + WORLD.height, `${room.id} y`);
    }
  }
});

test('bowPath starts and ends at the given points', () => {
  const path = bowPath({ x: 0, y: 0 }, { x: 100, y: 40 });
  assert.match(path, /^M0\.0 0\.0 Q/);
  assert.match(path, /100\.0 40\.0$/);
});

test('six desks in one room all stay inside it and never share a spot', () => {
  for (const room of ROOM_LAYOUT) {
    const desks = deskLayout(room, 6);
    assert.equal(desks.length, 6);
    const spots = new Set(desks.map((d) => `${d.point.x.toFixed(1)},${d.point.y.toFixed(1)}`));
    assert.equal(spots.size, 6, `${room.id} stacks desks`);
    for (const desk of desks) {
      assert.ok(desk.point.x > room.origin.x && desk.point.x < room.origin.x + room.width);
      assert.ok(desk.point.y > room.origin.y && desk.point.y < room.origin.y + room.depth);
    }
  }
});

test('a route attaches to the room edge facing the other end, not the room centre', () => {
  for (const room of ROOM_LAYOUT) {
    const centre = roomAnchor(room);
    const edge = edgeAnchor(room, DISPATCH_LAYOUT.center);
    const dispatch = project(DISPATCH_LAYOUT.center);
    const fromCentre = Math.hypot(dispatch.x - centre.x, dispatch.y - centre.y);
    const fromEdge = Math.hypot(dispatch.x - edge.x, dispatch.y - edge.y);
    assert.ok(fromEdge < fromCentre, `${room.id}: edge anchor is not nearer the dispatch point`);
  }
});
