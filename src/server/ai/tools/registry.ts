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

import type { z } from 'zod';
import type { DomainTool, ToolEffect } from '@/kernel/tools/types';
import { zodToToolParametersSchema } from '@/kernel/zod-json-schema';

const registry = new Map<string, DomainTool<unknown, unknown>>();

// YUK-1553 / ADR-0075 C1-1 — effectful tools must declare their wire shape.
// The retired KR tool accepted `payload: z.record(z.string(), z.unknown())`, so
// the model saw no discriminated union and malformed mutations reached the
// dispatcher. `z.unknown()`, `z.any()` and records with an unconstrained value
// hide that shape again; reject them at registration (startup), the same way
// validateComposition rejects contradictory cron/DAG declarations.
//
// Opaque JSON documents validated by an owner parser inside execute (e.g. a
// draft document) use `OpaqueJsonInput` (z.json()): still opaque, but a real
// JSON wire type. Only the top level and direct fields are inspected; nested
// owner schemas are the owner's contract to review.
function unconstrainedFieldReason(schema: z.ZodTypeAny): string | null {
  let current = schema;
  // Unwrap modifiers so `z.unknown().optional()` is caught too. `z.lazy`
  // (including z.json) stays opaque: following recursive getters here would
  // turn the guard into a second schema walker.
  for (;;) {
    const def = current.def as { type: string; innerType?: z.ZodTypeAny };
    if (
      def.type === 'optional' ||
      def.type === 'nullable' ||
      def.type === 'default' ||
      def.type === 'prefault' ||
      def.type === 'catch' ||
      def.type === 'readonly' ||
      def.type === 'nonoptional'
    ) {
      if (!def.innerType) return null;
      current = def.innerType;
      continue;
    }
    break;
  }
  const def = current.def as { type: string; valueType?: z.ZodTypeAny };
  if (def.type === 'unknown') return 'z.unknown()';
  if (def.type === 'any') return 'z.any()';
  if (def.type === 'record') {
    if (!def.valueType) return 'an unconstrained z.record(...)';
    const valueReason = unconstrainedFieldReason(def.valueType);
    if (valueReason !== null) return `a z.record(...) whose values are ${valueReason}`;
  }
  return null;
}

function assertEffectfulInputContract(tool: DomainTool<unknown, unknown>): void {
  if (tool.effect === 'read') return;
  const rootReason = unconstrainedFieldReason(tool.inputSchema);
  if (rootReason !== null) {
    throw new Error(
      `DomainTool '${tool.name}' (${tool.effect}) inputSchema is ${rootReason}; effectful tools must declare a concrete input shape (use OpaqueJsonInput only for an opaque document an owner parser validates).`,
    );
  }
  const shape = (tool.inputSchema as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape) return;
  for (const [field, fieldSchema] of Object.entries(shape)) {
    const reason = unconstrainedFieldReason(fieldSchema);
    if (reason !== null) {
      throw new Error(
        `DomainTool '${tool.name}' (${tool.effect}) inputSchema field '${field}' is ${reason}; effectful tools must declare a concrete input shape (use OpaqueJsonInput only for an opaque document an owner parser validates).`,
      );
    }
  }
}

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
  assertEffectfulInputContract(tool as DomainTool<unknown, unknown>);
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
