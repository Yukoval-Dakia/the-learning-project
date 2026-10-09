// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flyTo } from './flights';
import { holdReadingPosition } from './reading';
import { FLASH_CLASS, reveal } from './reveal';
import { createSpring } from './spring';

function preferReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('reduced motion (M3)', () => {
  it('lands a flight immediately and leaves no ghost', () => {
    preferReducedMotion(true);
    const target = document.createElement('span');
    document.body.append(target);
    const onLand = vi.fn();
    const node = document.createElement('span');
    flyTo({ from: new DOMRect(0, 0, 10, 10), to: () => target, node, onLand });
    expect(onLand).toHaveBeenCalledTimes(1);
    expect(node.isConnected).toBe(false);
  });

  it('places a spring at its target without motion', () => {
    preferReducedMotion(true);
    const onUpdate = vi.fn();
    const spring = createSpring({ value: 0, config: { stiffness: 240, damping: 29 }, onUpdate });
    spring.to(300, 2000);
    expect(spring.get()).toBe(300);
    expect(onUpdate).toHaveBeenLastCalledWith(300);
  });
});

describe('flights', () => {
  it('lands at once when there is nowhere to fly from', () => {
    preferReducedMotion(false);
    const onLand = vi.fn();
    flyTo({ from: null, to: () => document.body, node: document.createElement('span'), onLand });
    expect(onLand).toHaveBeenCalledTimes(1);
  });
});

describe('reading position (M7)', () => {
  it('does nothing at the top of the page', () => {
    const scroller = document.createElement('div');
    expect(holdReadingPosition(scroller)).toBeTypeOf('function');
    expect(holdReadingPosition(null)).toBeTypeOf('function');
  });
});

describe('reveal (M6)', () => {
  it('restarts the glow instead of letting an earlier timer cut it short', () => {
    vi.useFakeTimers();
    preferReducedMotion(false);
    const el = document.createElement('p');
    document.body.append(el);
    reveal(el);
    vi.advanceTimersByTime(1000);
    reveal(el);
    vi.advanceTimersByTime(1000);
    expect(el.classList.contains(FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(900);
    expect(el.classList.contains(FLASH_CLASS)).toBe(false);
  });
});
