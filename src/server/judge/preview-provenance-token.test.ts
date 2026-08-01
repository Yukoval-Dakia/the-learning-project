import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  issueJudgePreviewProvenanceToken,
  judgeProvenanceSigningSecret,
  verifyJudgePreviewProvenanceToken,
} from './preview-provenance-token';

const claims = {
  version: 1 as const,
  task_run_id: 'tr-1',
  task_kind: 'SemanticJudgeTask',
  input_hash: 'a'.repeat(64),
  prompt_fingerprint: 'b'.repeat(64),
  prompt_template_revision: 'judge-prompt-v1',
  subject_profile_id: 'yuwen',
  subject_profile_version: '1.0.0',
  judge_route: 'semantic',
  result_digest: 'c'.repeat(64),
};

describe('judge preview provenance token', () => {
  it('round-trips server-authenticated invocation claims', () => {
    const token = issueJudgePreviewProvenanceToken(claims, 'secret');
    expect(verifyJudgePreviewProvenanceToken(token, 'secret')).toEqual(claims);
  });

  it('rejects tampered claims and a different signing secret', () => {
    const token = issueJudgePreviewProvenanceToken(claims, 'secret');
    const [payload, signature] = token.split('.');
    expect(verifyJudgePreviewProvenanceToken(`${payload}x.${signature}`, 'secret')).toBeNull();
    expect(verifyJudgePreviewProvenanceToken(token, 'other-secret')).toBeNull();
  });

  // YUK-589 (High-sec) — the server signs with JUDGE_PROVENANCE_SECRET. A client
  // that holds INTERNAL_TOKEN (every browser/API caller does) and forges a token
  // with it must NOT verify against the distinct server-only secret.
  it('rejects a claim a client forged with INTERNAL_TOKEN', () => {
    const internalToken = 'internal-token-held-by-every-client';
    const serverSecret = 'server-only-judge-provenance-secret';
    const forged = issueJudgePreviewProvenanceToken(
      { ...claims, result_digest: 'f'.repeat(64) },
      internalToken,
    );
    expect(verifyJudgePreviewProvenanceToken(forged, serverSecret)).toBeNull();
  });
});

describe('judgeProvenanceSigningSecret', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is silently null (fail-closed) when JUDGE_PROVENANCE_SECRET is unset or empty', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', undefined);
    expect(judgeProvenanceSigningSecret()).toBeNull();

    vi.stubEnv('JUDGE_PROVENANCE_SECRET', '');
    expect(judgeProvenanceSigningSecret()).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects a distinct 31-character secret loudly without disclosing it', () => {
    const shortSecret = 's'.repeat(31);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', shortSecret);
    vi.stubEnv('INTERNAL_TOKEN', 'internal-token-held-by-browser-clients');

    expect(judgeProvenanceSigningSecret()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/shorter than 32 characters/);
    expect(String(log.mock.calls[0]?.[0])).not.toContain(shortSecret);
  });

  it('returns an exact 32-character distinct server-only secret unchanged', () => {
    const secret = 's'.repeat(32);
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', secret);
    vi.stubEnv('INTERNAL_TOKEN', 'internal-token-held-by-browser-clients');

    expect(judgeProvenanceSigningSecret()).toBe(secret);
  });

  it('returns a realistic openssl-style 64-hex secret unchanged', () => {
    const secret = '8f9d4b0a12c37e56d8910abc4def56788f9d4b0a12c37e56d8910abc4def5678';
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', secret);
    vi.stubEnv('INTERNAL_TOKEN', 'internal-token-held-by-browser-clients');

    expect(judgeProvenanceSigningSecret()).toBe(secret);
  });

  it('rejects a sufficiently long secret that equals INTERNAL_TOKEN', () => {
    const sharedSecret = 'shared-with-browser-clients'.repeat(2);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', sharedSecret);
    vi.stubEnv('INTERNAL_TOKEN', sharedSecret);

    expect(judgeProvenanceSigningSecret()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/equals INTERNAL_TOKEN/);
    expect(String(log.mock.calls[0]?.[0])).not.toContain(sharedSecret);
  });

  it('reports the length failure first when a short secret also equals INTERNAL_TOKEN', () => {
    const sharedShortSecret = 'x'.repeat(31);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', sharedShortSecret);
    vi.stubEnv('INTERNAL_TOKEN', sharedShortSecret);

    expect(judgeProvenanceSigningSecret()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/shorter than 32 characters/);
    expect(String(log.mock.calls[0]?.[0])).not.toMatch(/equals INTERNAL_TOKEN/);
  });
});
