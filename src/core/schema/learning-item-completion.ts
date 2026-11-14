import { z } from 'zod';

const Id = z.string().min(1);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CompletionSource = z.object({
  kind: z.enum(['question', 'record', 'event', 'document', 'session']),
  id: Id,
});
export const CompletionSources = z.object({
  nodes: z.array(CompletionSource).min(1),
  epochs: z.record(Id, Id),
});
export const NativeCompletionEvidence = z.object({
  groupId: Id,
  anchorId: Id,
  occurredAt: z.iso.datetime(),
  correct: z.boolean(),
  adverse: z.boolean(),
  submissions: z.array(Id).min(1),
  issuances: z.array(Id).min(1),
  revisions: z.array(Id).min(1),
  captures: z.array(Id).min(1),
  evaluationId: Id,
  generation: z.number().int().nonnegative(),
  settlements: z.array(Id),
  snapshots: z.array(Id),
});
export const CompletionReceiptV1 = z.object({
  format_version: z.literal(1),
  policy_version: z.literal('native-completion-v1'),
  policy: z.object({
    windowDays: z.number().int().positive(),
    minimumOccurrences: z.number().int().positive(),
    minimumLocalDays: z.number().int().positive(),
    latestHours: z.number().positive(),
    minimumMastery: z.number().min(0).max(1),
  }),
  measured_at: z.iso.datetime(),
  item_id: Id,
  item_version: z.number().int().nonnegative(),
  scope_digest: Digest,
  knowledge_ids: z.array(Id).min(1),
  knowledge: z
    .array(
      z.object({
        id: Id,
        genesis: Id,
        point: z.number().min(0).max(1),
        lo: z.number().min(0).max(1),
        hi: z.number().min(0).max(1),
        beta: z.number(),
        beta_basis: z.literal('answered'),
        precision: z.number().positive(),
        counts: z.object({
          evidence: z.number().int().positive(),
          success: z.number().int().nonnegative(),
          fail: z.number().int().nonnegative(),
        }),
        last_outcome_at: z.iso.datetime(),
        evidence: z.array(NativeCompletionEvidence),
        calibration: z.array(z.object({ question_id: Id, beta: z.number() })),
      }),
    )
    .min(1),
  sources: CompletionSources,
  logical_fact_digest: Digest,
  evidence_identity_digest: Digest,
});
export type CompletionReceipt = z.infer<typeof CompletionReceiptV1>;
export type FrozenCompletionSources = z.infer<typeof CompletionSources>;
