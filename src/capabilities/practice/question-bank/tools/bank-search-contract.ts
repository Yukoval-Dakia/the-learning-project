import { z } from 'zod';

export const BANK_SEARCH_POLICY = 'bank-evidence-v3';
const Verdict = z.enum(['supported', 'contradicted', 'unknown']);
export const SearchBankInputSchema = z
  .object({
    query: z.string().max(400).optional(),
    use: z.enum(['inventory', 'dedup', 'practice', 'inspect']).optional(),
    count: z.number().int().min(0).optional(),
    page_size: z.number().int().min(1).max(20).optional(),
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
    checks: z
      .array(
        Decision.extend({
          condition: z
            .string()
            .describe(
              'Copy conditions[].id from this search_bank result (r1, r2, …). Do not paste the condition text.',
            ),
        }),
      )
      .max(10),
    joint: Decision,
  })
  .strict();
export type BankAssessment = z.infer<typeof BankAssessmentSchema>;

type SearchCondition = { id: string; text: string };
type ConditionBinding =
  | { status: 'bound'; id: string }
  | { status: 'unknown'; token: string }
  | { status: 'ambiguous'; token: string };

function bindConditionToken(
  token: string,
  conditions: readonly SearchCondition[],
): ConditionBinding {
  if (conditions.some((condition) => condition.id === token)) return { status: 'bound', id: token };
  const sameText = conditions.filter((condition) => condition.text === token);
  if (sameText.length === 1) return { status: 'bound', id: sameText[0].id };
  if (sameText.length > 1) return { status: 'ambiguous', token };
  return { status: 'unknown', token };
}

function clipConditionText(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function conditionJudgmentMessage(
  conditions: readonly SearchCondition[],
  bindings: readonly ConditionBinding[],
): string {
  const available =
    conditions
      .map((condition) => `${condition.id}=${JSON.stringify(clipConditionText(condition.text))}`)
      .join(', ') || '(none)';
  const problems = bindings.flatMap((binding) => {
    if (binding.status === 'unknown')
      return [`${JSON.stringify(binding.token)} is not a condition id`];
    if (binding.status === 'ambiguous')
      return [`${JSON.stringify(binding.token)} matches more than one condition; use its id`];
    return [];
  });
  const detail = problems.length > 0 ? ` ${problems.join('; ')}.` : '';
  return (
    "checks[].condition must be a condition id from this search's conditions[].id, " +
    'not the condition text. Each condition needs exactly one judgment. ' +
    `Available: ${available}.${detail}`
  );
}

/** Id wins. Unique exact condition text binds to that id so a pasted original still judges it. */
export function bindConditionJudgments(
  conditions: readonly SearchCondition[],
  checks: BankAssessment['checks'],
): { ok: true; checks: BankAssessment['checks'] } | { ok: false; message: string } {
  const bindings = checks.map((check) => bindConditionToken(check.condition, conditions));
  const bound = checks.flatMap((check, index) => {
    const binding = bindings[index];
    return binding?.status === 'bound' ? [{ ...check, condition: binding.id }] : [];
  });
  if (
    bound.length !== checks.length ||
    new Set(bound.map((check) => check.condition)).size !== bound.length ||
    bound.length !== conditions.length
  )
    return { ok: false, message: conditionJudgmentMessage(conditions, bindings) };
  return { ok: true, checks: bound };
}
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
