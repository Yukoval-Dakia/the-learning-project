import { z } from 'zod';
import {
  BankCitationSchema,
  BankInterpretationSchema,
  BankRequirementSchema,
} from '../../tasks/bank-search-semantic';
import { BankSearchScopeSchema } from './bank-search';

export const BANK_SEMANTIC_POLICY = 'bank-semantic-v2-20261022';
export const BANK_VERIFICATION_CAP = 20;
export const BANK_SEARCH_WALL_MS = 180_000;
export const BankSearchV2NewSchema = z
  .object({
    contract_version: z.literal(2),
    query: z.string().min(1).max(400),
    requirements: z.array(BankRequirementSchema).min(1).max(30).optional(),
    scope: BankSearchScopeSchema.partial().optional(),
    use: z.enum(['inspect', 'practice']),
    need: z
      .object({
        count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        needed_by: z.iso.datetime().optional(),
        demand_id: z.string().min(1).optional(),
        demand_revision: z.number().int().positive().optional(),
        definition_digest: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    anchors: z
      .array(
        z
          .object({
            question_ref: z.string().min(1),
            preserve: z.string().min(1).max(2000),
            change: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    supersedes_search_id: z.string().min(1).optional(),
    page_size: z.number().int().min(1).max(50).default(20),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = input.requirements?.map((r) => r.id) ?? [];
    if (ids.length + (input.anchors?.length ?? 0) * 2 > 30)
      ctx.addIssue({
        code: 'custom',
        message: 'conditions and anchor comparison conditions together must not exceed 30',
      });
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => id.startsWith('anchor:') || id === '$joint')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'requirement ids must be unique; anchor: and $joint are reserved',
      });
    }
    if (input.requirements && !input.requirements.some((r) => r.importance === 'required')) {
      ctx.addIssue({ code: 'custom', message: 'at least one required condition is necessary' });
    }
    if (
      input.use === 'practice' &&
      (input.scope?.admission_state === 'withheld' || input.scope?.draft_state === 'draft')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'practice conflicts with withheld/draft-only scope',
      });
    }
  });
export type BankSearchV2New = z.infer<typeof BankSearchV2NewSchema>;
export type BankRequirement = z.infer<typeof BankRequirementSchema>;

export const BankTaskReceiptSchema = z.object({
  task_kind: z.string(),
  task_run_id: z.string().nullable(),
  status: z.enum(['success', 'failed']),
  runner_status: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  usage_basis: z.enum(['reported', 'estimated', 'unknown']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  input_digest: z.string(),
  output_digest: z.string().nullable(),
  compiled_prompt_hash: z.string().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']),
  cost_ref: z.string().nullable(),
  attempt_evidence_ref: z.string().nullable(),
  reason: z.string().nullable(),
});
export type BankTaskReceipt = z.infer<typeof BankTaskReceiptSchema>;
export const BankSemanticCheckSchema = z.object({
  requirement_id: z.string(),
  verdict: z.enum(['supported', 'contradicted', 'unknown']),
  method: z.literal('mixed'),
  reason: z.string(),
  evidence: z.array(
    BankCitationSchema.extend({
      ref: z.string(),
      revision_id: z.string(),
      integrity_digest: z.string(),
    }),
  ),
});
export const BankSemanticHitSchema = z.object({
  ref: z.string().nullable(),
  question_id: z.string(),
  group_id: z.string(),
  revision_id: z.string().nullable(),
  integrity_digest: z.string().nullable(),
  title: z.string(),
  selected_part_ids: z.array(z.string()),
  group: z.enum(['matched', 'unverified', 'contradicted', 'unavailable']),
  verification_status: z.enum(['complete', 'partial', 'failed', 'not_run']),
  checks: z.array(BankSemanticCheckSchema),
  joint: BankSemanticCheckSchema,
  use_availability: z.enum(['available', 'unavailable', 'unknown']),
  missing: z.array(z.string()),
  recall_rank: z.number().int(),
  final_rank: z.number().int(),
  preferred_supported: z.number().int(),
  task_run_ids: z.array(z.string()),
});
export type BankSemanticHit = z.infer<typeof BankSemanticHitSchema>;
export const BankSearchV2OutputSchema = z.object({
  contract_version: z.literal(2),
  status: z.literal('ok'),
  policy_version: z.string(),
  search_id: z.string(),
  as_of: z.string(),
  expires_at: z.string(),
  request_digest: z.string(),
  result_digest: z.string(),
  original_request: BankSearchV2NewSchema,
  canonical_demand_text: z.string(),
  interpretation: BankInterpretationSchema,
  requirements: z.object({
    conditions: z.array(BankRequirementSchema),
    enforced: z.array(z.string()),
    not_verified: z.array(z.string()),
  }),
  scope_applied: z.record(z.string(), z.json()),
  hits: z.array(BankSemanticHitSchema),
  fulfillment: z.enum(['met', 'partial', 'unmet', 'undetermined', 'not_assessed']),
  matched_count: z.number().int(),
  needed_count: z.number().int().nullable(),
  remaining_count: z.number().int().nullable(),
  unverified_count: z.number().int(),
  evidence: z.object({
    candidate_count: z.number().int(),
    checked_count: z.number().int(),
    retrieval_truncated: z.boolean(),
    verification_truncated: z.boolean(),
    unavailable_channels: z.array(z.string()),
    vector_reason: z.string().nullable(),
    recall_scan: z.array(
      z.object({ channel: z.string(), scanned: z.number().int(), stop: z.string() }),
    ),
    index_generation: z.literal('legacy_question_projection_unversioned'),
    index_missing: z.array(z.string()),
    stop_reason: z.string(),
    absence: z.literal('not_established'),
    reasons: z.array(z.string()),
    task_receipts: z.array(BankTaskReceiptSchema),
    evidence_ref: z.null(),
    redeemable_for_gap_or_issuance: z.literal(false),
  }),
  page: z.object({
    page_size: z.number().int(),
    offset: z.number().int(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
  }),
  proposed_demand_definition: z.object({
    definition_digest: z.string(),
    redeemable: z.literal(false),
  }),
});
export type BankSearchV2Output = z.infer<typeof BankSearchV2OutputSchema>;
export const BankSearchV2ErrorSchema = z.object({
  contract_version: z.literal(2),
  status: z.literal('error'),
  code: z.enum([
    'invalid_request',
    'denied',
    'snapshot_stale',
    'snapshot_unavailable',
    'snapshot_signing_unavailable',
    'unsupported_demand_binding',
    'unsupported_predecessor',
    'anchor_unavailable',
  ]),
  detail: z.string(),
});
export class BankSearchV2Error extends Error {
  constructor(
    readonly code: z.infer<typeof BankSearchV2ErrorSchema>['code'],
    message: string,
  ) {
    super(message);
  }
}
