// P5.4 / YUK-143 — DB-partition coverage for validateProposalQuality.
// One test per gate class (agent rejections), the user-edited structural-only
// branch (RB-3), the §4.2 evidence window (RB-5), and the §4.3 relation
// predicates. Imports tests/helpers/db → DB partition (not in fastTestInclude).

import type { AiProposalPayloadT } from '@/core/schema/proposal';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import { knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  RUBRIC_EVIDENCE_WINDOW_DAYS,
  type RubricGate,
  validateProposalQuality,
} from './rubric-validator';

const DAY_MS = 24 * 60 * 60 * 1000;

function edgePayload(
  fromId: string,
  toId: string,
  relation: string,
  opts: { reasoning?: string; evidenceEventIds?: string[] } = {},
): AiProposalPayloadT {
  return parseAiProposalPayload({
    kind: 'knowledge_edge',
    target: { subject_kind: 'knowledge_edge', subject_id: null },
    reason_md:
      opts.reasoning ?? 'attempt e_concrete 显示用户在 k_zhi 上反复失败，judge cause 为 concept。',
    evidence_refs: (opts.evidenceEventIds ?? []).map((id) => ({ kind: 'event', id })),
    proposed_change: {
      from_knowledge_id: fromId,
      to_knowledge_id: toId,
      relation_type: relation,
      weight: 1,
    },
  });
}

async function seedGraph(): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values([
      { id: 'k_wenyan', name: '文言文', domain: 'wenyan', created_at: now, updated_at: now },
      {
        id: 'k_zhi',
        name: '之的用法',
        domain: null,
        parent_id: 'k_wenyan',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'k_er',
        name: '而的用法',
        domain: null,
        parent_id: 'k_wenyan',
        created_at: now,
        updated_at: now,
      },
      { id: 'k_math', name: '数学', domain: 'math', created_at: now, updated_at: now },
    ]);
}

// A recent judge-backed failure referencing the given knowledge ids.
async function seedEvidence(
  attemptId: string,
  knowledgeIds: string[],
  ageDays: number,
): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    knowledge_ids: knowledgeIds,
    source: 'manual',
    difficulty: 3,
    created_at: createdAt,
    updated_at: createdAt,
  });
  await writeEvent(db, {
    id: attemptId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: knowledgeIds,
    },
    created_at: createdAt,
  });
  await writeEvent(db, {
    id: `judge_${attemptId}`,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '用户混淆两个用法。',
        confidence: 0.9,
      },
      referenced_knowledge_ids: knowledgeIds,
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
}

const AGENT = { isAgent: true, actorRef: 'agent:maintenance' };

describe('validateProposalQuality — structural class (G1–G6)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('G1 self_edge', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_zhi', 'related_to'),
      testDb(),
      AGENT,
    );
    expect(v).toEqual({ ok: false, gate: 'self_edge', reason: expect.any(String) });
  });

  it('G2 unknown_node (missing endpoint)', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_ghost', 'related_to'),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('unknown_node');
  });

  it('G3 cross_subject', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_math', 'related_to'),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('cross_subject');
  });

  it('G6 parent_semantic_duplicate (restates tree ancestry)', async () => {
    // k_zhi.parent_id === k_wenyan → an edge between them only restates the tree.
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_wenyan', 'related_to', {
        evidenceEventIds: ['e_dup'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('parent_semantic_duplicate');
  });
});

