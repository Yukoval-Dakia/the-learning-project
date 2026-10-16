import { z } from 'zod';

/**
 * YUK-1398：'crisis' 是危机内容的用途类——由服务端在接纳时分类打入，
 * 与 'answer_only' 一样被一切派生读面排除（记忆摄取、简报/横幅、画像）。
 * 与 'answer_only' 的差别只在语义来源：answer_only 由用户声明（仅本次回答），
 * crisis 由危机词法分类器强制（含回复等直接上下文）。客户端可送，但服务端
 * 分类命中时会覆盖为 crisis，不受客户端选择影响。
 */
export const DerivationPolicy = z.enum(['allow', 'answer_only', 'crisis']);
export type DerivationPolicyT = z.infer<typeof DerivationPolicy>;
const PolicyPayload = z.object({ derivation_policy: DerivationPolicy.optional() });

/** Absence preserves legacy behavior. Invalid explicit policies never become allow. */
export function readDerivationPolicy(payload: unknown): DerivationPolicyT {
  return PolicyPayload.parse(payload ?? {}).derivation_policy ?? 'allow';
}

export function allowsDerivation(payload: unknown): boolean {
  const parsed = PolicyPayload.safeParse(payload ?? {});
  return parsed.success && (parsed.data.derivation_policy ?? 'allow') === 'allow';
}
