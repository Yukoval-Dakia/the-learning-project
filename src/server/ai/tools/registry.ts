// YUK-79 / Foundation D M1
// YUK-862 / F3.1 — global output schema enforcement
//
// DomainTool registry — module-level Map<string, DomainTool>. Tools register
// themselves at module load time (Lane B+ side-effect imports); the in-process
// MCP bridge (Lane C) reads from this registry to assemble per-request MCP
// servers.
//
// Side-effect-free until tools call `registerTool`. Tests reset via
// `__resetRegistryForTests` to keep parallel registration deterministic.

import type { DomainTool, ToolEffect } from '@/kernel/tools/types';
import { zodToToolParametersSchema } from '@/kernel/zod-json-schema';

const registry = new Map<string, DomainTool<unknown, unknown>>();

export function registerTool<I, O>(tool: DomainTool<I, O>): void {
  if (registry.has(tool.name)) {
    throw new Error(
      `DomainTool '${tool.name}' already registered. Registration must be unique; check for duplicate side-effect imports.`,
    );
  }
  if (typeof tool.outputSchema?.safeParse !== 'function') {
    throw new Error(
      `DomainTool '${tool.name}' outputSchema must be a Zod schema with a safeParse method. Got ${String(tool.outputSchema)}.`,
    );
  }
  // YUK-1559 — composition-time contract check on the REAL converted schema:
  // provider function calling requires a type:"object" parameters root, so an
  // inputSchema that cannot compile to one (array/primitive/unconstrained
  // roots) is rejected at registration instead of failing mid-run as a
  // provider 400. Union-of-objects roots are normalized by the shared
  // converter; the mount-time z.ZodObject check in buildPiDomainAgentTools is
  // unchanged.
  try {
    zodToToolParametersSchema(tool.inputSchema, {
      io: 'input',
      reused: 'inline',
      target: 'draft-07',
    });
  } catch (error) {
    throw new Error(
      `DomainTool '${tool.name}' inputSchema cannot compile to an object-root tool parameters schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (tool.safeHandoff && tool.effect !== 'read') {
    throw new Error(
      `DomainTool '${tool.name}' safeHandoff requires an explicitly idempotent remote read`,
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
