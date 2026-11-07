import { z } from 'zod';

export const BANK_SEARCH_POLICY = 'bank-evidence-v3';
const Verdict = z.enum(['supported', 'contradicted', 'unknown']);
export const SearchBankInputSchema = z
  .object({
    query: z.string().max(400).optional(),
    use: z.enum(['practice', 'inspect']).optional(),
    count: z.number().int().min(1).max(50).optional(),
    page_size: z.number().int().min(1).max(20).optional(),
    filters: z
      .object({
        subject: z.string().optional(),
        knowledge_ids: z.array(z.string()).max(50).optional(),
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
      .optional(),
    conditions: z
      .array(z.object({ text: z.string().min(1).max(400), required: z.boolean() }).strict())
      .max(10)
      .optional(),
    like_ref: z.string().optional(),
    cursor: z.string().max(6000).optional(),
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
  facts: z.object({
    kind: z.string(),
    knowledge_ids: z.array(z.string()),
    difficulty: z.object({ basis: z.literal('authored'), value: z.number() }),
  }),
  evidence: z.array(z.object({ source: z.string(), text: z.string() })),
});
export const BankSearchOutputSchema = z.object({
  contract_version: z.literal(3),
  search_id: z.string(),
  conditions: z.array(z.object({ id: z.string(), text: z.string(), required: z.boolean() })),
  decision_source: z.literal('caller_assessed'),
  hits: z.array(BankHitSchema),
  coverage: z.object({
    candidates: z.number(),
    complete: z.boolean(),
    unavailable: z.array(z.string()),
    enforced: z.array(z.string()),
    absence: z.literal('not_established'),
  }),
  next_cursor: z.string().nullable(),
});
export type BankSearchOutputV3 = z.infer<typeof BankSearchOutputSchema>;
export type BankDocument = { ref: string; source: string; text: string; parts: string[] };
export class BankSearchError extends Error {}
