// Phase 2B — Learning Intent Orchestrator tests.

import { artifact, event, knowledge, learning_item } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { LearningIntentError, acceptLearningIntent, planLearningIntent } from './learning_intent';

async function seedKnowledge(
  rows: Array<{ id: string; name: string; parent_id?: string | null; domain?: string | null }>,
) {
  const db = testDb();
  const now = new Date();
  for (const r of rows) {
    await db.insert(knowledge).values({
      id: r.id,
      name: r.name,
      domain: r.domain ?? 'wenyan',
      parent_id: r.parent_id ?? null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

describe('planLearningIntent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('proposes a root + starter children when no knowledge node matches', async () => {
    const runTaskFn = vi.fn(async (_k: string, input: unknown, _c: unknown) => {
      expect((input as { plan_case?: string }).plan_case).toBe('3a_topic_missing');
      return {
        text: JSON.stringify({
          knowledge: {
            root: { temp_id: 'root', name: '概率论', domain: 'math' },
            children: [{ temp_id: 'conditional_probability', name: '条件概率', domain: 'math' }],
          },
          hub: { title: '概率论总览', summary_md: '概率论的基本对象与计算路径。' },
          atomics: [
            {
              knowledge_id: 'conditional_probability',
              title: '条件概率',
              one_line_intent: '能根据条件概率公式计算简单事件概率。',
            },
          ],
        }),
      };
    });

    const proposal = await planLearningIntent({ db: testDb(), topic: '概率论', runTaskFn });

    expect(proposal.plan_case).toBe('3a_topic_missing');
    expect(proposal.knowledge_node).toMatchObject({ id: 'root', name: '概率论', domain: 'math' });
    expect(proposal.proposed_knowledge?.root).toMatchObject({
      temp_id: 'root',
      name: '概率论',
      domain: 'math',
    });
    expect(proposal.proposed_knowledge?.children).toHaveLength(1);
    expect(proposal.atomics[0].knowledge_id).toBe('conditional_probability');
  });

  it('proposes child graph completion when the topic node has no children', async () => {
    await seedKnowledge([{ id: 'k_lonely', name: '一元二次方程', domain: 'math' }]);
    const runTaskFn = vi.fn(async (_k: string, input: unknown, _c: unknown) => {
      expect((input as { plan_case?: string }).plan_case).toBe('3b_children_missing');
      return {
        text: JSON.stringify({
          knowledge: {
            children: [{ temp_id: 'quadratic_formula', name: '公式法', domain: 'math' }],
          },
          hub: { title: '方程总览', summary_md: '一元二次方程的主要解法路径。' },
          atomics: [
            {
              knowledge_id: 'quadratic_formula',
              title: '公式法',
              one_line_intent: '能用求根公式解一元二次方程。',
            },
          ],
        }),
      };
    });

    const proposal = await planLearningIntent({ db: testDb(), topic: '一元二次方程', runTaskFn });

    expect(proposal.plan_case).toBe('3b_children_missing');
    expect(proposal.knowledge_node.id).toBe('k_lonely');
    expect(proposal.proposed_knowledge?.root).toBeUndefined();
    expect(proposal.proposed_knowledge?.children).toHaveLength(1);
    expect(proposal.atomics[0].knowledge_id).toBe('quadratic_formula');
  });

  it('returns proposal with hub + atomics when LLM responds correctly', async () => {
    await seedKnowledge([
      { id: 'k_hub', name: '虚词' },
      { id: 'k_zhi', name: '之', parent_id: 'k_hub' },
      { id: 'k_qi', name: '其', parent_id: 'k_hub' },
    ]);
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        hub: { title: '虚词总览', summary_md: '文言虚词的核心用法概览。' },
        atomics: [
          {
            knowledge_id: 'k_zhi',
            title: '之的用法',
            one_line_intent: '能区分「之」的助词、代词、动词三种用法。',
          },
          {
            knowledge_id: 'k_qi',
            title: '其的用法',
            one_line_intent: '能识别「其」的代词与语气词用法。',
          },
        ],
      }),
    }));

    const proposal = await planLearningIntent({ db: testDb(), topic: '虚词', runTaskFn });
    expect(proposal.plan_case).toBe('3c_existing_graph');
    expect(proposal.knowledge_node.id).toBe('k_hub');
    expect(proposal.atomics).toHaveLength(2);
    expect(proposal.atomics[0].knowledge_id).toBe('k_zhi');
    expect(proposal.proposal_id).toMatch(/.+/);

    const proposalEvent = (
      await testDb().select().from(event).where(eq(event.id, proposal.proposal_id))
    )[0];
    expect(proposalEvent.action).toBe('experimental:propose_learning_intent');
    expect((proposalEvent.payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'learning_item',
    );
  });

  it('passes the topic subject profile to LearningIntentOutlineTask', async () => {
    await seedKnowledge([
      { id: 'k_hub', name: '一元二次方程', domain: 'math' },
      { id: 'k_formula', name: '公式法', parent_id: 'k_hub', domain: 'math' },
    ]);
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        hub: { title: '方程总览', summary_md: '一元二次方程的解法概览。' },
        atomics: [
          {
            knowledge_id: 'k_formula',
            title: '公式法',
            one_line_intent: '能用求根公式解一元二次方程。',
          },
        ],
      }),
    }));

    await planLearningIntent({ db: testDb(), topic: '一元二次方程', runTaskFn });

    const ctx = runTaskFn.mock.calls[0]?.[2] as unknown as { subjectProfile?: { id: string } };
    expect(ctx.subjectProfile?.id).toBe('math');
  });

  it('rejects when LLM hallucinates a knowledge_id not in children', async () => {
    await seedKnowledge([
      { id: 'k_hub', name: '虚词' },
      { id: 'k_zhi', name: '之', parent_id: 'k_hub' },
    ]);
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        hub: { title: '虚词总览', summary_md: '...' },
        atomics: [
          {
            knowledge_id: 'k_fake',
            title: 'made up',
            one_line_intent: '...',
          },
        ],
      }),
    }));

    await expect(
      planLearningIntent({ db: testDb(), topic: '虚词', runTaskFn }),
    ).rejects.toMatchObject({ code: 'invalid_atomic_knowledge_id' });
  });

  it('rejects when LLM output cannot be parsed', async () => {
    await seedKnowledge([
      { id: 'k_hub', name: '虚词' },
      { id: 'k_zhi', name: '之', parent_id: 'k_hub' },
    ]);
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: 'not json',
    }));

    await expect(
      planLearningIntent({ db: testDb(), topic: '虚词', runTaskFn }),
    ).rejects.toMatchObject({ code: 'llm_parse_failed' });
  });

  it('matches topic via substring fallback', async () => {
    await seedKnowledge([
      { id: 'k_hub', name: '文言文虚词总览' },
      { id: 'k_zhi', name: '之', parent_id: 'k_hub' },
    ]);
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        hub: { title: 't', summary_md: 's' },
        atomics: [{ knowledge_id: 'k_zhi', title: 'a', one_line_intent: 'i' }],
      }),
    }));
    const proposal = await planLearningIntent({ db: testDb(), topic: '虚词', runTaskFn });
    expect(proposal.knowledge_node.id).toBe('k_hub');
  });
});

