// YUK-280 P4 (YUK-203) — listQuestions DB integration test.
//
// Covers A1a SQL axes + draft exclusion + pagination, A1b in-memory grounding
// tier filter/sort (NO SQL source_tier), and A1c variant families.

import { newId } from '@/core/ids';
import { knowledge, question } from '@/db/schema';
import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
import { listQuestions } from '@/server/questions/list';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

async function seedKnowledge(
  id: string,
  opts: { domain?: string | null; parent_id?: string | null } = {},
): Promise<string> {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `node ${id}`,
      domain: opts.domain ?? null,
      parent_id: opts.parent_id ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    });
  return id;
}

interface SeedQuestionOpts {
  id?: string;
  kind?: string;
  prompt_md?: string;
  source?: string;
  difficulty?: number;
  visual_complexity?: string | null;
  knowledge_ids?: string[];
  draft_status?: string | null;
  variant_depth?: number;
  root_question_id?: string | null;
  parent_question_id?: string | null;
  part_index?: number | null;
  metadata?: Record<string, unknown> | null;
  created_at?: Date;
}

async function seedQuestion(opts: SeedQuestionOpts = {}): Promise<string> {
  const id = opts.id ?? newId();
  const now = opts.created_at ?? new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: opts.kind ?? 'reading',
      prompt_md: opts.prompt_md ?? 'prompt',
      reference_md: null,
      knowledge_ids: opts.knowledge_ids ?? [],
      difficulty: opts.difficulty ?? 3,
      source: opts.source ?? 'manual',
      visual_complexity: opts.visual_complexity ?? null,
      draft_status: opts.draft_status ?? null,
      variant_depth: opts.variant_depth ?? 0,
      root_question_id: opts.root_question_id ?? null,
      parent_question_id: opts.parent_question_id ?? null,
      part_index: opts.part_index ?? null,
      metadata: (opts.metadata ?? null) as never,
      created_at: now,
      updated_at: now,
    });
  return id;
}

// tier-2 web_sourced metadata fixture (matches WebSourcedProvenance + 合约三).
function webSourcedMeta(whitelistMatch: boolean): Record<string, unknown> {
  return {
    source_ref_kind: 'url',
    web_sourced: {
      url: 'https://example.edu/q',
      title: 'sourced q',
      fetched_at: '2026-06-01T00:00:00Z',
      whitelist_match: whitelistMatch,
      extract: 'the extracted source text overlapping the prompt',
    },
  };
}

const DAY = 86_400_000;

