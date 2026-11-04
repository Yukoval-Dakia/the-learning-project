import { z } from 'zod';

const CorrectionEnvelopeSchema = z.object({
  prior_turn_id: z.string().min(1).max(160),
  changed: z.array(z.string().min(1).max(500)).max(12),
  retained: z.array(z.string().min(1).max(500)).max(12),
  uncertain: z.array(z.string().min(1).max(500)).max(12),
});

export type CopilotCorrectionContract = {
  readonly target_prior_turn_id?: string;
  readonly restricted_target?: boolean;
  readonly positions_unavailable?: boolean;
  readonly prior_turn_order?: readonly string[];
  readonly restricted_prior_turn_ids?: readonly string[];
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

function clarificationReply(): string {
  return '请说明要更正哪一段回答；可以引用其中一句话，我会核对后再更正。';
}

function bindTarget(
  contract: CopilotCorrectionContract,
  target: string,
): CopilotImplicitCorrectionResolution {
  if (contract.available_prior_turn_ids.includes(target)) {
    return {
      kind: 'bound',
      contract: { ...contract, target_prior_turn_id: target },
    };
  }
  return { kind: 'clarify', reply: clarificationReply() };
}

export function resolveDeterministicCorrectionContract(
  userMessage: string,
  contract: CopilotCorrectionContract,
): CopilotImplicitCorrectionResolution {
  if (
    contract.restricted_target ||
    contract.restricted_prior_turn_ids?.some((id) => userMessage.includes(id))
  ) {
    return {
      kind: 'clarify',
      reply:
        '这条回复仅用于当时的回答，不能自动用于后续更正。请重新输入或粘贴需要使用的内容，并选择本轮用途。',
    };
  }
  if (contract.target_prior_turn_id !== undefined) {
    return bindTarget(contract, contract.target_prior_turn_id);
  }
  return { kind: 'normal', contract };
}

export function resolveCorrectionReply(
  reply: string,
  contract: CopilotCorrectionContract,
  sanitizeProse: (text: string) => string = (text) => text,
): CopilotCorrectionResolution {
  const matched = reply.match(CORRECTION_ENVELOPE);
  if (!matched) {
    return { kind: 'normal', reply: sanitizeProse(reply) };
  }

  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(matched[1]);
  } catch {
    return { kind: 'clarify', reply: clarificationReply() };
  }
  const parsed = CorrectionEnvelopeSchema.safeParse(rawEnvelope);
  if (
    !parsed.success ||
    (contract.target_prior_turn_id !== undefined &&
      parsed.data.prior_turn_id !== contract.target_prior_turn_id) ||
    contract.restricted_prior_turn_ids?.includes(parsed.data.prior_turn_id) ||
    !contract.available_prior_turn_ids.includes(parsed.data.prior_turn_id)
  ) {
    return { kind: 'clarify', reply: clarificationReply() };
  }

  const body = sanitizeProse(reply.slice(0, matched.index)).trimEnd();
  const fields = [
    `更正对象：${contract.prior_turn_summaries?.[parsed.data.prior_turn_id] ?? '先前的回答'}`,
    `已变更：${parsed.data.changed.join('；') || '无'}`,
    `保留：${parsed.data.retained.join('；') || '无'}`,
    `不确定：${parsed.data.uncertain.join('；') || '无'}`,
  ].join('\n');
  return { kind: 'corrected', reply: `${body}\n\n${fields}` };
}
