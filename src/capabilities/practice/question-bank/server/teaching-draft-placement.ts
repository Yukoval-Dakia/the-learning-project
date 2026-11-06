import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, knowledge, learning_session, subject } from '@/db/schema';

interface PlacementInput {
  knowledge_ids: string[];
  subject_id?: string;
  learner_topic?: string;
}

type PlacementResult =
  | { ok: true; knowledge_ids: string[]; learner_topic?: string; placement_note?: string }
  | {
      ok: false;
      issue: { code: 'subject_root_missing' | 'learner_topic_required'; detail: string };
    };

const ROOT = /^seed:([^:]+):root$/;

/** Topic provenance stays outside the frozen question and scoring contract. */
export async function resolveTeachingDraftPlacement(
  db: Db,
  input: PlacementInput,
  origin: { sessionId?: string; causedByEventId?: string },
): Promise<PlacementResult> {
  const rootOnly =
    input.knowledge_ids.length > 0 && input.knowledge_ids.every((id) => ROOT.test(id));
  const fallback = input.knowledge_ids.length === 0 || rootOnly;
  if (!fallback) return { ok: true, knowledge_ids: input.knowledge_ids };
  const ids = new Set(input.knowledge_ids.map((id) => ROOT.exec(id)?.[1]));
  const subjectId = input.subject_id ?? (ids.size === 1 ? [...ids][0] : undefined);
  const [row] = subjectId
    ? await db
        .select({ id: subject.id, name: subject.display_name })
        .from(subject)
        .where(
          and(
            eq(subject.id, subjectId),
            isNull(subject.retired_at),
            eq(subject.is_selectable, true),
          ),
        )
        .limit(1)
    : [];
  const rootId = row ? `seed:${row.id}:root` : undefined;
  const [root] =
    rootId && row
      ? await db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(
            and(
              eq(knowledge.id, rootId),
              eq(knowledge.domain, row.id),
              isNull(knowledge.parent_id),
              isNull(knowledge.archived_at),
            ),
          )
          .limit(1)
      : [];
  if (!row || !root || (rootOnly && (ids.size !== 1 || !ids.has(row.id)))) {
    return {
      ok: false,
      issue: {
        code: 'subject_root_missing',
        detail: '这个学科目前还没有收进来，这次没有存题。可以只在对话里讲题，但不会进入题库。',
      },
    };
  }
  {
    const [ask] = origin.causedByEventId
      ? await db.select().from(event).where(eq(event.id, origin.causedByEventId)).limit(1)
      : [];
    const message = ask?.payload.user_message;
    if (
      !input.learner_topic ||
      !origin.sessionId ||
      ask?.session_id !== origin.sessionId ||
      ask.actor_kind !== 'user' ||
      ask.action !== 'experimental:copilot_user_ask' ||
      typeof message !== 'string' ||
      !message.includes(input.learner_topic)
    ) {
      return {
        ok: false,
        issue: {
          code: 'learner_topic_required',
          detail: '没有取得本轮请求中的主题原话，这次没有存题。',
        },
      };
    }
  }
  return {
    ok: true,
    knowledge_ids: [root.id],
    learner_topic: input.learner_topic,
    placement_note: `请求的主题还没有合适的知识节点，这道题先放在「${row.name}」下。`,
  };
}

/** Draft admission requires a real conversation, not an unbound publisher identity. */
export async function hasTeachingDraftConversation(db: Db, sessionId?: string): Promise<boolean> {
  if (!sessionId) return false;
  const [session] = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'conversation')))
    .limit(1);
  return session !== undefined;
}
