import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { vector } from '../vector';

export const attempt_insight_vector = pgTable(
  'attempt_insight_vector',
  {
    insight_event_id: text('insight_event_id').notNull(),
    facet: text('facet').notNull(),
    attempt_event_id: text('attempt_event_id').notNull(),
    question_id: text('question_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    embedding: vector(1024).notNull(),
    embed_model: text('embed_model').notNull(),
    embed_version: integer('embed_version').notNull(),
    content_hash: text('content_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.insight_event_id, t.facet] }),
    check(
      'attempt_insight_vector_facet_check',
      sql`${t.facet} IN ('mechanism', 'method', 'needed_method')`,
    ),
  ],
);

/** Durable pre-send claims survive crashes; an unresolved claim never authorizes another paid send. */
export const backtrace_work = pgTable('backtrace_work', {
  id: text('id').primaryKey(),
  attempt_event_id: text('attempt_event_id').notNull(),
  stage: text('stage').notNull(),
  input_digest: text('input_digest').notNull(),
  state: text('state').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
