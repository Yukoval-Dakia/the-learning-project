import { z } from 'zod';

export const BANK_SEARCH_POLICY = 'bank-evidence-v3';
const Verdict = z.enum(['supported', 'contradicted', 'unknown']);
export const SearchBankInputSchema = z
  .object({
    query: z
      .string()
      .max(400)
      .optional()
      .describe('Retrieval text; keep the learner/demand wording.'),
    use: z
      .enum(['inventory', 'dedup', 'practice', 'inspect'])
      .optional()
      .describe(
        'inventory searches admitted/servable stock for a gap ticket; dedup searches active, pending/withheld and draft candidates before adding a question; inspect reads all states. Defaults: question_preparer uses inventory (10/page), other callers practice (5/page).',
      ),
    count: z.number().int().min(0).optional().describe('Copy the ticket goal verbatim.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Pagination only — never overrides the inventory goal.'),
    filters: z
      .object({
        subject: z.string().optional(),
        knowledge_ids: z.array(z.string()).max(50).optional(),
        knowledge_mode: z.enum(['all', 'any']).optional(),
        kinds: z.array(z.string().min(1)).min(1).max(10).optional(),
        kind: z.string().optional(),
        difficulty: z
          .object({
            basis: z.enum(['authored', 'calibrated']),
            range: z.tuple([z.number(), z.number()]),
          })
          .optional(),
        terms: z.array(z.string().min(1).max(100)).max(10).optional(),
        history: z.enum(['any', 'unseen', 'wrong']).optional(),
        exclude_refs: z.array(z.string()).max(50).optional(),
      })
      .strict()
      .optional()
      .describe(
        'Deterministic scope. kinds is an allowed-type union, not one question of every kind; inventory knowledge_ids default to all on ONE question (knowledge_mode all). For dedup broaden knowledge/kind filters to avoid missing mislabeled duplicates. Numeric difficulty needs a known scale/range — never invent one from a relative band.',
      ),
    conditions: z
      .array(z.object({ text: z.string().min(1).max(400), required: z.boolean() }).strict())
      .max(10)
      .optional()
      .describe(
        'Ticket conditions with required/preferred semantics, judged by the caller with same-question joint evidence; unknown or contradicted cannot pass. Practice/inventory need at least one required condition.',
      ),
    like_ref: z.string().optional().describe('Find questions similar to this bank ref.'),
    cursor: z
      .string()
      .max(6000)
      .optional()
      .describe('Continue the same snapshot: resend only the unchanged cursor.'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.cursor) {
      if (Object.keys(v).some((k) => k !== 'cursor'))
        ctx.addIssue({ code: 'custom', message: 'Continue with only the unchanged cursor.' });
    } else if (!v.query?.trim()) ctx.addIssue({ code: 'custom', message: 'query is required' });
  });
export type SearchBankInput = z.infer<typeof SearchBankInputSchema>;
const Evidence = z.object({ source: z.string(), quote: z.string().min(1).max(1000) }).strict();
const Decision = z.object({ verdict: Verdict, evidence: z.array(Evidence).max(10) }).strict();
export const BankAssessmentSchema = z
  .object({
    ref: z.string(),
    parts: z.array(z.string()).min(1).max(20),
    checks: z.array(Decision.extend({ condition: z.string() })).max(10),
    joint: Decision,
  })
  .strict();
export type BankAssessment = z.infer<typeof BankAssessmentSchema>;
export const BankHitSchema = z.object({
  id: z.string(),
  ref: z.string().nullable(),
  title: z.string(),
  parts: z.array(z.string()),
  available: z.boolean(),
  missing: z.array(z.object({ part: z.string(), reason: z.string() })),
  facts: z.object({
    source: z.string(),
    kind: z.string(),
    draft_status: z.string().nullable(),
    admission: z.enum(['admitted', 'withheld']).nullable(),
    withheld_reason: z.string().nullable(),
    suspended: z.boolean(),
    knowledge_ids: z.array(z.string()),
    difficulty: z.object({
      basis: z.enum(['authored', 'calibrated']),
      value: z.number().nullable(),
    }),
  }),
  evidence: z.array(z.object({ source: z.string(), text: z.string(), complete: z.boolean() })),
});
export const BankSearchOutputSchema = z.object({
  contract_version: z.literal(3),
  search_id: z.string(),
  goal: z.object({
    use: z.enum(['inventory', 'dedup', 'practice', 'inspect']),
    count: z.number().int().nonnegative().nullable(),
  }),
  conditions: z.array(z.object({ id: z.string(), text: z.string(), required: z.boolean() })),
  decision_source: z.literal('caller_assessed'),
  hits: z.array(BankHitSchema),
  coverage: z.object({
    candidates: z.number(),
    prior: z.object({
      requested: z.boolean(),
      missing_refs: z.array(z.string()),
      missing_channels: z.array(z.string()),
    }),
    complete: z.boolean(),
    unavailable: z.array(z.string()),
    enforced: z.array(z.string()),
    absence: z.literal('not_established'),
  }),
  next_cursor: z.string().nullable(),
});
export type BankSearchOutputV3 = z.infer<typeof BankSearchOutputSchema>;
export type BankDocument = {
  ref: string;
  source: string;
  text: string;
  parts: string[];
  complete?: boolean;
  missing?: string[];
};
export class BankSearchError extends Error {}
