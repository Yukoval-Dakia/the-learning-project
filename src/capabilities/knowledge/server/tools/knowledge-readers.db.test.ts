import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilities } from '@/capabilities';
import { buildCopilotToolResultSnapshot } from '@/capabilities/copilot/server/tool-result-snapshot';
import { knowledge, knowledge_edge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ToolContext } from '@/kernel/tools/types';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import {
  expandKnowledgeSubgraphTool,
  getSubjectGraphOverviewTool,
  queryKnowledgeTool,
} from './knowledge-readers';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_stat_signals',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function seedNode(id: string): Promise<void> {
  const now = new Date();
  await testDb().insert(knowledge).values({
    id,
    name: id,
    domain: 'math',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(id: string): Promise<void> {
  const now = new Date();
  await testDb().insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: id,
    reference_md: 'ref',
    source: 'manual',
    knowledge_ids: [],
    created_at: now,
    updated_at: now,
  });
}

describe('knowledge reader statistical signals', () => {
  beforeAll(async () => {
    await registerCapabilityTools(capabilities);
  });

  beforeEach(async () => {
    await resetDb();
  });

  // @invariant security: model knowledge reads carry effective causes, proposal evidence ids, and weakness beyond mastery, while the learner snapshot omits evidence ids and weakness counts
  // @fails-if a recent failure cause stays null, an edge with no proposal is reported as an empty evidence list, or repeated failures are not weak when mastery is unknown
  it('reports causes, edge evidence, and non-mastery weakness without filling unknown as zero', async () => {
    const db = testDb();
    await seedNode('k_weak');
    await seedNode('k_judge');
    await seedNode('k_cold');
    await seedQuestion('q_weak');
    await seedQuestion('q_judge');
    const now = Date.now();
    await writeEvent(db, {
      id: 'att_a',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_weak',
      outcome: 'failure',
      payload: {
        answer_md: 'first miss',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_weak'],
      },
      created_at: new Date(now - 2 * 86_400_000),
    });
    await writeEvent(db, {
      id: 'att_b',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_weak',
      outcome: 'failure',
      payload: {
        answer_md: 'second miss',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_weak'],
      },
      created_at: new Date(now - 86_400_000),
    });
    await writeEvent(db, {
      id: 'cause_b',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'att_b',
      outcome: 'success',
      payload: { primary_category: 'concept_gap', user_notes: null },
      caused_by_event_id: 'att_b',
      created_at: new Date(now - 86_400_000 + 1000),
    });
    await writeEvent(db, {
      id: 'cause_a',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: 'att_a',
      outcome: 'success',
      payload: { primary_category: 'concept_gap', user_notes: null },
      caused_by_event_id: 'att_a',
      created_at: new Date(now - 2 * 86_400_000 + 1000),
    });
    await writeEvent(db, {
      id: 'att_c',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_judge',
      outcome: 'failure',
      payload: {
        answer_md: 'judge only',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_judge'],
      },
      created_at: new Date(now - 3 * 86_400_000),
    });
    await writeEvent(db, {
      id: 'judge_c',
      actor_kind: 'agent',
      actor_ref: 'agent:attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'att_c',
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'calculation_slip',
          secondary_categories: [],
          analysis_md: 'arithmetic',
          confidence: 0.4,
        },
        referenced_knowledge_ids: ['k_judge'],
      },
      caused_by_event_id: 'att_c',
      created_at: new Date(now - 3 * 86_400_000 + 1000),
    });
    await db.insert(knowledge_edge).values([
      {
        id: 'e_known',
        from_knowledge_id: 'k_weak',
        to_knowledge_id: 'k_judge',
        relation_type: 'prerequisite',
        weight: 1,
        created_by: { by: 'user' },
        reasoning: null,
        created_at: new Date(now),
      },
      {
        id: 'e_plain',
        from_knowledge_id: 'k_judge',
        to_knowledge_id: 'k_cold',
        relation_type: 'related_to',
        weight: 1,
        created_by: { by: 'user' },
        reasoning: null,
        created_at: new Date(now),
      },
    ]);
    await writeEvent(db, {
      id: 'propose_edge',
      actor_kind: 'agent',
      actor_ref: 'agent:knowledge',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_known',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_weak',
        to_knowledge_id: 'k_judge',
        relation_type: 'prerequisite',
        weight: 1,
        reasoning: 'two misses share a prerequisite',
        ai_proposal: {
          evidence_refs: [
            { kind: 'event', id: 'att_a' },
            { kind: 'event', id: 'att_b' },
            { kind: 'question', id: 'q_weak' },
          ],
        },
      },
      created_at: new Date(now - 1000),
    });
    await writeEvent(db, {
      id: 'generate_edge',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_known',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k_weak',
        to_knowledge_id: 'k_judge',
        relation_type: 'prerequisite',
        weight: 1,
        reasoning: null,
        propose_event_id: 'propose_edge',
      },
      created_at: new Date(now),
    });

    const queried = await queryKnowledgeTool.execute(ctx(), {
      subjectId: 'math',
      include: ['recent_failures'],
    });
    const causes = new Map(queried.recent_failures?.map((row) => [row.event_id, row.cause]));
    expect(causes.get('att_b')).toMatchObject({
      value: 'concept_gap',
      known: true,
      source: 'user_cause.primary_category',
    });
    expect(causes.get('att_c')).toMatchObject({
      value: 'calculation_slip',
      known: true,
      source: 'judge.cause.primary_category',
    });
    expect(queried.edges.find((edge) => edge.id === 'e_known')?.evidence_event_ids).toMatchObject({
      known: true,
      value: ['att_a', 'att_b'],
    });
    expect(queried.edges.find((edge) => edge.id === 'e_plain')?.evidence_event_ids).toMatchObject({
      known: false,
      value: null,
      missingReason: 'no_generate_event',
    });

    const expanded = await expandKnowledgeSubgraphTool.execute(ctx(), {
      centerNodeId: 'k_weak',
      include: ['mastery'],
    });
    const weak = expanded.evidence.weak_points.find((point) => point.knowledge_id === 'k_weak');
    expect(weak?.readings.consecutive_errors).toMatchObject({ value: 2, known: true });
    expect(weak?.readings.cause_frequency.value).toEqual([{ cause: 'concept_gap', count: 2 }]);
    expect(weak?.readings.mastery).toMatchObject({ value: null, known: false });
    expect(weak?.readings.error_rate.value).toBeNull();
    expect(expanded.evidence.weak_points.map((point) => point.knowledge_id)).not.toContain(
      'k_judge',
    );

    const overview = await getSubjectGraphOverviewTool.execute(ctx(), {
      subjectId: 'math',
      includeWeaknessSummary: true,
    });
    expect(overview.clusters.find((cluster) => cluster.root_id === 'k_weak')?.weak_node_count).toBe(
      1,
    );
    expect(
      overview.clusters
        .filter((cluster) => cluster.root_id !== 'k_weak')
        .every((cluster) => cluster.weak_node_count === 0),
    ).toBe(true);

    const learnerView = buildCopilotToolResultSnapshot('query_knowledge', queried);
    const expandView = buildCopilotToolResultSnapshot('expand_knowledge_subgraph', expanded);
    expect(learnerView.state).toBe('available');
    expect(expandView.state).toBe('available');
    expect(hasKey(learnerView, 'evidence_event_ids')).toBe(false);
    expect(hasKey(expandView, 'readings')).toBe(false);
    expect(hasKey(expandView, 'consecutive_errors')).toBe(false);
    expect(queried.edges.some((edge) => edge.evidence_event_ids.known)).toBe(true);
  });
});

function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, key)) return true;
    return Object.values(record).some((child) => hasKey(child, key));
  }
  return false;
}