describe('validateProposalQuality — reasoning + evidence floor (G7, §4.2)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('G7a reasoning_generic — generic reason with no concrete signal', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: '二者相关',
        evidenceEventIds: ['e1'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('reasoning_generic');
  });

  it('evidence_missing — agent edge with no evidence_event_ids', async () => {
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_x 显示用户在 k_zhi 上失败。',
        evidenceEventIds: [],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_missing');
  });

  it('evidence_level — single in-window judge-backed event is only medium', async () => {
    await seedEvidence('e_solo', ['k_zhi', 'k_er'], 1);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_solo judge cause concept。',
        evidenceEventIds: ['e_solo'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.gate).toBe('evidence_level');
  });

  it('evidence window — event at WINDOW+1d is rejected, 1d-inside passes', async () => {
    // Two strong (≥2) events but both just outside the window → weak → reject.
    await seedEvidence('e_old_1', ['k_zhi', 'k_er'], RUBRIC_EVIDENCE_WINDOW_DAYS + 1);
    await seedEvidence('e_old_2', ['k_zhi', 'k_er'], RUBRIC_EVIDENCE_WINDOW_DAYS + 2);
    const rejected = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_old judge cause concept。',
        evidenceEventIds: ['e_old_1', 'e_old_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.gate).toBe('evidence_level');

    // Two events 1 day inside the window → strong → passes the floor.
    await seedEvidence('e_new_1', ['k_zhi', 'k_er'], 1);
    await seedEvidence('e_new_2', ['k_zhi', 'k_er'], 2);
    const passes = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'related_to', {
        reasoning: 'attempt e_new judge cause concept，用户在 k_zhi/k_er 上反复失败。',
        evidenceEventIds: ['e_new_1', 'e_new_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(passes).toEqual({ ok: true });
  });
});

describe('validateProposalQuality — relation predicates (§4.3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('contrasts_with_no_confusion — strong evidence but no failure references both endpoints', async () => {
    // Two strong events, but each references only k_zhi (not both) → confusion
    // predicate fails even though the evidence floor passes.
    await seedEvidence('e_one_1', ['k_zhi'], 1);
    await seedEvidence('e_one_2', ['k_zhi'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'contrasts_with', {
        reasoning: 'attempt e_one judge cause concept on k_zhi。',
        evidenceEventIds: ['e_one_1', 'e_one_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    // prerequisite/contrasts_with require 2 events; both reference an endpoint,
    // so the floor passes, and the confusion predicate (references BOTH) fails.
    if (!v.ok) expect(v.gate).toBe('contrasts_with_no_confusion');
  });

  it('prerequisite_no_order_evidence — no in-window judge-backed failure references an endpoint', async () => {
    // Strong evidence that references unrelated nodes only → no order evidence.
    await testDb()
      .insert(knowledge)
      .values([
        {
          id: 'k_other',
          name: '其它',
          domain: null,
          parent_id: 'k_wenyan',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    await seedEvidence('e_unrel_1', ['k_other'], 1);
    await seedEvidence('e_unrel_2', ['k_other'], 2);
    const v = await validateProposalQuality(
      edgePayload('k_zhi', 'k_er', 'prerequisite', {
        reasoning: 'attempt e_unrel judge cause concept。',
        evidenceEventIds: ['e_unrel_1', 'e_unrel_2'],
      }),
      testDb(),
      AGENT,
    );
    expect(v.ok).toBe(false);
    // 2 in-window judge-backed events exist (floor ok), but none reference an
    // endpoint → order-evidence predicate fails.
    if (!v.ok) expect(v.gate).toBe('prerequisite_no_order_evidence');
  });
});

describe('validateProposalQuality — agent vs user (RB-3)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedGraph();
  });

  it('user-edited proposal passes structural-only; same proposal fails as agent', async () => {
    // An evidence-free related_to edge between two same-subject, non-ancestor
    // nodes: structurally valid (G1–G6) but fails the agent evidence floor.
    const payload = edgePayload('k_zhi', 'k_er', 'related_to', {
      reasoning: '二者相关', // generic, but user path skips reasoning-depth too
      evidenceEventIds: [],
    });

    const asUser = await validateProposalQuality(payload, testDb(), {
      isAgent: false,
      actorRef: 'user:self',
    });
    expect(asUser).toEqual({ ok: true });

    const asAgent = await validateProposalQuality(payload, testDb(), AGENT);
    expect(asAgent.ok).toBe(false);
  });
});

describe('RubricGate type is referenced', () => {
  it('compiles a gate assignment', () => {
    const g: RubricGate = 'evidence_level';
    expect(g).toBe('evidence_level');
  });
});
