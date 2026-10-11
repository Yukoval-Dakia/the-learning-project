import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { type AiProposalPayloadT, parseAiProposalPayload } from '@/core/schema/proposal';
import type { LegacyKnowledgeProposalRow, ProposalInboxRow } from './inbox';
import { legacyKnowledgeProposalForLearner, proposalInboxRowForLearner } from './learner-read';
import { proposalChangeSummary, proposalDisplayTitle } from './presentation';
import { proposalReasonPlainText } from './reason-text';

function presentedRow(payload: AiProposalPayloadT): ProposalInboxRow {
  return {
    id: 'proposal-with-presentation',
    kind: payload.kind,
    target: payload.target,
    payload,
    status: 'stale',
    proposed_at: new Date('2026-10-11T00:00:00Z'),
    decided_at: new Date('2026-10-11T00:01:00Z'),
    actor_ref: 'coach',
    task_run_id: 'original-run',
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: payload.target.subject_kind,
    signals: null,
    presentation: {
      title: proposalDisplayTitle(payload),
      change_summary: proposalChangeSummary(payload),
      evidence_labels: { 'event:original-evidence': '原始作答' },
      block_merge: null,
    },
  };
}

function reasonProposals(reason: string) {
  const common = {
    reason_md: '请核实相关记录。',
    evidence_refs: [{ kind: 'event', id: 'original-evidence' }],
  };
  return [
    {
      label: '安排说明',
      payload: parseAiProposalPayload({
        ...common,
        kind: 'defer',
        target: { subject_kind: 'learning_item', subject_id: 'item-1' },
        proposed_change: { learning_item_id: 'item-1', defer_until: '2026-10-12', reason },
      }),
    },
    {
      label: '原因',
      payload: parseAiProposalPayload({
        ...common,
        kind: 'archive',
        target: { subject_kind: 'learning_item', subject_id: 'item-1' },
        proposed_change: { archived_reason: reason, reason, expected_version: 7 },
      }),
    },
    {
      label: '判断依据',
      payload: parseAiProposalPayload({
        ...common,
        kind: 'goal_scope',
        target: { subject_kind: 'goal', subject_id: 'goal-1' },
        proposed_change: { title: '数列', scope_knowledge_ids: ['kc-1'], reasoning: reason },
      }),
    },
  ];
}

