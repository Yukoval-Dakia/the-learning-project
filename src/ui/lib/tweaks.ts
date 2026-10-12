// Wave 5 / T-D3/A — Copilot Drawer tweaks panel preferences.
//
// Two new tweaks are introduced by this lane (see Wave 5 ready-to-launch
// §1.6 / YUK-122):
//   • chainRowCost   — how much cost detail to surface on tool-use chain rows
//   • toolUseDetail  — folded vs expanded tool-use card body default
//
// Storage: localStorage scoped to the per-key namespace `loom:tweaks:*`.
// The runtime accessors are SSR-safe (return defaults when window is
// undefined). Subscribers receive `storage` events from cross-tab edits and
// are notified of writes made in this tab.

'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';

export const CHAIN_ROW_COST_OPTIONS = ['summary-only', 'hover-on-row', 'always-show'] as const;
export type ChainRowCostMode = (typeof CHAIN_ROW_COST_OPTIONS)[number];
export const CHAIN_ROW_COST_DEFAULT: ChainRowCostMode = 'summary-only';

export const TOOL_USE_DETAIL_OPTIONS = ['folded', 'expanded', 'off'] as const;
export type ToolUseDetailMode = (typeof TOOL_USE_DETAIL_OPTIONS)[number];
export const TOOL_USE_DETAIL_DEFAULT: ToolUseDetailMode = 'folded';

export const TWEAK_KEYS = {
  chainRowCost: 'loom:tweaks:chainRowCost',
  toolUseDetail: 'loom:tweaks:toolUseDetail',
} as const;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStoredEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (!isBrowser()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // ignore (private mode / disabled storage)
  }
  return fallback;
}

// Hooks reading a tweak in this tab. Only browser subscribe callbacks are kept here; values
// always live in localStorage. A `storage` event fires only in other tabs, so writes from this
// tab notify these listeners directly.
const tabListeners = new Set<() => void>();

function subscribeTweaks(onChange: () => void): () => void {
  tabListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    tabListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function writeStoredEnum(key: string, value: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
  for (const listener of tabListeners) listener();
}

export function readChainRowCost(): ChainRowCostMode {
  return readStoredEnum(TWEAK_KEYS.chainRowCost, CHAIN_ROW_COST_OPTIONS, CHAIN_ROW_COST_DEFAULT);
}

export function writeChainRowCost(value: ChainRowCostMode): void {
  writeStoredEnum(TWEAK_KEYS.chainRowCost, value);
}

export function readToolUseDetail(): ToolUseDetailMode {
  return readStoredEnum(TWEAK_KEYS.toolUseDetail, TOOL_USE_DETAIL_OPTIONS, TOOL_USE_DETAIL_DEFAULT);
}

export function writeToolUseDetail(value: ToolUseDetailMode): void {
  writeStoredEnum(TWEAK_KEYS.toolUseDetail, value);
}

function useTweakValue<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  // The snapshot is the validated string itself, so equal reads compare equal. The server and
  // hydration render use the default, as before.
  const read = useCallback(() => readStoredEnum(key, allowed, fallback), [key, allowed, fallback]);
  const stored = useSyncExternalStore(subscribeTweaks, read, () => fallback);

  // When storage refuses the write (private mode, disabled storage), the choice still applies to
  // this hook until the stored value changes, as it did before.
  const [unsaved, setUnsaved] = useState<{ key: string; value: T; over: T } | null>(null);
  const value = unsaved && unsaved.key === key && unsaved.over === stored ? unsaved.value : stored;

  function set(next: T) {
    const before = readStoredEnum(key, allowed, fallback);
    writeStoredEnum(key, next);
    setUnsaved(
      readStoredEnum(key, allowed, fallback) === next ? null : { key, value: next, over: before },
    );
  }
  return [value, set];
}

export function useChainRowCost(): [ChainRowCostMode, (v: ChainRowCostMode) => void] {
  return useTweakValue<ChainRowCostMode>(
    TWEAK_KEYS.chainRowCost,
    CHAIN_ROW_COST_OPTIONS,
    CHAIN_ROW_COST_DEFAULT,
  );
}

export function useToolUseDetail(): [ToolUseDetailMode, (v: ToolUseDetailMode) => void] {
  return useTweakValue<ToolUseDetailMode>(
    TWEAK_KEYS.toolUseDetail,
    TOOL_USE_DETAIL_OPTIONS,
    TOOL_USE_DETAIL_DEFAULT,
  );
}
