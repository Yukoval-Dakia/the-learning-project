/**
 * Tests for runTaggingTask + buildTaggingGrid — T-OC slice 3 (YUK-145, OC-4).
 *
 * DB-backed (builds the candidate grid from the knowledge table) with an
 * injected runTaskFn so no real LLM is called. See ADR-0026.
 */
import type { TaggingInputT } from '@/core/schema/tagging';
import { beforeEach, describe, expect, it } from 'vitest';

import { knowledge, knowledge_edge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { TaggingTaskError, buildTaggingGrid, runTaggingTask } from './tagging';

async function seedKnowledge(db: ReturnType<typeof testDb>): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values([
    {
      id: 'k_root',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    },
    {
      id: 'k_zhi',
      name: '之-主谓间用法',
      domain: null,
      parent_id: 'k_root',
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    },
    {
      id: 'k_archived',
      name: '已归档',
      domain: 'wenyan',
      parent_id: null,
      archived_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    },
  ]);
  await db.insert(knowledge_edge).values({
    id: 'e1',
    from_knowledge_id: 'k_zhi',
    to_knowledge_id: 'k_root',
    relation_type: 'prerequisite',
    weight: 1,
    created_by: { by: 'user' },
    reasoning: null,
    created_at: now,
    archived_at: null,
  });
}

describe('buildTaggingGrid', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('includes active nodes with paths + mesh edges, excludes archived', async () => {
    const db = testDb();
    await seedKnowledge(db);
    const grid = await buildTaggingGrid(db, 'wenyan');
    const ids = grid.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['k_root', 'k_zhi']);
    expect(grid.nodes.find((n) => n.id === 'k_zhi')?.path).toEqual(['虚词', '之-主谓间用法']);
    expect(grid.edges).toHaveLength(1);
    expect(grid.edges[0]).toMatchObject({ from_knowledge_id: 'k_zhi', to_knowledge_id: 'k_root' });
  });
});

describe('runTaggingTask', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('happy path: returns validated suggestions for real grid ids', async () => {
    const db = testDb();
    await seedKnowledge(db);

    let captured: TaggingInputT | undefined;
    const result = await runTaggingTask({
      db,
      questionMd: '下列句中「之」的用法……',
      knowledgeHint: '之',
      subjectId: 'wenyan',
      runTaskFn: async (_kind, input) => {
        captured = input;
        return {
          text: JSON.stringify({
            suggestions: [{ knowledge_id: 'k_zhi', confidence: 0.92, reasoning: '考查之的用法' }],
            overall_confidence: 0.9,
            reasoning: 'ok',
          }),
        };
      },
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].knowledge_id).toBe('k_zhi');
    expect(result.overall_confidence).toBeCloseTo(0.9);
    // The grid the tagger saw was built from the DB.
    expect(captured?.grid.nodes.map((n) => n.id).sort()).toEqual(['k_root', 'k_zhi']);
    expect(captured?.knowledge_hint).toBe('之');
  });

  it('filters out hallucinated knowledge_ids not in the grid', async () => {
    const db = testDb();
    await seedKnowledge(db);

    const result = await runTaggingTask({
      db,
      questionMd: 'Q',
      knowledgeHint: null,
      subjectId: 'wenyan',
      runTaskFn: async () => ({
        text: JSON.stringify({
          suggestions: [
            { knowledge_id: 'k_zhi', confidence: 0.8, reasoning: 'real' },
            { knowledge_id: 'k_INVENTED', confidence: 0.99, reasoning: 'hallucinated' },
          ],
          overall_confidence: 0.85,
          reasoning: '',
        }),
      }),
    });

    expect(result.suggestions.map((s) => s.knowledge_id)).toEqual(['k_zhi']);
  });

  it('throws TaggingTaskError on unparseable LLM output', async () => {
    const db = testDb();
    await seedKnowledge(db);

    await expect(
      runTaggingTask({
        db,
        questionMd: 'Q',
        knowledgeHint: null,
        subjectId: 'wenyan',
        runTaskFn: async () => ({ text: 'not json at all' }),
      }),
    ).rejects.toBeInstanceOf(TaggingTaskError);
  });

  it('throws TaggingTaskError on schema-invalid output', async () => {
    const db = testDb();
    await seedKnowledge(db);

    await expect(
      runTaggingTask({
        db,
        questionMd: 'Q',
        knowledgeHint: null,
        subjectId: 'wenyan',
        // overall_confidence out of range → Zod reject.
        runTaskFn: async () => ({
          text: JSON.stringify({ suggestions: [], overall_confidence: 5, reasoning: '' }),
        }),
      }),
    ).rejects.toBeInstanceOf(TaggingTaskError);
  });

  it('wraps a provider exception as TaggingTaskError', async () => {
    const db = testDb();
    await seedKnowledge(db);

    await expect(
      runTaggingTask({
        db,
        questionMd: 'Q',
        knowledgeHint: null,
        subjectId: 'wenyan',
        runTaskFn: async () => {
          throw new Error('provider down');
        },
      }),
    ).rejects.toBeInstanceOf(TaggingTaskError);
  });
});
