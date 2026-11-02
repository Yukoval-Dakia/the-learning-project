import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { QuestionBlockCreateExperimental } from '@/core/schema/event/question-block-events';
import {
  StructuredQuestion,
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { event, learning_session, question_block, source_document } from '@/db/schema';
import type { IngestionSessionTitleSource } from '../api/contracts';
import { readAgentRunItems } from './agent/history';

interface SessionTitle {
  title: string | null;
  title_source: IngestionSessionTitleSource | null;
}

/** Readability predicate only: selected text is returned verbatim, without a display codec. */
function readable(text: string | null | undefined): text is string {
  return text != null && text.trim().length > 0;
}

function hasQuestionText(question: StructuredQuestionT): boolean {
  if (question.role === 'stem' && question.sub_questions && question.sub_questions.length > 0) {
    return readable(question.prompt_text) || question.sub_questions.some(hasQuestionText);
  }
  return (
    readable(question.prompt_text) ||
    question.options?.some((option) => readable(option.text)) === true
  );
}

/**
 * Complete title read for an already-selected page (at most 100 sessions).
 * Both GETs use the same precedence and one consistent view of document,
 * execution owner, frozen snapshot/events and immutable block captures. No
 * full-history fanout, current question text, paid calculations or writes.
 */
export async function readSessionTitles(
  db: Db,
  sessionIds: readonly string[],
): Promise<Map<string, SessionTitle>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length > 100) throw new RangeError('A title read is limited to 100 sessions');
  if (ids.length === 0) return new Map();
  return db.transaction(
    async (tx) => {
      const titles = new Map<string, SessionTitle>(
        ids.map((id) => [id, { title: null, title_source: null }]),
      );
      const sessions = await tx
        .select({ id: learning_session.id, doc_title: source_document.title })
        .from(learning_session)
        .leftJoin(source_document, eq(learning_session.source_document_id, source_document.id))
        .where(and(eq(learning_session.type, 'ingestion'), inArray(learning_session.id, ids)));
      const missing: string[] = [];
      for (const session of sessions) {
        // Preserve the existing non-null document-title contract, including ''.
        if (session.doc_title != null) {
          titles.set(session.id, { title: session.doc_title, title_source: 'source_document' });
        } else {
          missing.push(session.id);
        }
      }
      const agentItems = await readAgentRunItems(tx, missing);
      const needsBlocks: string[] = [];
      for (const id of missing) {
        // Stable numeric order matches recording-title; ties keep first-seen
        // snapshot/event order, and same-id updates keep that original slot.
        const ordered = [...(agentItems.get(id) ?? [])].sort(
          (a, b) =>
            (Number.parseInt(a.question_no, 10) || 0) - (Number.parseInt(b.question_no, 10) || 0),
        );
        const preview = ordered.find((item) => readable(item.preview_md))?.preview_md;
        if (preview !== undefined) {
          titles.set(id, { title: preview, title_source: 'agent_item_preview' });
        } else {
          needsBlocks.push(id);
        }
      }
      if (needsBlocks.length === 0) return titles;

      // Actor-scoped drafts precede session-bound captures, independently of
      // agent history validity. Each leg retains its established stable order.
      const drafts = await tx
        .select({
          sid: question_block.ingestion_session_id,
          text: question_block.extracted_prompt_md,
        })
        .from(question_block)
        .where(
          inArray(
            question_block.ingestion_session_id,
            needsBlocks.map((id) => `draft:ingestion_agent:${id}`),
          ),
        )
        .orderBy(asc(question_block.created_at), asc(question_block.id));
      const blocks = await tx
        .select({
          id: question_block.id,
          sid: question_block.ingestion_session_id,
          text: question_block.extracted_prompt_md,
          capture: {
            actor_kind: event.actor_kind,
            actor_ref: event.actor_ref,
            action: event.action,
            subject_kind: event.subject_kind,
            subject_id: event.subject_id,
            outcome: event.outcome,
            payload: event.payload,
          },
        })
        .from(question_block)
        .leftJoin(
          event,
          and(
            eq(event.subject_kind, 'question_block'),
            eq(event.subject_id, question_block.id),
            eq(event.session_id, question_block.ingestion_session_id),
            eq(event.action, 'experimental:question_block_create'),
            eq(event.outcome, 'success'),
            sql`${event.payload}->>'origin' IN ('ocr', 'docx')`,
          ),
        )
        .where(inArray(question_block.ingestion_session_id, needsBlocks))
        .orderBy(
          asc(question_block.ordinal),
          asc(question_block.id),
          asc(event.created_at),
          asc(event.id),
        );
      for (const row of drafts) {
        const id = row.sid.slice('draft:ingestion_agent:'.length);
        if (titles.get(id)?.title_source == null && readable(row.text)) {
          titles.set(id, { title: row.text, title_source: 'extracted_prompt_md' });
        }
      }
      for (const row of blocks) {
        if (titles.get(row.sid)?.title_source == null && readable(row.text)) {
          titles.set(row.sid, { title: row.text, title_source: 'extracted_prompt_md' });
        }
      }
      // OCR/DOCX deliberately leave the deprecated text column NULL. Their
      // canonical create event freezes the original tree in the same INSERT
      // transaction. Never derive a title from today's mutable structured row,
      // a later rescue overwrite, or a genesis backfill of an unknown version.
      const seenBlocks = new Set<string>();
      for (const row of blocks) {
        if (seenBlocks.has(row.id)) continue;
        seenBlocks.add(row.id);
        if (titles.get(row.sid)?.title_source != null) continue;
        const capture = QuestionBlockCreateExperimental.safeParse(row.capture);
        if (!capture.success || capture.data.payload.row.ingestion_session_id !== row.sid) continue;
        const structured = StructuredQuestion.safeParse(capture.data.payload.row.structured);
        if (!structured.success || !hasQuestionText(structured.data)) continue;
        const preview = structuredToPromptMarkdown(structured.data);
        if (readable(preview)) {
          titles.set(row.sid, { title: preview, title_source: 'question_block_create' });
        }
      }
      return titles;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
