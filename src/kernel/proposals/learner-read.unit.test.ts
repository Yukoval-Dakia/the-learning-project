import { describe, expect, it } from 'vitest';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import type { LegacyKnowledgeProposalRow, ProposalInboxRow } from './inbox';
import { legacyKnowledgeProposalForLearner, proposalInboxRowForLearner } from './learner-read';

describe('proposal learner reason boundary', () => {
  // @invariant security: provider credentials and third-party contact data in stored reasons never enter the learner DTO
  // @fails-if the public mapper passes through raw reason_md or its nested reasoning copies; serialized credentials and contact data remain visible
  it('withholds sensitive reason copies while retaining internal evidence and links', () => {
    const secret = 'sk-proj-private-evidence-example';
    const contact = 'third-party@example.test';
    const privateReason = JSON.stringify({ api_key: secret, email: contact });
    const payload = parseAiProposalPayload({
      kind: 'knowledge_node',
      target: { subject_kind: 'knowledge', subject_id: null },
      reason_md: 'recent_failure_count_30d=1',
      evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
      proposed_change: { mutation: 'propose_new', name: '数列', parent_id: 'parent-kc' },
      rollback_plan: { reasoning: privateReason },
    });
    const row: ProposalInboxRow = {
      id: 'proposal-id',
      kind: payload.kind,
      target: payload.target,
      payload,
      status: 'stale',
      proposed_at: new Date('2026-10-11T00:00:00Z'),
      decided_at: null,
      actor_ref: 'dreaming',
      task_run_id: 'original-run',
      cost_micro_usd: null,
      source_action: 'propose',
      source_subject_kind: 'knowledge',
      signals: null,
      presentation: null,
    };
    const learnerRow = proposalInboxRowForLearner(row);
    const wire = JSON.stringify(learnerRow);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain(contact);
    expect(wire).not.toContain('recent_failure_count_30d');
    expect(learnerRow.payload.reason_md).toContain('最近 30 天有 1 条失败作答记录');
    expect(learnerRow.payload.evidence_refs).toEqual([{ kind: 'event', id: 'original-evidence' }]);
    expect(learnerRow.status).toBe('stale');
    expect(learnerRow.cost_micro_usd).toBeNull();
    expect(row.payload.reason_md).toBe('recent_failure_count_30d=1');
    expect(JSON.stringify(row.payload.rollback_plan)).toContain(secret);
  });

  // @invariant security: legacy knowledge reads cannot leak credentials or third-party contact data through duplicated ai_proposal reasons
  // @fails-if only the top-level reasoning is mapped and the legacy embedded ai_proposal.reason_md or nested reasoning remains raw
  it('withholds private legacy reason copies rather than decoding a mixed dump', () => {
    const secret = 'sk-proj-legacy-private-example';
    const contact = 'third-party@example.test';
    const reason = `recent_failure_count_30d=1; api_key=${secret}; email=${contact}`;
    const row: LegacyKnowledgeProposalRow = {
      id: 'legacy-proposal',
      kind: 'knowledge',
      payload: {
        mutation: 'reparent',
        node_id: 'kc-1',
        expected_version: 7,
        ai_proposal: { reason_md: reason, rollback_plan: { reasoning: reason } },
      },
      reasoning: reason,
      status: 'accepted',
      proposed_at: new Date('2026-10-11T00:00:00Z'),
      decided_at: new Date('2026-10-11T00:01:00Z'),
    };
    const learnerRow = legacyKnowledgeProposalForLearner(row);
    const wire = JSON.stringify(learnerRow);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain(contact);
    expect(wire).not.toContain('recent_failure_count_30d');
    expect(wire).not.toContain('最近 30 天有 1 条');
    expect(learnerRow.payload.node_id).toBe('kc-1');
    expect(learnerRow.payload.expected_version).toBe(7);
    expect(learnerRow.status).toBe('accepted');
    expect(row.reasoning).toBe(reason);
    expect(JSON.stringify(row.payload)).toContain(secret);
  });
});