describe('listQuestions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe('A1a SQL axes', () => {
    it('filters by single axes and combined axes (intersection)', async () => {
      const k1 = newId();
      const k2 = newId();
      const target = await seedQuestion({
        kind: 'reading',
        source: 'manual',
        difficulty: 4,
        knowledge_ids: [k1],
      });
      // distractors that miss one axis each
      await seedQuestion({
        kind: 'computation',
        source: 'manual',
        difficulty: 4,
        knowledge_ids: [k1],
      });
      await seedQuestion({
        kind: 'reading',
        source: 'web_sourced',
        difficulty: 4,
        knowledge_ids: [k1],
      });
      await seedQuestion({ kind: 'reading', source: 'manual', difficulty: 2, knowledge_ids: [k1] });
      await seedQuestion({ kind: 'reading', source: 'manual', difficulty: 4, knowledge_ids: [k2] });

      const bySource = await listQuestions(testDb(), {
        source: 'web_sourced',
        limit: 50,
        offset: 0,
      });
      expect(bySource.total).toBe(1);

      const combined = await listQuestions(testDb(), {
        knowledgeIds: [k1],
        source: 'manual',
        kind: 'reading',
        difficulty: 4,
        limit: 50,
        offset: 0,
      });
      expect(combined.total).toBe(1);
      expect(combined.items[0].id).toBe(target);
    });

    it('matches any of multiple knowledge_ids (OR containment)', async () => {
      const k1 = newId();
      const k2 = newId();
      const a = await seedQuestion({ knowledge_ids: [k1] });
      const b = await seedQuestion({ knowledge_ids: [k2] });
      await seedQuestion({ knowledge_ids: [newId()] });

      const res = await listQuestions(testDb(), { knowledgeIds: [k1, k2], limit: 50, offset: 0 });
      expect(res.total).toBe(2);
      expect(new Set(res.items.map((i) => i.id))).toEqual(new Set([a, b]));
    });

    it('kind axis matches subject-vocabulary rows via canonical normalisation (YUK-288)', async () => {
      // Seed/fixture write paths persist profile vocabulary (single_choice /
      // reading_comprehension / calculation), NOT canonical, violating the
      // business.ts canonical-is-truth invariant. The UI filter sends canonical
      // (choice / reading / computation). An exact eq(kind, 'choice') matched zero
      // single_choice rows — the empty-list bug. The reader now expands canonical
      // to all persisted forms (IN ...), so it hits both vocabularies.
      const canonicalChoice = await seedQuestion({ kind: 'choice' });
      const profileSingleChoice = await seedQuestion({ kind: 'single_choice' });
      const profileMultiChoice = await seedQuestion({ kind: 'multiple_choice' });
      // distractor of a different family must NOT match.
      await seedQuestion({ kind: 'reading' });

      const byChoice = await listQuestions(testDb(), { kind: 'choice', limit: 50, offset: 0 });
      expect(new Set(byChoice.items.map((i) => i.id))).toEqual(
        new Set([canonicalChoice, profileSingleChoice, profileMultiChoice]),
      );

      // computation ← calculation / word_problem (math/physics fixtures store these).
      const canonicalComp = await seedQuestion({ kind: 'computation' });
      const profileCalc = await seedQuestion({ kind: 'calculation' });
      const byComputation = await listQuestions(testDb(), {
        kind: 'computation',
        limit: 50,
        offset: 0,
      });
      expect(new Set(byComputation.items.map((i) => i.id))).toEqual(
        new Set([canonicalComp, profileCalc]),
      );

      // reading ← reading_comprehension (wenyan fixtures store reading_comprehension).
      const profileReadingComp = await seedQuestion({ kind: 'reading_comprehension' });
      const byReading = await listQuestions(testDb(), { kind: 'reading', limit: 50, offset: 0 });
      // the earlier canonical 'reading' distractor + the reading_comprehension row.
      expect(byReading.items.map((i) => i.id)).toContain(profileReadingComp);
      expect(
        byReading.items.every((i) => i.kind === 'reading' || i.kind === 'reading_comprehension'),
      ).toBe(true);
    });

    it('filters by visual_complexity only when provided (nullable axis)', async () => {
      await seedQuestion({ visual_complexity: 'high' });
      await seedQuestion({ visual_complexity: null });
      const all = await listQuestions(testDb(), { limit: 50, offset: 0 });
      expect(all.total).toBe(2);
      const high = await listQuestions(testDb(), {
        visualComplexity: 'high',
        limit: 50,
        offset: 0,
      });
      expect(high.total).toBe(1);
      expect(high.items[0].visual_complexity).toBe('high');
    });

    it('excludes drafts by default and includes them with includeDrafts', async () => {
      await seedQuestion({ draft_status: null });
      await seedQuestion({ draft_status: 'final' });
      await seedQuestion({ draft_status: 'draft' });

      const def = await listQuestions(testDb(), { limit: 50, offset: 0 });
      expect(def.total).toBe(2); // null + 'final', draft excluded

      const withDrafts = await listQuestions(testDb(), {
        includeDrafts: true,
        limit: 50,
        offset: 0,
      });
      expect(withDrafts.total).toBe(3);
    });

    it('paginates with limit/offset over a stable order and reports total', async () => {
      const base = new Date('2026-05-01T00:00:00Z').getTime();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(await seedQuestion({ created_at: new Date(base + i * DAY) }));
      }
      // newest-first default: ids[4], ids[3], ...
      const page1 = await listQuestions(testDb(), { limit: 2, offset: 0 });
      expect(page1.total).toBe(5);
      expect(page1.items.map((i) => i.id)).toEqual([ids[4], ids[3]]);
      const page2 = await listQuestions(testDb(), { limit: 2, offset: 2 });
      expect(page2.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    });

    it('default path SQL-paginates newest-first (no in-memory ASC-cap truncation)', async () => {
      // P2 regression (codex-list-224-default-truncation): the plain default
      // created_at list must SQL ORDER BY created_at DESC + LIMIT/OFFSET, NOT
      // fetch the OOM-capped ASC candidate set and reverse it. Insert rows in a
      // non-chronological order so a fetch-ASC-then-reverse impl that pages over a
      // truncated prefix could not produce the true newest page. We assert the
      // newest page, an OFFSET page, accurate total, and truncated=false.
      const base = new Date('2026-05-01T00:00:00Z').getTime();
      // creation order: day 2, day 0, day 5, day 1, day 4, day 3 (shuffled).
      const order = [2, 0, 5, 1, 4, 3];
      const byDay = new Map<number, string>();
      for (const day of order) {
        byDay.set(day, await seedQuestion({ created_at: new Date(base + day * DAY) }));
      }

      const page1 = await listQuestions(testDb(), { limit: 2, offset: 0 });
      expect(page1.total).toBe(6);
      expect(page1.truncated).toBe(false);
      // newest-first: day 5, day 4.
      expect(page1.items.map((i) => i.id)).toEqual([byDay.get(5), byDay.get(4)]);

      const page2 = await listQuestions(testDb(), { limit: 2, offset: 2 });
      // next window: day 3, day 2.
      expect(page2.items.map((i) => i.id)).toEqual([byDay.get(3), byDay.get(2)]);
    });

    it('returns empty items + total 0 for no matches', async () => {
      const res = await listQuestions(testDb(), { source: 'nope', limit: 50, offset: 0 });
      expect(res.total).toBe(0);
      expect(res.items).toEqual([]);
      expect(typeof res.computed_at_sec).toBe('number');
    });

    it('truncates prompt_md preview and exposes unix-second created_at', async () => {
      const longPrompt = 'x'.repeat(500);
      await seedQuestion({ prompt_md: longPrompt });
      const res = await listQuestions(testDb(), { limit: 50, offset: 0 });
      expect(res.items[0].prompt_md.endsWith('…')).toBe(true);
      expect(res.items[0].prompt_md.length).toBeLessThan(longPrompt.length);
      expect(Number.isInteger(res.items[0].created_at_sec)).toBe(true);
    });
  });

  describe('A1b grounding tier (in-memory derive, no SQL source_tier)', () => {
    async function seedFourTiers() {
      // tier 1 authentic — ingestion provenance marker.
      const t1 = await seedQuestion({
        source: 'vision_paper',
        metadata: { ingestion_session_id: 'sess_1' },
        created_at: new Date('2026-05-01T00:00:00Z'),
      });
      // tier 2 sourced — web_sourced + source_ref_kind url. Two whitelist variants.
      const t2true = await seedQuestion({
        source: 'web_sourced',
        metadata: webSourcedMeta(true),
        created_at: new Date('2026-05-02T00:00:00Z'),
      });
      const t2false = await seedQuestion({
        source: 'web_sourced',
        metadata: webSourcedMeta(false),
        created_at: new Date('2026-05-03T00:00:00Z'),
      });
      // tier 3 material — quiz_gen material_grounded.
      const t3 = await seedQuestion({
        source: 'quiz_gen',
        metadata: {
          quiz_gen: {
            generation_method: 'material_grounded',
            material_source_document_id: 'doc_1',
          },
        },
        created_at: new Date('2026-05-04T00:00:00Z'),
      });
      // tier 4 generated — plain manual.
      const t4 = await seedQuestion({
        source: 'manual',
        metadata: null,
        created_at: new Date('2026-05-05T00:00:00Z'),
      });
      return { t1, t2true, t2false, t3, t4 };
    }

    it('tags each item with derived source_tier {tier,name}', async () => {
      const { t1 } = await seedFourTiers();
      const res = await listQuestions(testDb(), { limit: 50, offset: 0 });
      const byId = new Map(res.items.map((i) => [i.id, i]));
      expect(byId.get(t1)?.source_tier).toEqual({ tier: 1, name: 'authentic' });
    });

    it('filters by sourceTier (in-memory, no SQL column error)', async () => {
      const { t2true, t2false } = await seedFourTiers();
      const res = await listQuestions(testDb(), { sourceTier: [2], limit: 50, offset: 0 });
      expect(res.total).toBe(2);
      expect(new Set(res.items.map((i) => i.id))).toEqual(new Set([t2true, t2false]));
      for (const item of res.items) expect(item.source_tier.tier).toBe(2);
    });

    it('sorts by source_tier 1→4 with OF-2 within-tier demotion', async () => {
      const { t1, t2true, t2false, t3, t4 } = await seedFourTiers();
      const res = await listQuestions(testDb(), {
        sortBy: 'source_tier',
        limit: 50,
        offset: 0,
      });
      const order = res.items.map((i) => i.id);
      // tier ascending; within tier 2, whitelist=false (t2false) sorts after true.
      expect(order).toEqual([t1, t2true, t2false, t3, t4]);
    });
  });

  describe('A1c variant families', () => {
    async function seedFamily() {
      const root = await seedQuestion({
        prompt_md: 'root prompt',
        variant_depth: 0,
        root_question_id: null,
        created_at: new Date('2026-05-01T00:00:00Z'),
      });
      const v1 = await seedQuestion({
        variant_depth: 1,
        root_question_id: root,
        created_at: new Date('2026-05-02T00:00:00Z'),
      });
      const v2 = await seedQuestion({
        variant_depth: 2,
        root_question_id: root,
        created_at: new Date('2026-05-03T00:00:00Z'),
      });
      const lone = await seedQuestion({
        variant_depth: 0,
        root_question_id: null,
        created_at: new Date('2026-05-04T00:00:00Z'),
      });
      return { root, v1, v2, lone };
    }

    it('aggregates by family with counts and root representative', async () => {
      const { root, v1, v2, lone } = await seedFamily();
      const res = await listQuestions(testDb(), { groupByFamily: true, limit: 50, offset: 0 });
      expect(res.families).not.toBeNull();
      expect(res.total).toBe(2); // root family + lone family

      const families = res.families ?? [];
      const rootFamily = families.find((f) => f.root_question_id === root);
      expect(rootFamily?.variant_count).toBe(3);
      expect(rootFamily?.max_variant_depth).toBe(2);
      expect(rootFamily?.representative.id).toBe(root);
      expect(new Set(rootFamily?.member_ids)).toEqual(new Set([root, v1, v2]));

      const loneFamily = families.find((f) => f.root_question_id === lone);
      expect(loneFamily?.variant_count).toBe(1);
    });

    it('expands one root family ordered by variant_depth', async () => {
      const { root, v1, v2 } = await seedFamily();
      const res = await listQuestions(testDb(), { expandRoot: root, limit: 50, offset: 0 });
      expect(res.families).toBeNull();
      expect(res.items.map((i) => i.id)).toEqual([root, v1, v2]);
    });
  });

  describe('YUK-288 gap A — composite part rows excluded from top-level list', () => {
    it('excludes kind=question_part rows (parent_question_id set) from the list', async () => {
      const parent = await seedQuestion({ kind: 'reading' });
      // two parts under the parent — must NOT appear as standalone list rows.
      await seedQuestion({
        kind: 'question_part',
        parent_question_id: parent,
        part_index: 0,
      });
      await seedQuestion({
        kind: 'question_part',
        parent_question_id: parent,
        part_index: 1,
      });

      const res = await listQuestions(testDb(), { limit: 50, offset: 0 });
      expect(res.total).toBe(1);
      expect(res.items.map((i) => i.id)).toEqual([parent]);
      // the surfaced row is a top-level parent (null linkage).
      expect(res.items[0].parent_question_id).toBeNull();
      expect(res.items[0].part_index).toBeNull();
    });
  });

  describe('YUK-288 gap B — subject 派生轴 (knowledge effective-domain join)', () => {
    it('filters to questions whose knowledge resolves to the subject', async () => {
      // wenyan root + a child that inherits the domain; a math root in another subject.
      const wenyanRoot = await seedKnowledge(newId(), { domain: 'wenyan' });
      const wenyanChild = await seedKnowledge(newId(), { parent_id: wenyanRoot });
      const mathRoot = await seedKnowledge(newId(), { domain: 'math' });

      const qWenyanDirect = await seedQuestion({ knowledge_ids: [wenyanRoot] });
      const qWenyanInherited = await seedQuestion({ knowledge_ids: [wenyanChild] });
      const qMath = await seedQuestion({ knowledge_ids: [mathRoot] });

      const wenyanIds = await resolveSubjectKnowledgeIds(testDb(), 'wenyan');
      // both the wenyan root and its (domain-inheriting) child resolve to wenyan.
      expect(new Set(wenyanIds)).toEqual(new Set([wenyanRoot, wenyanChild]));

      const res = await listQuestions(testDb(), {
        subjectKnowledgeIds: wenyanIds,
        limit: 50,
        offset: 0,
      });
      expect(new Set(res.items.map((i) => i.id))).toEqual(
        new Set([qWenyanDirect, qWenyanInherited]),
      );
      expect(res.items.map((i) => i.id)).not.toContain(qMath);
    });

    it('does NOT sweep domainless or unknown-domain nodes into the default subject (YUK-288 over-match)', async () => {
      // The over-match: resolveSubjectProfile(null|unknown) falls back to the
      // DEFAULT profile (wenyan), so a node whose whole parent chain is untagged
      // OR whose domain is an unregistered string resolved to 'wenyan' and got
      // swept into ?subject=wenyan. resolveKnownSubjectId returns null for both,
      // so they match no subject.
      const wenyanRoot = await seedKnowledge(newId(), { domain: 'wenyan' });
      // a node with NO domain anywhere up its chain (root has null domain).
      const untaggedRoot = await seedKnowledge(newId(), { domain: null });
      const untaggedChild = await seedKnowledge(newId(), { parent_id: untaggedRoot });
      // a node whose domain is a non-null string the registry does not know.
      const unknownDomain = await seedKnowledge(newId(), { domain: 'chemistry' });
      // a node whose domain is a KNOWN alias of wenyan — must still match.
      const aliasNode = await seedKnowledge(newId(), { domain: 'classical_chinese' });

      const wenyanIds = await resolveSubjectKnowledgeIds(testDb(), 'wenyan');
      // genuinely-wenyan + its alias only; untagged / unknown excluded.
      expect(new Set(wenyanIds)).toEqual(new Set([wenyanRoot, aliasNode]));
      expect(wenyanIds).not.toContain(untaggedRoot);
      expect(wenyanIds).not.toContain(untaggedChild);
      expect(wenyanIds).not.toContain(unknownDomain);

      // and the questions on those untagged/unknown nodes are NOT in ?subject=wenyan.
      const qWenyan = await seedQuestion({ knowledge_ids: [wenyanRoot] });
      const qAlias = await seedQuestion({ knowledge_ids: [aliasNode] });
      await seedQuestion({ knowledge_ids: [untaggedChild] });
      await seedQuestion({ knowledge_ids: [unknownDomain] });

      const res = await listQuestions(testDb(), {
        subjectKnowledgeIds: await resolveSubjectKnowledgeIds(testDb(), 'wenyan'),
        limit: 50,
        offset: 0,
      });
      expect(new Set(res.items.map((i) => i.id))).toEqual(new Set([qWenyan, qAlias]));
    });

    it('returns empty when the subject set is empty (subject labels no questions)', async () => {
      await seedQuestion({ knowledge_ids: [newId()] });
      // empty subjectKnowledgeIds → forced empty, NOT an unfiltered list.
      const res = await listQuestions(testDb(), {
        subjectKnowledgeIds: [],
        limit: 50,
        offset: 0,
      });
      expect(res.total).toBe(0);
      expect(res.items).toEqual([]);
    });

    it('intersects the subject axis with an explicit knowledge axis', async () => {
      const wenyanA = await seedKnowledge(newId(), { domain: 'wenyan' });
      const wenyanB = await seedKnowledge(newId(), { domain: 'wenyan' });
      const qA = await seedQuestion({ knowledge_ids: [wenyanA] });
      await seedQuestion({ knowledge_ids: [wenyanB] });

      const wenyanIds = await resolveSubjectKnowledgeIds(testDb(), 'wenyan');
      const res = await listQuestions(testDb(), {
        subjectKnowledgeIds: wenyanIds,
        knowledgeIds: [wenyanA],
        limit: 50,
        offset: 0,
      });
      // subject = wenyan (both) ∩ explicit knowledge = wenyanA → only qA.
      expect(res.items.map((i) => i.id)).toEqual([qA]);
    });
  });
});
