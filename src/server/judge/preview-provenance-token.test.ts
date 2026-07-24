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
  });

  it('is null (fail-closed) when JUDGE_PROVENANCE_SECRET is unset or empty', () => {
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', '');
    expect(judgeProvenanceSigningSecret()).toBeNull();
  });

  it('returns the configured server-only secret', () => {
    vi.stubEnv('JUDGE_PROVENANCE_SECRET', 'server-only-secret');
    expect(judgeProvenanceSigningSecret()).toBe('server-only-secret');
  });
});
