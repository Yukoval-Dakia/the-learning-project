// DomainTool registry — module-level Map. Capability manifests register their tools
// at startup, and the in-process bridge reads this registry to assemble mounts.
//
// Side-effect-free until a module calls `registerTool`; tests reset via
// `__resetRegistryForTests` to keep parallel registration deterministic.

import type { z } from 'zod';
import type { DomainTool, ToolEffect } from '@/kernel/tools/types';
import { zodToToolParametersSchema } from '@/kernel/zod-json-schema';

const registry = new Map<string, DomainTool<unknown, unknown>>();

// YUK-1553 / ADR-0075 C1-1 — effectful tools must declare their wire shape. The
// retired KR tool accepted `payload: z.record(...)`, so the model saw no union and
// malformed mutations reached the dispatcher. `z.unknown()`, `z.any()` and
// unconstrained records hide the shape again, so registration rejects them at
// startup. Opaque documents validated by an owner parser use `OpaqueJsonInput`
// (z.json()); only the top level and direct fields are inspected.
function unconstrainedFieldReason(schema: z.ZodTypeAny): string | null {
  let current = schema;
  // Unwrap modifiers so `z.unknown().optional()` is caught too. `z.lazy`
  // (including z.json) stays opaque — following getters would be a second walker.
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
  // YUK-1559 — provider function calling needs a type:"object" parameters root, so
  // reject at registration a schema that cannot compile to one instead of failing
  // mid-run as a provider 400. Union-of-object roots are normalized by the converter.
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
 * Test-only reset; production is append-once at startup. The `__` prefix marks it
 * internal.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
