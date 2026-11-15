// Producer-backed learning activity. Action names are subscription candidates;
// readers must also apply the actor, content and source-policy conditions below.

import { type SQL, and, eq, inArray, or, sql } from 'drizzle-orm';
import { PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { artifact, event, learning_record, question } from '@/db/schema';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';

export const LEARNER_ANSWER_ACTIONS = [
  'attempt',
  'review',
  'experimental:assessment_attempt',
] as const;

/** Candidate kinds only; use learningActivitySql() to establish activity. */
export const LEARNING_ACTIVITY_ACTIONS = [
  ...LEARNER_ANSWER_ACTIONS,
  'experimental:record_capture',
  COPILOT_USER_ASK_ACTION,
  'experimental:hint_request',
  PROBE_RESULT_ACTION,
  'experimental:body_blocks_edit',
] as const;

/** Qualifying learner interactions, including source consent and crisis filtering. */
export function learningActivitySql(): SQL {
  return and(
    eventAllowsDerivationSql(),
    // Settlement time is not the learner's action time, even on a user actor row.
    sql`coalesce(${event.payload}->>'generated_by', '')
      IN ('', 'ingestion_capture', 'user_retry', 'rescue')`,
    or(
      and(eq(event.actor_kind, 'user'), inArray(event.action, [...LEARNER_ANSWER_ACTIONS])),
      and(
        eq(event.action, 'experimental:record_capture'),
        eq(event.actor_kind, 'user'),
        eq(event.subject_kind, 'record'),
        sql`coalesce(${event.payload}->>'enroll_outcome', '') <> 'unanswered'`,
        // An imported question is material, even when enrollment stamps it as user.
        sql`EXISTS (SELECT 1 FROM ${learning_record}
          WHERE ${learning_record.id} = ${event.subject_id}
            AND ${learning_record.origin_event_id} = ${event.id}
            AND ${learning_record.source} = 'manual'
            AND ${learning_record.activity_kind} IN
              ('attempt', 'review', 'read', 'ask', 'annotate', 'conversation'))`,
      ),
      and(
        eq(event.action, COPILOT_USER_ASK_ACTION),
        eq(event.actor_kind, 'user'),
        eq(event.actor_ref, 'user:self'),
        sql`${event.payload}->>'surface' = 'copilot'`,
        sql`length(btrim(${event.payload}->>'user_message')) > 0`,
      ),
      and(
        eq(event.action, 'experimental:hint_request'),
        eq(event.actor_kind, 'user'),
        eq(event.actor_ref, 'self'),
        eq(event.subject_kind, 'question'),
        sql`jsonb_typeof(${event.payload}->'hint_index') = 'number'`,
      ),
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.actor_kind, 'system'),
        eq(event.actor_ref, 'mind_probe'),
        eq(event.subject_kind, 'question'),
        sql`(length(btrim(${event.payload}->>'answer_md')) > 0
          OR (jsonb_typeof(${event.payload}->'answer_image_refs') = 'array'
            AND ${event.payload}->'answer_image_refs' <> '[]'::jsonb))`,
      ),
      and(
        eq(event.action, 'experimental:body_blocks_edit'),
        eq(event.actor_kind, 'user'),
        eq(event.subject_kind, 'artifact'),
        sql`jsonb_typeof(${event.payload}->'body_blocks') = 'object'`,
        sql`EXISTS (SELECT 1 FROM ${artifact}
          WHERE ${artifact.id} = ${event.subject_id}
            AND ${artifact.type} IN ('note_atomic', 'note_hub', 'note_long'))`,
      ),
    ),
  )!;
}

/** Subject evidence for interactions whose payload does not repeat knowledge ids. */
export async function loadInteractionKnowledge(
  db: Db | Tx,
  rows: { id: string; action: string; subject_kind: string; subject_id: string }[],
): Promise<Map<string, string[]>> {
  const questionRows = rows.filter(
    (row) =>
      row.subject_kind === 'question' &&
      (row.action === 'experimental:hint_request' || row.action === PROBE_RESULT_ACTION),
  );
  const noteRows = rows.filter(
    (row) => row.subject_kind === 'artifact' && row.action === 'experimental:body_blocks_edit',
  );
  const out = new Map<string, string[]>();
  if (questionRows.length) {
    const found = await db
      .select({ id: question.id, knowledgeIds: question.knowledge_ids })
      .from(question)
      .where(inArray(question.id, [...new Set(questionRows.map((row) => row.subject_id))]));
    const byId = new Map(found.map((row) => [row.id, row.knowledgeIds]));
    for (const row of questionRows) out.set(row.id, byId.get(row.subject_id) ?? []);
  }
  if (noteRows.length) {
    const found = await db
      .select({ id: artifact.id, knowledgeIds: artifact.knowledge_ids })
      .from(artifact)
      .where(inArray(artifact.id, [...new Set(noteRows.map((row) => row.subject_id))]));
    const byId = new Map(found.map((row) => [row.id, row.knowledgeIds]));
    for (const row of noteRows) out.set(row.id, byId.get(row.subject_id) ?? []);
  }
  return out;
}
