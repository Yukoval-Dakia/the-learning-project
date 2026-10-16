// Which way the flower faces (B2). At rest it faces the reader at the page's own slight angle;
// a pointer or finger within 300px turns it toward itself; it is never more side-on than
// x 22° / y 28°, in any state.

export interface Orientation {
  /** Degrees around each axis. */
  x: number;
  y: number;
  z: number;
}

/** Hard limits in degrees (B2). */
export const LIMIT = { x: 22, y: 28 } as const;
/** How far beyond the flower's edge a pointer is noticed, in px (B2). */
export const LOOK_RADIUS = 300;
/** The most a pointer can add to the rest angle, in degrees. */
const LOOK_MAX = { x: 16, y: 20 } as const;

/** A gentle three-quarter view: the question pages' rest angle (B2). */
export const DEFAULT_REST: Orientation = { x: -6, y: -12, z: 8 };

const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

/**
 * The rest angle turned toward a pointer at (px, py), given the flower's centre and radius on
 * screen. Nearer pointers turn it more; outside the radius it stays at rest.
 */
export function lookToward(
  rest: Orientation,
  pointer: { x: number; y: number } | null,
  centre: { x: number; y: number },
  radius: number,
): Orientation {
  if (!pointer) return rest;
  const dx = pointer.x - centre.x;
  const dy = pointer.y - centre.y;
  const d = Math.hypot(dx, dy);
  const reach = LOOK_RADIUS + radius;
  const weight = d >= reach ? 0 : (1 - d / reach) ** 0.7;
  const nx = d ? dx / d : 0;
  const ny = d ? dy / d : 0;
  return {
    x: clamp(rest.x + ny * LOOK_MAX.x * weight, LIMIT.x),
    y: clamp(rest.y + nx * LOOK_MAX.y * weight, LIMIT.y),
    z: rest.z,
  };
}
