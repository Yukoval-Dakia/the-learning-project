// Wave 5 / T-D3/A — Copilot Drawer tweaks panel preferences.
//
// Two new tweaks are introduced by this lane (see Wave 5 ready-to-launch
// §1.6 / YUK-122):
//   • chainRowCost   — how much cost detail to surface on tool-use chain rows
//   • toolUseDetail  — folded vs expanded tool-use card body default
//
// Storage: localStorage scoped to the per-key namespace `loom:tweaks:*`.
// The runtime accessors are SSR-safe (return defaults when window is
// undefined). Subscribers receive `storage` events from cross-tab edits.

'use client';

import { useEffect, useState } from 'react';

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

function writeStoredEnum(key: string, value: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
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
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    setValue(readStoredEnum(key, allowed, fallback));
    function onStorage(ev: StorageEvent) {
      if (ev.key !== key) return;
      setValue(readStoredEnum(key, allowed, fallback));
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, allowed, fallback]);

  function set(next: T) {
    writeStoredEnum(key, next);
    setValue(next);
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
