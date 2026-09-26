import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_CAMERA,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraReducer,
  cameraTransform,
  DEFAULT_VIEWPORT,
} from './camera';

const viewport = DEFAULT_VIEWPORT;

test('starts at identity: no zoom, no pan', () => {
  assert.deepEqual(INITIAL_CAMERA, { zoom: 1, x: 0, y: 0 });
  assert.equal(cameraTransform(INITIAL_CAMERA), 'translate(0.0 0.0) scale(1.000)');
});

test('zoom in and out are inverses at normal levels', () => {
  const zoomedIn = cameraReducer(INITIAL_CAMERA, { type: 'zoom-in', viewport });
  const backOut = cameraReducer(zoomedIn, { type: 'zoom-out', viewport });
  assert.equal(backOut.zoom, 1);
});

test('zoom cannot pass the maximum', () => {
  let camera = INITIAL_CAMERA;
  for (let step = 0; step < 20; step += 1)
    camera = cameraReducer(camera, { type: 'zoom-in', viewport });
  assert.equal(camera.zoom, MAX_ZOOM);
});

test('zoom cannot pass the minimum', () => {
  let camera = INITIAL_CAMERA;
  for (let step = 0; step < 20; step += 1)
    camera = cameraReducer(camera, { type: 'zoom-out', viewport });
  assert.equal(camera.zoom, MIN_ZOOM);
});

test('reset returns the camera to identity from anywhere', () => {
  let camera = cameraReducer(INITIAL_CAMERA, { type: 'zoom-in', viewport });
  camera = cameraReducer(camera, { type: 'pan', dx: 120, dy: -60, viewport });
  camera = cameraReducer(camera, { type: 'reset' });
  assert.deepEqual(camera, INITIAL_CAMERA);
});

test('pan moves the camera and is bounded', () => {
  const panned = cameraReducer(INITIAL_CAMERA, { type: 'pan', dx: 40, dy: -20, viewport });
  assert.equal(panned.x, 40);
  assert.equal(panned.y, -20);

  const runaway = cameraReducer(INITIAL_CAMERA, { type: 'pan', dx: 99_999, dy: 99_999, viewport });
  assert.ok(Math.abs(runaway.x) < 99_999);
  assert.ok(Math.abs(runaway.y) < 99_999);
});

test('pan survives zooming: the bounding scales with zoom', () => {
  const zoomed = cameraReducer(INITIAL_CAMERA, { type: 'zoom-in', viewport });
  const panned = cameraReducer(zoomed, { type: 'pan', dx: 5000, dy: 0, viewport });
  assert.ok(panned.x > 0);
  assert.ok(panned.x <= (viewport.width * (zoomed.zoom + 0.4)) / 2);
});

test('wheel up (negative delta) zooms in, wheel down zooms out', () => {
  const inZoom = cameraReducer(INITIAL_CAMERA, { type: 'wheel-zoom', delta: -300, viewport });
  assert.ok(inZoom.zoom > 1);
  const outZoom = cameraReducer(INITIAL_CAMERA, { type: 'wheel-zoom', delta: 300, viewport });
  assert.ok(outZoom.zoom < 1);
});

test('wheel zoom respects the same clamp', () => {
  const camera = cameraReducer(INITIAL_CAMERA, { type: 'wheel-zoom', delta: -99_999, viewport });
  assert.equal(camera.zoom, MAX_ZOOM);
});

test('the transform serialises what the renderer applies', () => {
  assert.equal(cameraTransform({ zoom: 1.25, x: 12, y: -8 }), 'translate(12.0 -8.0) scale(1.250)');
});