describe('acceptLearningIntent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function makeProposal() {
    await seedKnowledge([
      { id: 'k_hub', name: '虚词' },
      { id: 'k_zhi', name: '之', parent_id: 'k_hub' },
      { id: 'k_qi', name: '其', parent_id: 'k_hub' },
    ]);
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        hub: { title: '虚词总览', summary_md: '虚词概览。' },
        atomics: [
          { knowledge_id: 'k_zhi', title: '之', one_line_intent: '区分「之」用法' },
          { knowledge_id: 'k_qi', title: '其', one_line_intent: '区分「其」用法' },
        ],
      }),
    }));
    return planLearningIntent({ db: testDb(), topic: '虚词', runTaskFn });
  }

  it('creates 1 hub + N atomic LearningItems + paired artifact stubs', async () => {
    const db = testDb();
    const proposal = await makeProposal();
    const result = await acceptLearningIntent({ db, proposalId: proposal.proposal_id });

    expect(result.atomic_learning_item_ids).toHaveLength(2);
    expect(result.atomic_artifact_ids).toHaveLength(2);

    // Hub LearningItem
    const hubLi = (
      await db.select().from(learning_item).where(eq(learning_item.id, result.hub_learning_item_id))
    )[0];
    expect(hubLi.source).toBe('learning_intent');
    expect(hubLi.parent_learning_item_id).toBeNull();
    expect(hubLi.primary_artifact_id).toBe(result.hub_artifact_id);

    // Atomic LearningItems link to hub
    for (const atomicLiId of result.atomic_learning_item_ids) {
      const atomicLi = (
        await db.select().from(learning_item).where(eq(learning_item.id, atomicLiId))
      )[0];
      expect(atomicLi.parent_learning_item_id).toBe(result.hub_learning_item_id);
      expect(atomicLi.source).toBe('learning_intent');
    }

    // Hub artifact is ready (outline-only)
    const hubArt = (
      await db.select().from(artifact).where(eq(artifact.id, result.hub_artifact_id))
    )[0];
    expect(hubArt.type).toBe('note_hub');
    expect(hubArt.generation_status).toBe('ready');
    expect(hubArt.child_artifact_ids).toEqual(result.atomic_artifact_ids);

    // Atomic artifacts are pending
    for (const atomicArtifactId of result.atomic_artifact_ids) {
      const aArt = (await db.select().from(artifact).where(eq(artifact.id, atomicArtifactId)))[0];
      expect(aArt.type).toBe('note_atomic');
      expect(aArt.generation_status).toBe('pending');
      expect(aArt.parent_artifact_id).toBe(result.hub_artifact_id);
      expect(aArt.sections).toBeNull();
    }
  });

  it('throws proposal_already_rated on double accept', async () => {
    const db = testDb();
    const proposal = await makeProposal();
    await acceptLearningIntent({ db, proposalId: proposal.proposal_id });
    await expect(
      acceptLearningIntent({ db, proposalId: proposal.proposal_id }),
    ).rejects.toMatchObject({ code: 'proposal_already_rated' });
  });

  it('throws proposal_not_found for missing id', async () => {
    await expect(
      acceptLearningIntent({ db: testDb(), proposalId: 'nonexistent' }),
    ).rejects.toMatchObject({ code: 'proposal_not_found' });
  });

  it('accepts a 3a proposal by creating root and child knowledge before items', async () => {
    const db = testDb();
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        knowledge: {
          root: { temp_id: 'root', name: '概率论', domain: 'math' },
          children: [{ temp_id: 'conditional_probability', name: '条件概率', domain: 'math' }],
        },
        hub: { title: '概率论总览', summary_md: '概率论的基本对象与计算路径。' },
        atomics: [
          {
            knowledge_id: 'conditional_probability',
            title: '条件概率',
            one_line_intent: '能根据条件概率公式计算简单事件概率。',
          },
        ],
      }),
    }));
    const proposal = await planLearningIntent({ db, topic: '概率论', runTaskFn });

    const result = await acceptLearningIntent({ db, proposalId: proposal.proposal_id });

    const knowledgeRows = await db.select().from(knowledge);
    const root = knowledgeRows.find((row) => row.name === '概率论');
    expect(root).toBeTruthy();
    expect(root?.parent_id).toBeNull();
    expect(root?.domain).toBe('math');
    expect(root?.proposed_by_ai).toBe(true);

    const child = knowledgeRows.find((row) => row.name === '条件概率');
    expect(child).toBeTruthy();
    expect(child?.parent_id).toBe(root?.id);
    expect(child?.domain).toBe('math');
    expect(child?.proposed_by_ai).toBe(true);

    const hubLi = (
      await db.select().from(learning_item).where(eq(learning_item.id, result.hub_learning_item_id))
    )[0];
    expect(hubLi.knowledge_ids).toEqual([root?.id]);

    const atomicLi = (
      await db
        .select()
        .from(learning_item)
        .where(eq(learning_item.id, result.atomic_learning_item_ids[0]))
    )[0];
    expect(atomicLi.knowledge_ids).toEqual([child?.id]);

    const atomicArtifact = (
      await db.select().from(artifact).where(eq(artifact.id, result.atomic_artifact_ids[0]))
    )[0];
    expect(atomicArtifact.knowledge_id).toBe(child?.id);
  });

  it('accepts a 3b proposal by creating children under the existing topic', async () => {
    const db = testDb();
    await seedKnowledge([{ id: 'k_quad', name: '一元二次方程', domain: 'math' }]);
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        knowledge: {
          children: [{ temp_id: 'quadratic_formula', name: '公式法', domain: 'math' }],
        },
        hub: { title: '方程总览', summary_md: '一元二次方程的主要解法路径。' },
        atomics: [
          {
            knowledge_id: 'quadratic_formula',
            title: '公式法',
            one_line_intent: '能用求根公式解一元二次方程。',
          },
        ],
      }),
    }));
    const proposal = await planLearningIntent({ db, topic: '一元二次方程', runTaskFn });

    const result = await acceptLearningIntent({ db, proposalId: proposal.proposal_id });

    const child = (await db.select().from(knowledge)).find((row) => row.name === '公式法');
    expect(child).toBeTruthy();
    expect(child?.parent_id).toBe('k_quad');
    expect(child?.domain).toBe('math');
    expect(child?.proposed_by_ai).toBe(true);

    const atomicLi = (
      await db
        .select()
        .from(learning_item)
        .where(eq(learning_item.id, result.atomic_learning_item_ids[0]))
    )[0];
    expect(atomicLi.knowledge_ids).toEqual([child?.id]);
  });

  // suppress unused-import
  void LearningIntentError;
});
