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

/**
 * YUK-589 (High-sec) — the judge preview provenance token MUST be signed with a
 * server-only secret. INTERNAL_TOKEN is held by every browser/API caller, so
 * signing with it let any client forge `supplied_verified` claims. This returns
 * the dedicated `JUDGE_PROVENANCE_SECRET`, or null when it is unconfigured — in
 * which case callers issue no token and verify none, so supplied results fail
 * closed to `supplied_unverified` rather than being signed with a weak/known key.
 */
export function judgeProvenanceSigningSecret(): string | null {
  const secret = process.env.JUDGE_PROVENANCE_SECRET;
  if (!secret || secret.length === 0) return null;
  // Match the documented `openssl rand -hex 32` setup with a conservative lower
  // bound. Keep the secret opaque (no trim/normalisation) so issuing and verifying
  // use the same key bytes; only reject the raw configured value when it is short.
  if (secret.length < 32) {
    console.error(
      '[judge-provenance] JUDGE_PROVENANCE_SECRET is shorter than 32 characters — refusing to use ' +
        'it. Provenance signing is DISABLED until a sufficiently long server-only secret is set ' +
        '(openssl rand -hex 32).',
    );
    return null;
  }
  // Fail closed if the provenance secret equals INTERNAL_TOKEN: every browser/API
  // caller holds INTERNAL_TOKEN, so an equal value reopens exactly the forgery
  // door this dedicated secret exists to close. Treat it as UNSET (no token
  // issued or verified → supplied results stay supplied_unverified).
  if (secret === process.env.INTERNAL_TOKEN) {
    console.error(
      '[judge-provenance] JUDGE_PROVENANCE_SECRET equals INTERNAL_TOKEN — refusing to use it. ' +
        'Clients hold INTERNAL_TOKEN, so signing with it lets any caller forge supplied_verified ' +
        'claims. Provenance signing is DISABLED until a distinct secret is set ' +
        '(openssl rand -hex 32).',
    );
    return null;
  }
  return secret;
}

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
  // Buffer.from(_, 'base64url') never throws — it silently drops invalid
  // characters — so a try/catch here is false confidence. Decode, then reject
  // any signature that is not canonical base64url (round-trip mismatch) before
  // the constant-time compare, so a garbled/forged encoding can never slip past.
  const actual = Buffer.from(encodedSignature, 'base64url');
  if (actual.toString('base64url') !== encodedSignature) return null;
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    return JudgePreviewProvenanceClaims.parse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
}
