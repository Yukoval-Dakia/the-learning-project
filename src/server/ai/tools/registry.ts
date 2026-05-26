// YUK-79 / Foundation D M1
//
// DomainTool registry — module-level Map<string, DomainTool>. Tools register
// themselves at module load time (Lane B+ side-effect imports); the in-process
// MCP bridge (Lane C) reads from this registry to assemble per-request MCP
// servers.
//
// Side-effect-free until tools call `registerTool`. Tests reset via
// `__resetRegistryForTests` to keep parallel registration deterministic.

import type { DomainTool, ToolEffect } from './types';

const registry = new Map<string, DomainTool<unknown, unknown>>();

export function registerTool<I, O>(tool: DomainTool<I, O>): void {
  if (registry.has(tool.name)) {
    throw new Error(
      `DomainTool '${tool.name}' already registered. Registration must be unique; check for duplicate side-effect imports.`,
    );
  }
  registry.set(tool.name, tool as DomainTool<unknown, unknown>);
}

export function getTool(name: string): DomainTool<unknown, unknown> | undefined {
  return registry.get(name);
}

export function listTools(filter?: { effect?: ToolEffect }): DomainTool<unknown, unknown>[] {
  const all = [...registry.values()];
  if (!filter?.effect) return all;
  return all.filter((t) => t.effect === filter.effect);
}

/**
 * Test-only reset. Production callers must not use this — the registry is
 * supposed to be append-once at startup. Exported under `__` prefix so it
 * surfaces in autocomplete as clearly internal.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
