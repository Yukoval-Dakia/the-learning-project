import { z } from 'zod';

const CorrectionEnvelopeSchema = z.object({
  prior_turn_id: z.string().min(1).max(160),
  changed: z.array(z.string().min(1).max(500)).max(12),
  retained: z.array(z.string().min(1).max(500)).max(12),
  uncertain: z.array(z.string().min(1).max(500)).max(12),
});

export const CopilotImplicitCorrectionIntentSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('not_correction') }).strict(),
  z
    .object({
      intent: z.literal('correction'),
      candidate_prior_turn_ids: z.array(z.string().min(1)).min(1).max(12),
    })
    .strict(),
]);

export type CopilotImplicitCorrectionIntent = z.infer<typeof CopilotImplicitCorrectionIntentSchema>;

export type CopilotCorrectionContract = {
  readonly target_prior_turn_id?: string;
  readonly available_prior_turn_ids: readonly string[];
  readonly prior_turn_summaries?: Readonly<Record<string, string>>;
  readonly required_fields: readonly ['prior_turn_id', 'changed', 'retained', 'uncertain'];
};

export type CopilotCorrectionResolution =
  | { readonly kind: 'normal'; readonly reply: string }
  | { readonly kind: 'clarify'; readonly reply: string }
  | { readonly kind: 'corrected'; readonly reply: string };

export type CopilotImplicitCorrectionResolution =
  | { readonly kind: 'normal'; readonly contract: CopilotCorrectionContract }
  | { readonly kind: 'bound'; readonly contract: CopilotCorrectionContract }
  | { readonly kind: 'clarify'; readonly reply: string };

const CORRECTION_ENVELOPE = /\s*<!-- copilot-correction (\{[\s\S]*\}) -->\s*$/;

function clarificationReply(contract: CopilotCorrectionContract): string {
  const turns = contract.available_prior_turn_ids
    .map((id, index, ids) => {
      const distance = ids.length - index;
      const position =
        distance === 1 ? '上一轮' : distance === 2 ? '上上轮' : `往前第 ${distance} 轮`;
      const summary = contract.prior_turn_summaries?.[id];
      return summary
        ? `- ${position}是「${summary}」（prior_turn_id：${id}）`
        : `- ${position}（prior_turn_id：${id}）`;
    })
    .join('\n');
  return `请先明确要更正的 prior_turn_id；我不会把“上一轮”自动绑定到较早的回复。可选历史回复：\n${turns}`;
}

export function resolveImplicitCorrectionContract(
  contract: CopilotCorrectionContract,
  decision: CopilotImplicitCorrectionIntent,
): CopilotImplicitCorrectionResolution {
  if (decision.intent === 'not_correction') return { kind: 'normal', contract };

  const candidates = [...new Set(decision.candidate_prior_turn_ids)];
  const target = candidates.length === 1 ? candidates[0] : undefined;
  if (target === undefined || !contract.available_prior_turn_ids.includes(target)) {
    return { kind: 'clarify', reply: clarificationReply(contract) };
  }

  return {
    kind: 'bound',
    contract: { ...contract, target_prior_turn_id: target },
  };
}

export function resolveCorrectionReply(
  reply: string,
  contract: CopilotCorrectionContract,
): CopilotCorrectionResolution {
  const matched = reply.match(CORRECTION_ENVELOPE);
  if (!matched) {
    return contract.target_prior_turn_id === undefined
      ? { kind: 'normal', reply }
      : { kind: 'clarify', reply: clarificationReply(contract) };
  }

  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(matched[1]);
  } catch {
    return { kind: 'clarify', reply: clarificationReply(contract) };
  }
  const parsed = CorrectionEnvelopeSchema.safeParse(rawEnvelope);
  if (
    !parsed.success ||
    contract.target_prior_turn_id === undefined ||
    parsed.data.prior_turn_id !== contract.target_prior_turn_id ||
    !contract.available_prior_turn_ids.includes(parsed.data.prior_turn_id)
  ) {
    return { kind: 'clarify', reply: clarificationReply(contract) };
  }

  const body = reply.slice(0, matched.index).trimEnd();
  const fields = [
    `更正目标 prior_turn_id：${parsed.data.prior_turn_id}`,
    `已变更：${parsed.data.changed.join('；') || '无'}`,
    `保留：${parsed.data.retained.join('；') || '无'}`,
    `不确定：${parsed.data.uncertain.join('；') || '无'}`,
  ].join('\n');
  return { kind: 'corrected', reply: `${body}\n\n${fields}` };
}
