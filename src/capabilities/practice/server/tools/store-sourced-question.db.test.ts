// YUK-986 (Supply-Agent/1) — store_sourced_question commit tool db 测试。
//
// 锁死 commit 权威边界（agent 永远不在正确性路径上）：
//   dead knowledge / foreign-host / exact-dup merge / KC-scoped near-dup / insert+verify 链。
// enqueueSourceVerify 注入 fake（不依赖真 pg-boss）；staged 资产用 memR2 + 真 source_asset。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import { event, knowledge, question } from '@/db/schema';
import { VERIFY_DISPATCH_INTENT_ACTION } from '@/server/boss/verify-dispatch-outbox';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { canonicalJyeooQuestionHash } from '../question-supply/jyeoo-candidates';
import {
  type StoreSourcedQuestionDeps,
  executeStoreSourcedQuestion,
} from './store-sourced-question';

const db = testDb();

beforeEach(() => resetDb());

const NOW = new Date('2026-09-01T00:00:00Z');

async function seedTree(): Promise<void> {
  await db.insert(knowledge).values([
    {
      id: 'math-root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-sets',
      name: '集合',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
    },
    {
      id: 'kc-dead',
      name: '已归档',
      domain: null,
      parent_id: 'math-root',
      created_at: NOW,
      updated_at: NOW,
      archived_at: NOW,
    },
  ]);
}

function sourced(overrides: Partial<SourcedQuestionT> = {}): SourcedQuestionT {
  return {
    kind: 'short_answer',
    prompt_md: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。',
    reference_md: '【答案】{2,3}\n【分析】交集。\n【解答】A∩B={2,3}。',
    difficulty: 3,
    source_url: 'https://www.jyeoo.com/math2/ques/detail/x-1',
    source_title: '2025 某校卷',
    knowledge_ids: [],
    extract: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。答案：{2,3}',
    ...overrides,
  } as SourcedQuestionT;
}

async function candidateOf(
  q: SourcedQuestionT,
  overrides: Record<string, unknown> = {},
): Promise<Parameters<typeof executeStoreSourcedQuestion>[1]['candidate']> {
  return {
    candidate_id: 'cand-test-1',
    question: q,
    extraction_hash: `sha256:${await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() })}`,
    knowledge_hints: ['集合'],
    source_id: 'jyeoo-1',
    figures: null,
    image_refs: null,
    structured: null,
    staged_asset_ids: [],
    ...overrides,
  } as Parameters<typeof executeStoreSourcedQuestion>[1]['candidate'];
}

function inputOf(
  candidate: Awaited<ReturnType<typeof candidateOf>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    candidate,
    knowledge_ids: ['kc-sets'],
    attribution_state: 'matched' as const,
    subject_id: 'math',
    ...overrides,
  };
}

function fakeEnqueue(captured: string[][]): StoreSourcedQuestionDeps {
  return {
    enqueueSourceVerify: async (ids) => {
      captured.push(ids);
    },
  };
}

describe('executeStoreSourcedQuestion — insert path', () => {
  it('inserts a draft with provenance, metadata extras, canonical hash, and verify chain', async () => {
    await seedTree();
    const dispatched: string[][] = [];
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced())),
      fakeEnqueue(dispatched),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;
    expect(output.verify_enqueued).toBe(true);
    expect(dispatched).toEqual([[output.question_id]]);

    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    expect(row?.draft_status).toBe('draft');
    expect(row?.source).toBe('web_sourced');
    expect(row?.knowledge_ids).toEqual(['kc-sets']);
    expect(row?.canonical_content_hash).toMatch(/^[0-9a-f]{64}$/);
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata.knowledge_hints).toEqual(['集合']);
    expect(metadata.attribution_state).toBe('matched');
    expect((metadata.jyeoo as { candidate_id?: string }).candidate_id).toBe('cand-test-1');
    // insertSourcedDraft 的 web_sourced provenance 不得被 extras 覆盖。
    expect(metadata.web_sourced).toBeTruthy();

    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, VERIFY_DISPATCH_INTENT_ACTION));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const canary = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:store_sourced_question'));
    expect(canary).toHaveLength(1);
  });

  it('coarse attribution is recorded verbatim', async () => {
    await seedTree();
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced()), {
        knowledge_ids: ['math-root'],
        attribution_state: 'coarse',
      }),
      fakeEnqueue([]),
    );
    expect(output.status).toBe('inserted');
    if (output.status !== 'inserted') return;
    const [row] = await db.select().from(question).where(eq(question.id, output.question_id));
    expect((row?.metadata as Record<string, unknown>).attribution_state).toBe('coarse');
    expect(row?.knowledge_ids).toEqual(['math-root']);
  });
});

describe('executeStoreSourcedQuestion — deterministic rejections', () => {
  it('rejects dead knowledge nodes before any insert', async () => {
    await seedTree();
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced()), { knowledge_ids: ['kc-sets', 'kc-dead'] }),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'dead_knowledge_node' });
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(0);
  });

  it('rejects foreign-host source_url (never trusts the caller)', async () => {
    await seedTree();
    const foreign = sourced({
      source_url: 'https://evil.example.com/x',
      extract: 'https://evil.example.com/x',
    });
    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(foreign)),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'foreign_host' });
  });

  it('merges exact duplicates into the existing row (KC union) without a new insert', async () => {
    await seedTree();
    const q = sourced();
    const hash = await canonicalJyeooQuestionHash(q, { images: [], attachedSources: new Set() });
    await db.insert(question).values({
      id: 'q-existing',
      kind: 'short_answer',
      prompt_md: q.prompt_md,
      reference_md: q.reference_md,
      knowledge_ids: ['math-root'],
      difficulty: 3,
      source: 'jyeoo',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: hash,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(q)),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'duplicate_exact' });
    if (output.status !== 'rejected') return;
    expect(output.existing_question_id).toBe('q-existing');
    const [existing] = await db.select().from(question).where(eq(question.id, 'q-existing'));
    expect(new Set(existing?.knowledge_ids)).toEqual(new Set(['math-root', 'kc-sets']));
    const all = await db.select().from(question);
    expect(all).toHaveLength(1);
  });

  it('rejects near-duplicates against the KC-scoped active+draft pool', async () => {
    await seedTree();
    await db.insert(question).values({
      id: 'q-near',
      kind: 'short_answer',
      prompt_md: '已知集合 A={1,2,3}，B={2,3,4}，求 A∩B。',
      reference_md: '【答案】{2,3}',
      knowledge_ids: ['kc-sets'],
      difficulty: 3,
      source: 'quiz_gen',
      metadata: null as never,
      draft_status: null,
      variant_depth: 0,
      canonical_content_hash: 'f'.repeat(64),
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

    const output = await executeStoreSourcedQuestion(
      { db, taskRunId: 'test-run' },
      inputOf(await candidateOf(sourced())),
      fakeEnqueue([]),
    );
    expect(output).toMatchObject({ status: 'rejected', reason: 'near_dup' });
    const all = await db.select().from(question);
    expect(all).toHaveLength(1);
  });
});
