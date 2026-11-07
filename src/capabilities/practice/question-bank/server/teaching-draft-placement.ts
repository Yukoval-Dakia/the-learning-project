import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, knowledge, learning_session, subject } from '@/db/schema';
import { createSubjectThroughPort } from '@/kernel/subject-create';
import { learnerStatedSubject } from './learner-subject-claim';

interface PlacementInput {
  knowledge_ids: string[];
  subject_id?: string;
  learner_topic?: string;
}

interface PlacementSubject {
  id: string;
  /** True only when this placement created the subject; replay is false. */
  created: boolean;
}

type PlacementResult =
  | {
      ok: true;
      knowledge_ids: string[];
      learner_topic?: string;
      placement_note?: string;
      subject?: PlacementSubject;
    }
  | {
      ok: false;
      issue: { code: 'subject_root_missing' | 'learner_topic_required'; detail: string };
      /** Set when a subject was created/replayed before a later placement failure. */
      subject?: PlacementSubject;
    };

const ROOT = /^seed:([^:]+):root$/;

interface LearnerAsk {
  session_id: string | null;
  actor_kind: string;
  action: string;
  payload: { user_message?: unknown };
}

/** The learner's own message for this turn, or undefined when the ask is not theirs. */
function learnerAskMessage(
  ask: LearnerAsk | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!ask || sessionId === undefined) return undefined;
  if (ask.session_id !== sessionId) return undefined;
  if (ask.actor_kind !== 'user' || ask.action !== 'experimental:copilot_user_ask') return undefined;
  return typeof ask.payload.user_message === 'string' ? ask.payload.user_message : undefined;
}

/** Topic provenance stays outside the frozen question and scoring contract. */
export async function resolveTeachingDraftPlacement(
  db: Db,
  input: PlacementInput,
  origin: {
    sessionId?: string;
    causedByEventId?: string;
    taskRunId?: string;
    /** Receives the created/replayed subject before later failures can hide it. */
    onSubjectCreated?: (subject: PlacementSubject) => void;
  },
): Promise<PlacementResult> {
  const rootOnly =
    input.knowledge_ids.length > 0 && input.knowledge_ids.every((id) => ROOT.test(id));
  const fallback = input.knowledge_ids.length === 0 || rootOnly;
  if (!fallback) return { ok: true, knowledge_ids: input.knowledge_ids };
  const ids = new Set(input.knowledge_ids.map((id) => ROOT.exec(id)?.[1]));
  const subjectId = input.subject_id ?? (ids.size === 1 ? [...ids][0] : undefined);
  // Read the owning ask once: the same message proves both the new-subject claim
  // and the topic provenance come from this turn's learner.
  const [ask] = origin.causedByEventId
    ? await db.select().from(event).where(eq(event.id, origin.causedByEventId)).limit(1)
    : [];
  const message = learnerAskMessage(ask, origin.sessionId);
  // Every check that can reject this draft runs before any subject write: a failed
  // placement must not leave a subject behind.
  if (!input.learner_topic || message === undefined || !message.includes(input.learner_topic)) {
    return {
      ok: false,
      issue: {
        code: 'learner_topic_required',
        detail: '没有取得本轮请求中的主题原话，这次没有存题。',
      },
    };
  }
  const readSubject = (id: string) =>
    db
      .select({ id: subject.id, name: subject.display_name })
      .from(subject)
      .where(and(eq(subject.id, id), isNull(subject.retired_at), eq(subject.is_selectable, true)))
      .limit(1);
  let [row] = subjectId ? await readSubject(subjectId) : [];
  let placedSubject: PlacementSubject | undefined;
  // Only an unregistered subject can be created here. A live row with a missing
  // root is a repair case: creating a same-named subject would fork the registry.
  if (
    !row &&
    input.knowledge_ids.length === 0 &&
    input.subject_id !== undefined &&
    origin.causedByEventId !== undefined &&
    origin.taskRunId !== undefined
  ) {
    const claim = learnerStatedSubject(message, input.subject_id);
    if (claim) {
      const created = await createSubjectThroughPort(db, claim, {
        askEventId: origin.causedByEventId,
        taskRunId: origin.taskRunId,
        onCommitted: (committed) => origin.onSubjectCreated?.({ id: committed.id, created: true }),
      });
      if (created.kind === 'created' || created.kind === 'replayed') {
        // Replay has no commit callback; report it before the re-read can throw.
        if (created.kind === 'replayed')
          origin.onSubjectCreated?.({ id: created.payload.id, created: false });
        [row] = await readSubject(created.payload.id);
        if (row) placedSubject = { id: row.id, created: created.kind === 'created' };
      }
    }
  }
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
      ...(placedSubject ? { subject: placedSubject } : {}),
    };
  }
  return {
    ok: true,
    knowledge_ids: [root.id],
    learner_topic: input.learner_topic,
    placement_note: `请求的主题还没有合适的知识节点，这道题先放在「${row.name}」下；建好对应知识点后会自动归过去。`,
    ...(placedSubject ? { subject: placedSubject } : {}),
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
