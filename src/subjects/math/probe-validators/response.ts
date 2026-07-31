import type { ConjectureProbeSpecV2T } from '@/core/schema/business';

function signatureAnswer(
  signature:
    | ConjectureProbeSpecV2T['gold_response_signature']
    | ConjectureProbeSpecV2T['target_error_response_signature'],
): string | null {
  if (signature.kind === 'text') return signature.response_md;
  if (signature.kind === 'answer_with_reason') return signature.answer_md;
  return null;
}

export function deterministicProbeAnswers(probe: ConjectureProbeSpecV2T): {
  gold: [string, string];
  target: [string, string];
} | null {
  const goldSignature = signatureAnswer(probe.gold_response_signature);
  const targetSignature = signatureAnswer(probe.target_error_response_signature);
  if (!goldSignature || !targetSignature) return null;
  return {
    gold: [probe.reference_md, goldSignature],
    target: [probe.expected_target_error_answer_md, targetSignature],
  };
}
