import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { loadMathFixtures } from '@/subjects/math/fixtures';
/**
 * Dev / bootstrap endpoint — seed 10 math fixture questions for M0 e2e smoke.
 *
 * Idempotent: skips questions whose metadata.fixture_ref is already present.
 * Also ensures a single placeholder knowledge node 'k-math-seed-root' (math
 * domain) exists; M1+ replaces this with a real math knowledge graph.
 *
 * 调用：`curl -X POST -H "x-internal-token: $TOKEN" http://localhost:3000/api/_/seed/math`
 *
 * See: docs/superpowers/plans/2026-05-21-math-mvp-m-1-m0.md Task 12.
 */
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

const ROOT_KNOWLEDGE_ID = 'k-math-seed-root';

export async function POST(_req: Request): Promise<Response> {
  try {
    const fixtures = loadMathFixtures();
    const now = new Date();

    // Ensure root knowledge node exists (idempotent by id)
    const existingKnowledge = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(eq(knowledge.id, ROOT_KNOWLEDGE_ID));
    if (existingKnowledge.length === 0) {
      await db.insert(knowledge).values({
        id: ROOT_KNOWLEDGE_ID,
        name: '数学 seed root',
        domain: 'math',
        parent_id: null,
        archived_at: null,
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }

    // Idempotency: skip questions whose fixture_ref is already in metadata
    const existing = await db
      .select({ id: question.id, metadata: question.metadata })
      .from(question);
    const seenRefs = new Set<string>();
    for (const row of existing) {
      const ref = (row.metadata as { fixture_ref?: string } | null)?.fixture_ref;
      if (typeof ref === 'string') seenRefs.add(ref);
    }

    const created: string[] = [];
    const skipped: string[] = [];

    for (const item of fixtures) {
      if (seenRefs.has(item.ref)) {
        skipped.push(item.ref);
        continue;
      }
      const id = createId();
      await db.insert(question).values({
        id,
        kind: item.kind,
        prompt_md: item.prompt_md,
        reference_md: item.reference_md,
        choices_md: item.choices_md ?? null,
        rubric_json: item.rubric_json ?? null,
        knowledge_ids: [ROOT_KNOWLEDGE_ID],
        difficulty: item.difficulty,
        source: 'math_fixture',
        variant_depth: 0,
        figures: [],
        image_refs: [],
        structured: null,
        metadata: { fixture_ref: item.ref, knowledge_hint: item.knowledge_hint },
        created_at: now,
        updated_at: now,
        version: 0,
      });
      created.push(id);
    }

    return Response.json({ created, skipped, total: fixtures.length });
  } catch (err) {
    return errorResponse(err);
  }
}
