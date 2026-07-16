import { z } from 'zod';

export const PedagogyMethodId = z.enum([
  'worked_example',
  'completion_problem',
  'open_problem',
  'contrasting_cases',
  'refutation',
  'interleaving',
  'reconstruction',
  'socratic',
]);
export type PedagogyMethodIdT = z.infer<typeof PedagogyMethodId>;

export const ThetaBand = z.enum(['novice', 'developing', 'secure']);
export type ThetaBandT = z.infer<typeof ThetaBand>;

export const PrecisionBand = z.enum(['low', 'medium', 'high']);
export type PrecisionBandT = z.infer<typeof PrecisionBand>;

/**
 * The only learner-state signals the deterministic pedagogy policy may consume.
 * `.strict()` is the runtime half of the type lock: unknown personalization axes
 * fail closed instead of silently influencing method selection.
 */
export const PedagogyState = z
  .object({
    theta_band: ThetaBand,
    precision_band: PrecisionBand,
    misconception_present: z.boolean(),
    kc_is_rule_based: z.boolean(),
  })
  .strict();
export type PedagogyStateT = z.infer<typeof PedagogyState>;

export const StateGuard = z
  .object({
    theta_band: z.array(ThetaBand).min(1).optional(),
    precision_band: z.array(PrecisionBand).min(1).optional(),
    misconception_present: z.boolean().optional(),
    kc_is_rule_based: z.boolean().optional(),
  })
  .strict()
  .refine((guard) => Object.keys(guard).length > 0, 'state guard must constrain a signal');
export type StateGuardT = z.infer<typeof StateGuard>;

export const PedagogyEvidenceRef = z.enum([
  'worked_example_effect',
  'guidance_fading',
  'expertise_reversal',
  'productive_failure',
  'contrasting_cases',
  'refutation_text',
  'interleaving_effect',
  'generation_effect',
  'self_explanation',
]);
export type PedagogyEvidenceRefT = z.infer<typeof PedagogyEvidenceRef>;

export const PedagogyMethodDefinition = z
  .object({
    id: PedagogyMethodId,
    label: z.string().min(1),
    intent: z.string().min(1),
    indicated_when: z.array(StateGuard).min(1),
    contraindicated_when: z.array(StateGuard),
    evidence_refs: z.array(PedagogyEvidenceRef).min(1),
  })
  .strict();
export type PedagogyMethodDefinitionT = z.infer<typeof PedagogyMethodDefinition>;

const PedagogyMethodLibrary = z
  .array(PedagogyMethodDefinition)
  .length(PedagogyMethodId.options.length)
  .superRefine((methods, ctx) => {
    const seen = new Set<PedagogyMethodIdT>();
    for (const [index, method] of methods.entries()) {
      if (seen.has(method.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate pedagogy method: ${method.id}`,
          path: [index, 'id'],
        });
      }
      seen.add(method.id);
    }
    for (const id of PedagogyMethodId.options) {
      if (!seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing pedagogy method: ${id}`,
        });
      }
    }
  });

/**
 * Closed v1 palette. Guards describe eligibility, not efficacy estimates; the
 * single-user product does not have enough observations to learn method effects.
 */
export const PEDAGOGY_METHOD_LIBRARY = PedagogyMethodLibrary.parse([
  {
    id: 'worked_example',
    label: '示范例题',
    intent: '先展示一份带关键决策说明的完整解法。',
    indicated_when: [{ theta_band: ['novice'] }, { precision_band: ['low'] }],
    contraindicated_when: [{ theta_band: ['secure'] }],
    evidence_refs: ['worked_example_effect', 'expertise_reversal'],
  },
  {
    id: 'completion_problem',
    label: '补全问题',
    intent: '保留部分脚手架，让学习者完成剩余关键步骤。',
    indicated_when: [
      { theta_band: ['novice', 'developing'] },
      { precision_band: ['low', 'medium'] },
    ],
    contraindicated_when: [],
    evidence_refs: ['guidance_fading', 'worked_example_effect'],
  },
  {
    id: 'open_problem',
    label: '开放问题',
    intent: '在低脚手架条件下独立组织解法并解释取舍。',
    indicated_when: [{ theta_band: ['secure'], precision_band: ['high'] }],
    contraindicated_when: [{ misconception_present: true }],
    evidence_refs: ['productive_failure', 'generation_effect'],
  },
  {
    id: 'contrasting_cases',
    label: '对比案例',
    intent: '并置容易混淆的案例，用差异显出概念边界。',
    indicated_when: [{ misconception_present: true }, { theta_band: ['developing'] }],
    contraindicated_when: [],
    evidence_refs: ['contrasting_cases'],
  },
  {
    id: 'refutation',
    label: '反驳误解',
    intent: '先明确错误模型，再用反例和正确机制替换它。',
    indicated_when: [{ misconception_present: true }],
    contraindicated_when: [],
    evidence_refs: ['refutation_text'],
  },
  {
    id: 'interleaving',
    label: '交错辨析',
    intent: '交错相邻类型，训练识别该用哪种策略。',
    indicated_when: [{ theta_band: ['secure'], precision_band: ['high'] }],
    contraindicated_when: [{ misconception_present: true }],
    evidence_refs: ['interleaving_effect'],
  },
  {
    id: 'reconstruction',
    label: '结构重建',
    intent: '不直接给现成步骤，从父概念或规则重新派生结论。',
    indicated_when: [
      {
        theta_band: ['developing', 'secure'],
        precision_band: ['medium', 'high'],
        kc_is_rule_based: true,
      },
    ],
    contraindicated_when: [],
    evidence_refs: ['generation_effect', 'self_explanation'],
  },
  {
    id: 'socratic',
    label: '苏格拉底追问',
    intent: '用连续追问让学习者显式说明假设、理由和修正。',
    indicated_when: [
      {
        theta_band: ['developing', 'secure'],
        precision_band: ['medium', 'high'],
      },
    ],
    contraindicated_when: [],
    evidence_refs: ['self_explanation', 'guidance_fading'],
  },
]);
