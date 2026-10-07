import { describe, expect, it } from 'vitest';
import { resolveDomainToolNames } from '@/kernel/tools/allowlists';
import { SubmitReviewAnswerInputSchema } from './submit-review-answer';

const pointer = {
  submission_id: 'sub_original',
  issuance_id: 'iss_original',
  evaluation_group_id: 'group_original',
};

describe('submit review tool input authority', () => {
  it.each([
    { actor_kind: 'user', actor_ref: 'self', independent: true },
    { actor: { kind: 'user', ref: 'self' }, assistance: 'independent' },
    { response_md: 'model generated answer' },
    { response_set: { entries: [{ slot_id: 'slot', kind: 'text', text_md: 'model answer' }] } },
    { authorized: true, user_id: 'self' },
  ])('rejects extra answer or authority fields: %j', (extra) => {
    expect(SubmitReviewAnswerInputSchema.safeParse({ ...pointer, ...extra }).success).toBe(false);
  });

  it('accepts only an original pointer, which conveys no submission permission', () => {
    expect(SubmitReviewAnswerInputSchema.parse(pointer)).toEqual(pointer);
  });

  it.each([
    'knowledge_review',
    'copilot',
    'copilot_user_suggested_mistake_action',
    'dreaming',
    'coach',
    'maintenance',
    'ingestion_block_edit',
  ] as const)('has no grant on the %s surface', (surface) => {
    expect(resolveDomainToolNames(surface)).not.toContain('submit_review_answer');
  });
});
