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

function clarificationReply(
  contract: CopilotCorrectionContract,
  turnIds: readonly string[] = contract.available_prior_turn_ids,
): string {
  if (turnIds.length === 0) {
    return '请先明确要更正的 prior_turn_id；我不会把“上一轮”自动绑定到较早的回复。';
  }
  const turns = turnIds
    .map((id) => {
      // Position labels stay relative to the FULL history so a narrowed
      // candidate list does not renumber older turns as “上一轮”.
      const index = contract.available_prior_turn_ids.indexOf(id);
      const distance = contract.available_prior_turn_ids.length - index;
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

const CORRECTION_VERB =
  /(?:更正|纠正|改正|修正|重写|重新写|替换|改(?:一下|掉|成)|correct|revise|rewrite|fix|change)/i;
const PRIOR_ANSWER_CUE =
  /(?:那个|之前(?:那)?|前面(?:那)?|你刚才(?:的|说的)?|你(?:上次|前面)的)(?:的)?(?:一?轮|回答|回复|解释|结论)/;

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
  return { kind: 'clarify', reply: clarificationReply(contract, []) };
}

export function resolveDeterministicCorrectionContract(
  userMessage: string,
  contract: CopilotCorrectionContract,
): CopilotImplicitCorrectionResolution {
  if (contract.target_prior_turn_id !== undefined) {
    return bindTarget(contract, contract.target_prior_turn_id);
  }
  if (!CORRECTION_VERB.test(userMessage)) return { kind: 'normal', contract };

  const exactTargets = contract.available_prior_turn_ids.filter((id) => userMessage.includes(id));
  if (exactTargets.length === 1) return bindTarget(contract, exactTargets[0] as string);
  if (exactTargets.length > 1) {
    return { kind: 'clarify', reply: clarificationReply(contract, exactTargets) };
  }

  const distances = new Set<number>();
  if (/(?:上上轮|上两轮|前两轮)/.test(userMessage)) distances.add(2);
  if (/(?:上一轮|上一个回答|刚才(?:那|的)?(?:一轮|回答)?)/.test(userMessage)) {
    distances.add(1);
  }
  const numbered = userMessage.match(/往前第\s*(\d{1,2})\s*轮/);
  if (numbered?.[1]) distances.add(Number(numbered[1]));

  if (distances.size === 1) {
    const distance = [...distances][0] as number;
    const target = contract.available_prior_turn_ids.at(-distance);
    return target
      ? bindTarget(contract, target)
      : { kind: 'clarify', reply: clarificationReply(contract) };
  }
  if (distances.size > 1) {
    return { kind: 'clarify', reply: clarificationReply(contract) };
  }

  if (!PRIOR_ANSWER_CUE.test(userMessage)) return { kind: 'normal', contract };
  if (contract.available_prior_turn_ids.length === 1) {
    return bindTarget(contract, contract.available_prior_turn_ids[0] as string);
  }
  return { kind: 'clarify', reply: clarificationReply(contract) };
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
