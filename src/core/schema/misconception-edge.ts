// YUK-531 (A5 S4 / ADR-0036 RT1) — heterogeneous misconception edge schema.
//
// HAND-WRITTEN Zod (NOT drizzle-zod generated). Canonical domain shape for a
// `misconception_edge`: a polymorphic (from_kind/to_kind discriminator) edge that
// lets a misconception point at a KC (`caused_by` → the "指向此点的误区" join), at
// another misconception/KC (`confusable_with`), or at an event (`observed_in`).
//
// RED LINES baked in by construction (mirror misconception.ts):
//   1. ADR-0035 SOFT track — NO mastery / p(L) / θ̂ / b / FSRS / difficulty field.
//      `weight` is a CONFIDENCE signal (edge salience), NOT a mastery value, and
//      never feeds the diagnostic engines. `.strict()` makes any such key a hard
//      parse failure on the write boundary.
//   2. subject=view — NO subject/domain field (subject is derived, never stored).
//   3. archived_at is the ONLY time dimension — NO valid_at/invalid_at (this edge
//      is structural, not bi-temporal).
//
// Endpoint-kind × relation_type validity (e.g. caused_by must end at a KC) is NOT
// enforced here — it is the job of the parallel heterogeneous topology gate
// (misconception-topology-gate.ts). This module validates only the vocabulary.
import { z } from 'zod';
import { AgentRef } from './business';

// Polymorphic endpoint kinds. A misconception edge originates at a misconception
// and targets a KC / another misconception / an event (provenance).
export const MisconceptionEdgeKind = z.enum(['misconception', 'knowledge', 'event']);
export type MisconceptionEdgeKind = z.infer<typeof MisconceptionEdgeKind>;

// Canonical relation vocabulary + an `experimental:*` escape valve (ADR-0036) for
// relations that have not yet earned a first-class slot / downstream consumer.
export const CANONICAL_MISCONCEPTION_RELATIONS = [
  'caused_by',
  'confusable_with',
  'observed_in',
] as const;
export const MisconceptionRelationType = z
  .string()
  .refine(
    (s) =>
      (CANONICAL_MISCONCEPTION_RELATIONS as readonly string[]).includes(s) ||
      s.startsWith('experimental:'),
    {
      message:
        'unknown misconception relation_type (expected caused_by | confusable_with | observed_in | experimental:*)',
    },
  );

// Canonical select/domain shape. `.strict()` is load-bearing (soft-track red line).
export const MisconceptionEdgeSchema = z
  .object({
    id: z.string(),
    from_kind: MisconceptionEdgeKind,
    from_id: z.string(),
    to_kind: MisconceptionEdgeKind,
    to_id: z.string(),
    relation_type: MisconceptionRelationType,
    // CONFIDENCE-only edge salience (NOT mastery). Defaults to 1.
    weight: z.number().default(1),
    created_by: AgentRef,
    proposed_by_ai: z.boolean().default(false),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    // The ONLY time dimension (soft-archive). NO valid_at/invalid_at.
    archived_at: z.coerce.date().nullable(),
  })
  .strict();
export type MisconceptionEdge = z.infer<typeof MisconceptionEdgeSchema>;

// Insert shape: defaulted columns (weight / proposed_by_ai) become optional with
// their defaults; archived_at defaults to null. `.strict()` preserved.
export const MisconceptionEdgeInsert = z
  .object({
    id: z.string(),
    from_kind: MisconceptionEdgeKind,
    from_id: z.string(),
    to_kind: MisconceptionEdgeKind,
    to_id: z.string(),
    relation_type: MisconceptionRelationType,
    weight: z.number().default(1),
    created_by: AgentRef,
    proposed_by_ai: z.boolean().default(false),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    archived_at: z.coerce.date().nullish(),
  })
  .strict();
export type MisconceptionEdgeInsert = z.infer<typeof MisconceptionEdgeInsert>;
