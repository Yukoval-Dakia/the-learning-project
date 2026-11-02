// ADR-0036 身份层 — misconception identity-table skeleton.
//
// Hand-written Zod (not drizzle-zod generated). Canonical domain shape: a named,
// reusable "误区" identity that diagnosis / recommendation / review attach evidence to.
//
// RED LINES baked into this module by construction:
//   1. ADR-0035 — misconception is the SOFT track. There is no mastery / p(L) /
//      θ̂ / b / FSRS / difficulty field here, and `.strict()` makes any such key a
//      hard parse failure.
//   2. subject=view — there is no subject/domain field. Subject is a derived view
//      (effective_domain), never stored on an entity.
//   3. `weight` is a CONFIDENCE signal (how strongly this misconception is held /
//      how salient it is), NOT a mastery / p(L) value. It never feeds the
//      diagnostic engines.
//
// Time dimension: `archived_at` is the ONLY time field besides created/updated.
// Explicitly no valid_at/invalid_at. The heterogeneous misconception_edge is
// structural, not bi-temporal.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentRef } from './business';

// Canonical select/domain shape. `.strict()` is load-bearing: it rejects any
// soft-track diagnostic field (theta/pL/mastery/fsrs/difficulty) or a
// subject/domain column from riding on a misconception row.
export const MisconceptionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    // Optional explanatory text — why this is a misconception / how it
    // manifests. Nullable: many misconceptions are self-describing by title.
    reasoning: z.string().nullable(),
    // CONFIDENCE-only salience weight (NOT mastery). Defaults to 1.
    weight: z.number().default(1),
    // RT1 promotion — lifecycle + provenance. ALL soft-track:
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
    // defaulted, so optional on insert (mirrors weight/proposed_by_ai).
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

// 身份约定：misconception id 由 conjecture 身份（cause_category × knowledge_id）哈希决定，
// 同身份再提议 upsert 同一行而不是铸重复身份。住在 core（而非 agency promote writer）是因为
// kernel 读面要按同一约定匹配 live misconception，两边不得各自实现一份哈希。
export function misconceptionIdForConjecture(causeCategory: string, knowledgeId: string): string {
  const key = `${causeCategory}::${knowledgeId}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `misc_${hash}`;
}
