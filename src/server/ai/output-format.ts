// YUK-299 — Zod → Agent SDK `outputFormat` adapter.
//
// The Claude Agent SDK accepts `Options.outputFormat` (sdk.d.ts:1655) of shape
// `JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> }`
// (sdk.d.ts:916-919). A migrated task hands the SDK the JSON Schema for its
// expected output and the endpoint constrains the model to it (with SDK-internal
// retries on schema-invalid output; exhaustion surfaces as the
// `error_max_structured_output_retries` result subtype — see runner.ts).
//
// We OWN the Zod→JSON-Schema conversion behind this thin wrapper so:
//   1. callers never import `zod-to-json-schema` directly — they only see
//      `zodToJsonSchemaOutputFormat()` returning our SDK envelope. Swapping the
//      conversion implementation later touches exactly this one file.
//   2. the mimo-endpoint JSON-Schema dialect coercion (see below) lives in ONE
//      place rather than being re-derived at every call site.
//
// Why OSS over a hand-rolled converter: per the project's "use mature OSS for
// solved problems" principle (CLAUDE.md design principles), and because the
// long-tail schemas this seam will migrate (judges: nested object / union /
// refine chains) would turn a hand-rolled converter into a half-built OSS
// reimplementation. `zod-to-json-schema@3.25.2` was already resolved in the
// lockfile as a transitive dep (of @mistralai/mistralai + @modelcontextprotocol/
// sdk); promoting it to a direct dep added no new resolution node.

import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Convert a Zod schema into the Agent SDK's `JsonSchemaOutputFormat` envelope.
 *
 * Dialect coercion (the SINGLE place this lives — verified against a real
 * `zodToJsonSchema(VariantVerificationResult)` run):
 *   - INLINE form (`$refStrategy: 'none'`, no schema name) → emits the schema
 *     body directly with NO `$ref`/`definitions` wrapper. The named form would
 *     emit `{ $ref: '#/definitions/Name', definitions: {...} }`, which is a
 *     reference envelope rather than the schema body the SDK's `schema` field
 *     expects, so we always use the inline form.
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
  // Inline form ($refStrategy:'none', no name) → flat schema body, no $ref.
  const raw = zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown>;
  // Strip the meta-schema pointer; keep additionalProperties / default / required.
  const { $schema: _droppedMetaSchemaPointer, ...clean } = raw;
  return { type: 'json_schema', schema: clean };
}
