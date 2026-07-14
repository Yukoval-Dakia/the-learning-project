// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openCopilot,
  openCopilotForNudge,
  useCopilotDwell,
  useCopilotOpenSignal,
} from './use-copilot-dwell';

const LEGACY_VISITED_KEY = 'loom:today:copilot:visited';

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('free-form Copilot cross-surface handoff (YUK-626)', () => {
  beforeEach(() => {
    useCopilotOpenSignal.setState({ request: null, nextSeq: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('opens with a prefill and does not fabricate a skill/entity context', () => {
    openCopilot('来份判断句专项卷');

    expect(useCopilotOpenSignal.getState().request).toEqual({
      seq: 1,
      prefill: '来份判断句专项卷',
    });
  });

  it('keeps a monotonic sequence across repeated handoffs', () => {
    openCopilot('第一份');
    useCopilotOpenSignal.getState().clearRequest();
    openCopilot('第二份');
    expect(useCopilotOpenSignal.getState().request?.seq).toBe(2);
  });
});

describe('Copilot explicit-open gate (YUK-577)', () => {
  let legacyStorage: Storage;

  beforeEach(() => {
    legacyStorage = createMemoryStorage();
    vi.stubGlobal('localStorage', legacyStorage);
    useCopilotOpenSignal.setState({ request: null, nextSeq: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stays closed on a first visit even after the former dwell window', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopilotDwell());

    act(() => vi.advanceTimersByTime(60_000));

    expect(result.current.open).toBe(false);
    expect(legacyStorage.getItem(LEGACY_VISITED_KEY)).toBeNull();
  });

  it('stays closed on a return visit even when the legacy flag exists', () => {
    legacyStorage.setItem(LEGACY_VISITED_KEY, '1');

    const { result } = renderHook(() => useCopilotDwell());

    expect(result.current.open).toBe(false);
  });

  it('manual open remains available and dismissal survives a remount', () => {
    const first = renderHook(() => useCopilotDwell());
    act(() => first.result.current.openDrawer());
    expect(first.result.current.open).toBe(true);

    act(() => first.result.current.closeDrawer());
    expect(first.result.current.open).toBe(false);
    first.unmount();

    const second = renderHook(() => useCopilotDwell());
    expect(second.result.current.open).toBe(false);
  });

  it('keeps qualified proactive nudge signals intact', () => {
    openCopilotForNudge({
      nudge_event_id: 'nudge-1',
      session_id: 'session-1',
      headline: '这份材料处理好了，看看？',
    });

    expect(useCopilotOpenSignal.getState().request).toEqual({
      seq: 1,
      nudge: {
        nudge_event_id: 'nudge-1',
        session_id: 'session-1',
        headline: '这份材料处理好了，看看？',
      },
    });
  });
});
