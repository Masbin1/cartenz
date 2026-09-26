/**
 * Pan/zoom for the office canvas, as a pure reducer so "zoom in twice then
 * reset" is a state transition anyone can unit-test without a pointer.
 *
 * The camera clamps itself: zoom cannot leave [MIN_ZOOM, MAX_ZOOM] and pan
 * cannot leave a margin around the world, so a runaway scroll or a fat-finger
 * pinch cannot lose the office off-screen with no way back except "Reset".
 */

import { WORLD } from './layout';

export interface Camera {
  zoom: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 2.2;
export const ZOOM_STEP = 0.2;

export const INITIAL_CAMERA: Camera = { zoom: 1, x: 0, y: 0 };

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Pan is bounded to a multiple of the viewport so the floor cannot vanish. */
function clampPan(value: number, viewport: number, zoom: number): number {
  const bound = (viewport * (zoom + 0.4)) / 2;
  return Math.min(bound, Math.max(-bound, value));
}

export type CameraAction =
  | { type: 'zoom-in'; viewport: { width: number; height: number } }
  | { type: 'zoom-out'; viewport: { width: number; height: number } }
  | { type: 'reset' }
  | { type: 'pan'; dx: number; dy: number; viewport: { width: number; height: number } }
  | {
      type: 'wheel-zoom';
      delta: number;
      viewport: { width: number; height: number };
    };

export function cameraReducer(state: Camera, action: CameraAction): Camera {
  switch (action.type) {
    case 'zoom-in':
      return withClampedPan({ ...state, zoom: clampZoom(state.zoom + ZOOM_STEP) }, action.viewport);
    case 'zoom-out':
      return withClampedPan({ ...state, zoom: clampZoom(state.zoom - ZOOM_STEP) }, action.viewport);
    case 'reset':
      return INITIAL_CAMERA;
    case 'pan':
      return withClampedPan(
        { ...state, x: state.x + action.dx, y: state.y + action.dy },
        action.viewport,
      );
    case 'wheel-zoom': {
      // A negative delta (scroll up / pinch out) zooms in.
      const zoom = clampZoom(state.zoom - action.delta * 0.0015);
      return withClampedPan({ ...state, zoom }, action.viewport);
    }
  }
}

function withClampedPan(camera: Camera, viewport: { width: number; height: number }): Camera {
  return {
    ...camera,
    x: clampPan(camera.x, viewport.width, camera.zoom),
    y: clampPan(camera.y, viewport.height, camera.zoom),
  };
}

export function cameraTransform(camera: Camera): string {
  return `translate(${camera.x.toFixed(1)} ${camera.y.toFixed(1)}) scale(${camera.zoom.toFixed(3)})`;
}

/** The viewport assumed before the canvas has measured itself. */
export const DEFAULT_VIEWPORT = { width: WORLD.width, height: WORLD.height };
