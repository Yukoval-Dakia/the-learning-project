import { describe, expect, it } from 'vitest';
import {
  issueJudgePreviewProvenanceToken,
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
});
