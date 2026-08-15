import { COPILOT_EVIDENCE_MAX_TRACE_CALLS } from '@/core/copilot-evidence';
import { z } from 'zod';

// YUK-878 — Copilot capability contracts. These schemas previously lived in the
// central src/ai quarry (legacy-task-definitions.ts) and were re-exported by
// src/ai/registry.ts; they moved here with the CopilotDispatch/evidence task
// ownership migration. Byte-identical move — prompt-hash and schema-parse pins
// in src/ai/registry.test.ts stay green without oracle churn.

export const CopilotDispatchDecisionSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('inline'),
      reason: z.enum(['bounded_answer', 'needs_clarification', 'needs_user_decision']),
    })
    .strict(),
  z
    .object({
      mode: z.literal('durable'),
      reason: z.enum(['multi_step_research', 'multi_artifact_work', 'broad_batch_work']),
    })
    .strict(),
]);

export type CopilotDispatchDecision = z.infer<typeof CopilotDispatchDecisionSchema>;

export const CopilotEvidenceSourceRefSchema = z
  .object({
    call_index: z
      .number()
      .int()
      .min(0)
      .max(COPILOT_EVIDENCE_MAX_TRACE_CALLS - 1),
    side: z.enum(['input', 'output']),
    json_pointer: z.string().min(1).max(512),
    role: z.enum(['value', 'scope', 'coverage', 'relation']),
  })
  .strict();

const CopilotEvidenceReasonCodeSchema = z.enum([
  'supported',
  'actual_gap_disclosed',
  'non_evidentiary',
  'noncausal_relation',
  'unsupported_necessity_or_sufficiency',
  'incomplete_scope_or_pagination',
  'projection_boundary_crossed',
  'queue_or_count_unknown_promoted',
  'requested_chain_incomplete',
  'tool_claim_not_observed',
  'internal_contradiction',
]);

/**
 * Blind reference leg for the generic FULL evidence validator. The task never
 * receives candidate prose. It decomposes the exact request into a dense,
 * source-indexed evidence/gap ledger and authors one bounded fallback reply.
 * The server binds every source pointer and request index before the output can
 * be used; the fallback bytes still require their own confirmed comparison.
 */
export const CopilotEvidenceReviewOutputSchema = z
  .object({
    protocol_version: z.literal(1),
    evidence_points: z
      .array(
        z
          .object({
            point_index: z.number().int().min(0).max(95),
            request_unit_indices: z.array(z.number().int().min(0).max(31)).min(1).max(32),
            kind: z.enum(['observed_fact', 'scope_boundary', 'actual_gap']),
            statement_md: z.string().trim().min(1).max(600),
            source_refs: z.array(CopilotEvidenceSourceRefSchema).min(1).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(96),
    request_coverage: z
      .array(
        z
          .object({
            request_unit_index: z.number().int().min(0).max(31),
            status: z.enum(['answerable', 'actual_gap']),
            evidence_point_indices: z.array(z.number().int().min(0).max(95)).min(1).max(96),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    trace_coverage: z
      .array(
        z
          .object({
            call_index: z
              .number()
              .int()
              .min(0)
              .max(COPILOT_EVIDENCE_MAX_TRACE_CALLS - 1),
            relevance: z.enum(['material', 'scope_only', 'not_material', 'unusable']),
            request_unit_indices: z.array(z.number().int().min(0).max(31)).max(32),
            evidence_point_indices: z.array(z.number().int().min(0).max(95)).max(96),
            rationale_md: z.string().trim().min(1).max(400),
          })
          .strict(),
      )
      .min(1)
      .max(COPILOT_EVIDENCE_MAX_TRACE_CALLS),
    safe_reply: z.string().trim().min(1).max(64_000),
  })
  .strict();

export type CopilotEvidenceReviewOutput = z.infer<typeof CopilotEvidenceReviewOutputSchema>;

/** Provider observations only; the server derives pass/fail after dense binding. */
export const CopilotEvidenceVerificationOutputSchema = z
  .object({
    protocol_version: z.literal(1),
    reply_checks: z
      .array(
        z
          .object({
            reply_unit_index: z.number().int().min(0).max(191),
            status: z.enum(['supported', 'explicit_gap', 'unsupported']),
            evidence_point_indices: z.array(z.number().int().min(0).max(95)).max(24),
            source_refs: z.array(CopilotEvidenceSourceRefSchema).max(12),
            reason_codes: z.array(CopilotEvidenceReasonCodeSchema).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(192),
    request_checks: z
      .array(
        z
          .object({
            request_unit_index: z.number().int().min(0).max(31),
            status: z.enum(['answered', 'explicit_gap', 'missing']),
            reply_unit_indices: z.array(z.number().int().min(0).max(191)).max(192),
            evidence_point_indices: z.array(z.number().int().min(0).max(95)).max(96),
            reason_codes: z.array(CopilotEvidenceReasonCodeSchema).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export type CopilotEvidenceVerificationOutput = z.infer<
  typeof CopilotEvidenceVerificationOutputSchema
>;
