// YUK-454 increment-1 (ADR-0036 身份层) — misconception identity-table skeleton.
//
// HAND-WRITTEN Zod (NOT drizzle-zod generated). This is the canonical domain
// shape for a misconception: a named, reusable "误区" identity that diagnosis /
// recommendation / review can later attach evidence to.
//
// RED LINES baked into this module by construction:
//   1. ADR-0035 — misconception is the SOFT track. There is NO mastery / p(L) /
//      θ̂ / b / FSRS / difficulty field here, and `.strict()` makes any such key
//      a hard parse failure. The soft-track invariant is enforced at the schema
//      boundary BEFORE any writer exists (this is increment-1; the promotion-flow
//      writer is gated behind the ADR-0034 consistency gate). The REVERSE red-line
//      test (step9-invariant-audit) also asserts this module references none of
//      the soft-track engine symbols by name.
//   2. subject=view — there is NO subject/domain field. Subject is a derived
//      view (effective_domain), never stored on an entity (项目铁律).
//   3. `weight` is a CONFIDENCE signal (how strongly this misconception is held /
//      how salient it is), NOT a mastery / p(L) value. It never feeds the
//      diagnostic engines.
//
// Time dimension: `archived_at` is the ONLY time field besides created/updated.
// Explicitly NO valid_at/invalid_at — bi-temporal edges are a DEFERRED slice
// (misconception_edge + promotion flow), not part of the identity skeleton.
import { z } from 'zod';
import { AgentRef } from './business';

// Canonical select/domain shape. `.strict()` is load-bearing: it is the
// machine-checkable red line that rejects any soft-track diagnostic field
// (theta/pL/mastery/fsrs/difficulty) or a subject/domain column from ever
// riding on a misconception row.
export const MisconceptionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    // Optional explanatory text — why this is a misconception / how it
    // manifests. Nullable: many misconceptions are self-describing by title.
    reasoning: z.string().nullable(),
    // CONFIDENCE-only salience weight (NOT mastery). Defaults to 1.
    weight: z.number().default(1),
    // YUK-531 (A5 S4 / RT1 promotion) — lifecycle + provenance. ALL soft-track:
    // `.strict()` still rejects any θ/pL/mastery/FSRS/difficulty key. status is the
    // promotion lifecycle ('draft'→'active'); `fading`/`retracted` are read-model
    // DISPLAY projections (weight decay / archived_at), never stored enum values.
    // source = 硬轨 confirmed | 软轨 prior. seen = recurrence count (salience, NOT
    // mastery). evidence = provenance event-id array.
    status: z.enum(['draft', 'active']).default('draft'),
    source: z.enum(['hard', 'soft']).default('soft'),
    seen: z.number().int().nonnegative().default(0),
    evidence: z.array(z.string()).default([]),
    created_by: AgentRef,
    proposed_by_ai: z.boolean().default(false),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    // The ONLY time dimension (soft-archive). NO valid_at/invalid_at.
    archived_at: z.coerce.date().nullable(),
  })
  .strict();
export type Misconception = z.infer<typeof MisconceptionSchema>;

// Insert shape mirrors KnowledgeInsert (src/core/schema/index.ts): same fields,
// the defaulted columns (weight / proposed_by_ai) become optional with their
// defaults applied, archived_at defaults to null. `.strict()` is preserved so
// the soft-track red line holds on the write boundary too.
export const MisconceptionInsert = z
  .object({
    id: z.string(),
    title: z.string(),
    reasoning: z.string().nullish(),
    weight: z.number().default(1),
    // YUK-531 — defaulted, so optional on insert (mirrors weight/proposed_by_ai).
    status: z.enum(['draft', 'active']).default('draft'),
    source: z.enum(['hard', 'soft']).default('soft'),
    seen: z.number().int().nonnegative().default(0),
    evidence: z.array(z.string()).default([]),
    created_by: AgentRef,
    proposed_by_ai: z.boolean().default(false),
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    archived_at: z.coerce.date().nullish(),
  })
  .strict();
export type MisconceptionInsert = z.infer<typeof MisconceptionInsert>;
