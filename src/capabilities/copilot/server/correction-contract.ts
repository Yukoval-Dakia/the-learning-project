import { z } from 'zod';

const CorrectionEnvelopeSchema = z.object({
  prior_turn_id: z.string().min(1).max(160),
  changed: z.array(z.string().min(1).max(500)).max(12),
  retained: z.array(z.string().min(1).max(500)).max(12),
  uncertain: z.array(z.string().min(1).max(500)).max(12),
});

export type CopilotCorrectionContract = {
  readonly target_prior_turn_id?: string;
  readonly available_prior_turn_ids: readonly string[];
  readonly required_fields: readonly ['prior_turn_id', 'changed', 'retained', 'uncertain'];
};

export type CopilotCorrectionResolution =
  | { readonly kind: 'normal'; readonly reply: string }
  | { readonly kind: 'clarify'; readonly reply: string }
  | { readonly kind: 'corrected'; readonly reply: string };

const CORRECTION_ENVELOPE = /\s*<!-- copilot-correction (\{[\s\S]*\}) -->\s*$/;

function clarificationReply(availablePriorTurnIds: readonly string[]): string {
  const ids = availablePriorTurnIds.map((id) => `- ${id}`).join('\n');
  return `请先明确要更正的 prior_turn_id；我不会把“上一轮”自动绑定到较早的回复。可选历史回复：\n${ids}`;
}

export function resolveCorrectionReply(
  reply: string,
  contract: CopilotCorrectionContract,
): CopilotCorrectionResolution {
  const matched = reply.match(CORRECTION_ENVELOPE);
  if (!matched) return { kind: 'normal', reply };

  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(matched[1]);
  } catch {
    return { kind: 'clarify', reply: clarificationReply(contract.available_prior_turn_ids) };
  }
  const parsed = CorrectionEnvelopeSchema.safeParse(rawEnvelope);
  if (
    !parsed.success ||
    contract.target_prior_turn_id === undefined ||
    parsed.data.prior_turn_id !== contract.target_prior_turn_id ||
    !contract.available_prior_turn_ids.includes(parsed.data.prior_turn_id)
  ) {
    return { kind: 'clarify', reply: clarificationReply(contract.available_prior_turn_ids) };
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
