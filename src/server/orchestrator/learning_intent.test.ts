// Phase 2B — Learning Intent Orchestrator tests.

import { artifact, knowledge, learning_item } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { LearningIntentError, acceptLearningIntent, planLearningIntent } from './learning_intent';

async function seedKnowledge(rows: Array<{ id: string; name: string; parent_id?: string | null }>) {
  const db = testDb();
  const now = new Date();
  for (const r of rows) {
    await db.insert(knowledge).values({
      id: r.id,
      name: r.name,
      domain: 'wenyan',
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

  it('throws topic_not_found when no knowledge node matches', async () => {
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({ text: '{}' }));
    await expect(
      planLearningIntent({ db: testDb(), topic: '虚构主题', runTaskFn }),
    ).rejects.toMatchObject({ code: 'topic_not_found' });
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('throws topic_no_children when node has no children', async () => {
    await seedKnowledge([{ id: 'k_lonely', name: '孤立主题' }]);
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({ text: '{}' }));
    await expect(
      planLearningIntent({ db: testDb(), topic: '孤立主题', runTaskFn }),
    ).rejects.toMatchObject({ code: 'topic_no_children' });
    expect(runTaskFn).not.toHaveBeenCalled();
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
    expect(proposal.knowledge_node.id).toBe('k_hub');
    expect(proposal.atomics).toHaveLength(2);
    expect(proposal.atomics[0].knowledge_id).toBe('k_zhi');
    expect(proposal.proposal_id).toMatch(/.+/);

    const ctx = runTaskFn.mock.calls[0]?.[2] as { subjectProfile?: { id: string } };
    expect(ctx.subjectProfile?.id).toBe('wenyan');
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

  // suppress unused-import
  void LearningIntentError;
});
