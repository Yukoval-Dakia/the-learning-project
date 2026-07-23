import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const JudgePreviewProvenanceClaims = z.object({
  version: z.literal(1),
  task_run_id: z.string().min(1),
  task_kind: z.string().min(1),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_template_revision: z.string().min(1),
  subject_profile_id: z.string().min(1),
  subject_profile_version: z.string().min(1),
  judge_route: z.string().min(1),
  result_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type JudgePreviewProvenanceClaimsT = z.infer<typeof JudgePreviewProvenanceClaims>;

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function issueJudgePreviewProvenanceToken(
  claims: JudgePreviewProvenanceClaimsT,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(JudgePreviewProvenanceClaims.parse(claims))).toString(
    'base64url',
  );
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function verifyJudgePreviewProvenanceToken(
  token: string,
  secret: string,
): JudgePreviewProvenanceClaimsT | null {
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra !== undefined) return null;
  const expected = signature(payload, secret);
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    return JudgePreviewProvenanceClaims.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
}
