/**
 * One-time stock repair: retire question-level FSRS cards whose question now
 * carries a testable knowledge component that already has its knowledge card.
 * Goal, container, seed-root, and not-yet-enrolled KC labels do not count. Not a migration, and CI does not run it.
 *
 * Default is a dry run. Pass --apply to write.
 *
 * Usage: pnpm ops:retire-labeled-question-cards [--apply]
 */
import './load-env';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { material_fsrs_state, question } from '@/db/schema';
import { scheduledTestableKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import { retireQuestionFsrsState } from '@/kernel/records/scheduling-state';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (apply && process.argv.includes('--dry-run')) {
    console.error('pass either --apply or --dry-run, not both');
    process.exitCode = 1;
    return;
  }
  const rows = await db
    .select({
      questionId: material_fsrs_state.subject_id,
      knowledgeIds: question.knowledge_ids,
    })
    .from(material_fsrs_state)
    .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
    .where(eq(material_fsrs_state.subject_kind, 'question'))
    .orderBy(material_fsrs_state.subject_id);
  const testable = new Set(
    await scheduledTestableKnowledgeIds(
      db,
      rows.flatMap((row) => row.knowledgeIds ?? []),
    ),
  );
  const questionIds = rows
    .filter((row) => (row.knowledgeIds ?? []).some((id) => testable.has(id)))
    .map((row) => row.questionId);
  let retired = 0;
  if (apply) {
    await db.transaction(async (tx) => {
      for (const questionId of questionIds) {
        if (await retireQuestionFsrsState(tx, questionId)) retired += 1;
      }
    });
  }
  console.log(
    JSON.stringify(
      {
        operation: 'retire_labeled_question_cards',
        dry_run: !apply,
        matched: questionIds.length,
        retired: apply ? retired : 0,
        would_retire: apply ? 0 : questionIds.length,
        question_ids: questionIds,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
