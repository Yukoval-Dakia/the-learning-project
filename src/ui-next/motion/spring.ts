// A damped spring that keeps its velocity when the target changes, so a new gesture or state can
// take over mid-flight (M3). Steps at a fixed 1/60 s so behaviour does not depend on frame rate.
import { prefersReducedMotion } from './reduced-motion';

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

export interface SpringOptions {
  value: number;
  config: SpringConfig;
  onUpdate: (value: number) => void;
  onRest?: (value: number) => void;
}

export interface SpringHandle {
  /** Move toward `target`, keeping the current velocity (or `velocity` if given, e.g. a fling). */
  to(target: number, velocity?: number): void;
  /** Place the value immediately, without motion. */
  jump(value: number): void;
  get(): number;
  stop(): void;
}

const STEP = 1 / 60;
const REST_DISTANCE = 0.4;
const REST_SPEED = 4;

export function createSpring({ value, config, onUpdate, onRest }: SpringOptions): SpringHandle {
  let current = value;
  let velocity = 0;
  let target = value;
  let frame = 0;

  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const settle = () => {
    stop();
    current = target;
    velocity = 0;
    onUpdate(current);
    onRest?.(current);
  };

  const tick = () => {
    const accel = -config.stiffness * (current - target) - config.damping * velocity;
    velocity += accel * STEP;
    current += velocity * STEP;
    if (Math.abs(current - target) < REST_DISTANCE && Math.abs(velocity) < REST_SPEED) {
      settle();
      return;
    }
    onUpdate(current);
    frame = requestAnimationFrame(tick);
  };

  return {
    to(next, nextVelocity) {
      target = next;
      if (nextVelocity !== undefined) velocity = nextVelocity;
      if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
        settle();
        return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    },
    jump(next) {
      target = next;
      settle();
    },
    get: () => current,
    stop,
  };
}