// Execute the actual scalar projections without loading the DB/provider-backed brief module.
function teachingBriefProjection(
  functionName: string,
  propertyPath: string[],
  bindings: Record<string, unknown>,
): string {
  const path = new URL('../../capabilities/shell/server/teaching-brief.ts', import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === functionName,
  );
  if (!fn) throw new Error(`Missing brief projection ${functionName}`);
  let expression: ts.Node = fn;
  for (const name of propertyPath) {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) {
        found ??= node.initializer;
      }
      if (!found) ts.forEachChild(node, visit);
    };
    visit(expression);
    if (!found) throw new Error(`Missing brief field ${functionName}.${name}`);
    expression = found;
  }
  const result: unknown = runInNewContext(
    expression.getText(source),
    {
      ...bindings,
      proposalReasonPlainText,
    },
    { timeout: 1000 },
  );
  if (typeof result !== 'string') throw new Error('Brief summary must remain a string');
  return result;
}

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

  // @invariant security: reasons cannot leak through the real display projection created before the public payload mapping
  // @fails-if defer, archive or goal_scope copies an unsafe reason into change_summary without the shared reason policy
  it('withholds unsafe reasons in genuine non-null proposal presentations', () => {
    const reason =
      '依据 recent_failure_count_30d=2; api_key=sk-ant-private-example; email=third-party@example.test';
    for (const { label, payload } of reasonProposals(reason)) {
      const row = presentedRow(payload);
      const summary = row.presentation?.change_summary.find((item) => item.label === label);
      expect(summary?.value).toBe('这条提议暂无可读的依据说明，请核实后再决定是否采纳。');
      const learnerRow = proposalInboxRowForLearner(row);
      expect(JSON.stringify(learnerRow.presentation)).not.toContain('sk-ant-private-example');
      expect(JSON.stringify(learnerRow.presentation)).not.toContain('third-party@example.test');
      expect(JSON.stringify(learnerRow.presentation)).not.toContain('recent_failure_count_30d');
      expect(learnerRow.presentation?.title).toBe(row.presentation?.title);
      expect(learnerRow.presentation?.evidence_labels).toEqual({
        'event:original-evidence': '原始作答',
      });
      expect(JSON.stringify(row.payload)).toContain(reason);
    }
  });

  // @invariant security: the admitted public reason and archived_reason fields cannot retain credentials after presentation is safe
  // @fails-if the payload mapper omits reason or archived_reason; the serialized public payload still includes the private value
  it('withholds unsafe payload reason fields while retaining identity and history', () => {
    const reason = 'api_key=sk-proj-field-private; email=third-party@example.test';
    for (const { payload } of reasonProposals(reason)) {
      const row = presentedRow(payload);
      const learnerRow = proposalInboxRowForLearner(row);
      expect(JSON.stringify(learnerRow.payload)).not.toContain('sk-proj-field-private');
      expect(JSON.stringify(learnerRow.payload)).not.toContain('third-party@example.test');
      expect(learnerRow.target).toEqual(row.target);
      expect(learnerRow.status).toBe('stale');
      expect(learnerRow.proposed_at.toISOString()).toBe('2026-10-11T00:00:00.000Z');
      expect(learnerRow.decided_at?.toISOString()).toBe('2026-10-11T00:01:00.000Z');
      expect(learnerRow.payload.evidence_refs).toEqual([
        { kind: 'event', id: 'original-evidence' },
      ]);
      expect(JSON.stringify(row.payload)).toContain(reason);
    }
  });

  // @invariant security: inline technical reason dumps cannot bypass the same public display boundary that withholds line-leading dumps
  // @fails-if assignment detection is line-leading only or treats ordinary mathematical spans as technical dumps
  it('withholds inline technical dumps and preserves ordinary prose and formulas', () => {
    const reason = '根据记录，attempt_count_30d=2，建议先核验。';
    for (const { label, payload } of reasonProposals(reason)) {
      const learnerRow = proposalInboxRowForLearner(presentedRow(payload));
      expect(JSON.stringify(learnerRow)).not.toContain('attempt_count_30d');
      expect(
        learnerRow.presentation?.change_summary.find((item) => item.label === label)?.value,
      ).toBe('这条提议暂无可读的依据说明，请核实后再决定是否采纳。');
    }
    const safeReasons = [
      '先比较 y = mx + b，再核对 $x_i=1$ 与 $theta_hat=0.25$。',
      '核对 \\(theta_hat=0.25\\) 后再计算 \\[long_variable=1\\]。',
      '请先检查这次作答的内层导数，再决定是否调整安排。',
    ];
    for (const safe of safeReasons) {
      for (const { label, payload } of reasonProposals(safe)) {
        const learnerRow = proposalInboxRowForLearner(presentedRow(payload));
        expect(
          learnerRow.presentation?.change_summary.find((item) => item.label === label)?.value,
        ).toBe(safe);
        expect(JSON.stringify(learnerRow.payload)).toContain(safe.replaceAll('\\', '\\\\'));
      }
    }
  });

  // @invariant security: both actual teaching-brief reason projections must withhold private reasons before all three basis summary projections
  // @fails-if either facts source passes through raw reason_md; the executed source expressions serialize credentials into summary_md
  it('withholds private teaching-brief reason sources through each real summary projection', () => {
    const privateReason =
      '依据 recent_failure_count_30d=2; api_key=sk-ant-brief-private; email=third-party@example.test';
    for (const reason of [
      privateReason,
      'recent_failure_count_30d=1',
      '核对 $theta_hat=0.25$ 后再验证。',
    ]) {
      for (const producer of ['factsFromProposalRow', 'factsFromRawProposalRow']) {
        const reasonMd = teachingBriefProjection(producer, ['reasonMd'], {
          row: { payload: { reason_md: reason } },
          payload: { reason_md: reason },
        });
        for (const consumer of ['loadOutcomeBrief', 'loadProbeBrief', 'loadFindingBrief']) {
          const summaryMd = teachingBriefProjection(consumer, ['basis', 'summary_md'], {
            proposal: { reasonMd },
          });
          expect(summaryMd).not.toContain('sk-ant-brief-private');
          expect(summaryMd).not.toContain('third-party@example.test');
          expect(summaryMd).not.toContain('recent_failure_count_30d');
          if (reason === privateReason) {
            expect(summaryMd).toBe('这条提议暂无可读的依据说明，请核实后再决定是否采纳。');
          } else if (reason === 'recent_failure_count_30d=1') {
            expect(summaryMd).toBe('提议引用的统计中，最近 30 天有 1 条失败作答记录。');
          } else {
            expect(summaryMd).toBe(reason);
          }
        }
      }
    }
  });
});
