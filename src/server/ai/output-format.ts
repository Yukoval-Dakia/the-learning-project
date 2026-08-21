// YUK-299 — Zod → Agent SDK `outputFormat` adapter.
//
// The Claude Agent SDK accepts `Options.outputFormat` (sdk.d.ts:1655) of shape
// `JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> }`
// (sdk.d.ts:916-919). A migrated task hands the SDK the JSON Schema for its
// expected output and the endpoint constrains the model to it (with SDK-internal
// retries on schema-invalid output; exhaustion surfaces as the
// `error_max_structured_output_retries` result subtype — see runner.ts).
//
// We own the Zod→JSON-Schema conversion behind this thin wrapper so callers see
// only the SDK envelope and the mimo-endpoint dialect decisions stay in one place.

import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import type { ZodTypeAny } from 'zod';

import { zodToJsonSchemaCompat } from '@/kernel/zod-json-schema';

/**
 * Convert a Zod schema into the Agent SDK's `JsonSchemaOutputFormat` envelope.
 *
 * Dialect coercion (the SINGLE place this lives — verified against a real
 * `z.toJSONSchema(VariantVerificationResult)` run):
 *   - INLINE form (`reused: 'inline'`) emits reused, non-recursive schemas directly.
 *     Recursive cycles retain local `$ref`/`definitions` rather than widening the
 *     cycle to `{}`; the current structured-output schemas are non-recursive.
 *   - `$schema` (the draft-07 meta-schema pointer) is STRIPPED — the mimo
 *     endpoint does not need a meta-schema indirection and it is pure noise /
 *     latent dialect risk.
 *   - `additionalProperties: false` is PRESERVED — it tightens the structured
 *     extraction (no extra keys). If the mimo endpoint is later observed to
 *     reject it, strip it here too (this wrapper stays the one dialect seam).
 *   - `default` keyword + `required`-omission for `.default()` fields are
 *     PRESERVED — they correctly mark such fields optional to the endpoint. The
 *     migrated handler's Zod second-pass (`.safeParse`) re-applies the Zod
 *     `.default()`, so a response that omits the field still parses to the same
 *     value the text-fallback path would produce.
 */
export function zodToJsonSchemaOutputFormat(schema: ZodTypeAny): JsonSchemaOutputFormat {
  const raw = zodToJsonSchemaCompat(schema, {
    target: 'draft-07',
    io: 'input',
    reused: 'inline',
  });
  // Strip the meta-schema pointer; keep additionalProperties / default / required.
  const { $schema: _droppedMetaSchemaPointer, ...clean } = raw;
  return { type: 'json_schema', schema: clean };
}
