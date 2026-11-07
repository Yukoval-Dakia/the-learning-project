import { and, desc, eq, inArray } from 'drizzle-orm';
import { AttemptQuestionSnapshot } from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { filterActiveRows, getEffectiveTruths } from '@/kernel/events';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { resolveVerdictsForAttempts, resolveVerdictsForNativeAttempts } from './assessment-verdict';

/** All graded outcomes share this authorization boundary; failure-only readers must not supply successes. */
export async function readGradedAttempt(db: Db | Tx, id: string) {
  const [raw] = await db.select().from(event).where(eq(event.id, id));
  if (
    raw?.subject_kind !== 'question' ||
    !['attempt', 'review', 'experimental:assessment_attempt'].includes(raw.action)
  )
    return null;
  if (!(await filterActiveRows(db, [raw])).length || !(await allowedEventIds(db, [id])).has(id))
    return null;
  const native = (await resolveVerdictsForNativeAttempts(db, [raw])).get(id);
  const legacy =
    raw.action === 'experimental:assessment_attempt'
      ? null
      : (await resolveVerdictsForAttempts(db, [id])).get(id);
  if (raw.action === 'experimental:assessment_attempt' && !native?.effective) return null;
  const verdict =
    native?.effective?.verdict.verdict ??
    legacy?.effective?.verdict.coarse_outcome ??
    legacy?.embedded?.coarse_outcome;
  if (!verdict || !['correct', 'partial', 'incorrect'].includes(verdict)) return null;
  const judges = [legacy?.original?.row, legacy?.effective?.row].filter(
    (x): x is typeof raw => !!x,
  );
  const causes = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:user_cause'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, id),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq));
  const activeCauses = await filterActiveRows(db, causes);
  const cause = activeCauses[0];
  const causeTruths = await getEffectiveTruths(
    db,
    causes.map((x) => x.id),
  );
  const causeSources = cause
    ? causes
        .filter((x) => x.id === cause.id || causeTruths.get(x.id)?.effective_event_id === cause.id)
        .map((x) => x.id)
    : [];
  const sources = [id, ...judges.map((x) => x.id), ...causeSources];
  const allowed = await allowedEventIds(db, sources);
  if (sources.some((x) => !allowed.has(x))) return null;
  const snapshot = AttemptQuestionSnapshot.safeParse(raw.payload.question_snapshot);
  const answer =
    typeof raw.payload.response_md === 'string'
      ? raw.payload.response_md
      : typeof raw.payload.answer_md === 'string'
        ? raw.payload.answer_md
        : typeof raw.payload.user_response_md === 'string'
          ? raw.payload.user_response_md
          : '';
  const trace = typeof raw.payload.reasoning_trace === 'string' ? raw.payload.reasoning_trace : '';
  const imageRefs = Array.isArray(raw.payload.answer_image_refs)
    ? raw.payload.answer_image_refs
    : [];
  const hasNativeImages =
    native?.submission.response_set.entries.some(
      (x) => x.kind === 'open' && x.evidence.length > 0,
    ) ?? false;
  let visible = legacy?.effective?.verdict.visible_to_user !== false;
  if (native) {
    const releases = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_feedback_released'),
          eq(event.subject_id, id),
        ),
      );
    visible = (await filterActiveRows(db, releases)).length > 0;
  } else if (!visible && raw.session_id) {
    const [session] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, raw.session_id));
    visible = session?.status === 'completed';
  }
  return {
    id,
    question_id: raw.subject_id,
    created_at: raw.created_at.toISOString(),
    session_id: raw.session_id,
    outcome:
      verdict === 'correct'
        ? ('success' as const)
        : verdict === 'partial'
          ? ('partial' as const)
          : ('failure' as const),
    judge_event_id: legacy?.effective?.judge_event_id ?? null,
    evaluation_id: native?.effective?.evaluation_id ?? null,
    evaluation_group_id: native?.evaluation_group_id ?? null,
    prompt_md: snapshot.success
      ? [snapshot.data.parent_question?.prompt_md, snapshot.data.question.prompt_md]
          .filter(Boolean)
          .join('\n')
      : null,
    reference_md: snapshot.success ? snapshot.data.question.reference_md : null,
    native_revision: native ? { revision: native.revision, issuance: native.issuance } : null,
    answer_md: answer,
    reasoning_trace: trace,
    response_set: native?.submission.response_set ?? null,
    feedback_md: legacy?.effective?.verdict.feedback_md ?? legacy?.embedded?.feedback_md ?? null,
    attribution: legacy?.effective?.verdict.cause ?? null,
    user_cause_event_id: cause?.id ?? null,
    user_notes: typeof cause?.payload.user_notes === 'string' ? cause.payload.user_notes : null,
    referenced_knowledge_ids:
      native?.knowledge_ids ??
      (Array.isArray(raw.payload.referenced_knowledge_ids)
        ? raw.payload.referenced_knowledge_ids.filter((x): x is string => typeof x === 'string')
        : []),
    source_event_ids: sources,
    visible,
    image_status:
      imageRefs.length || hasNativeImages
        ? answer.trim() || trace.trim()
          ? ('text_available' as const)
          : ('unavailable' as const)
        : ('none' as const),
  };
}

export async function resolveBacktraceAnchor(
  db: Db | Tx,
  opts: { attempt_event_id?: string; question_id?: string; session_id?: string },
) {
  if (opts.attempt_event_id) return readGradedAttempt(db, opts.attempt_event_id);
  if (!opts.question_id && !opts.session_id) return null;
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        inArray(event.action, ['attempt', 'review', 'experimental:assessment_attempt']),
        opts.question_id ? eq(event.subject_id, opts.question_id) : undefined,
        opts.session_id ? eq(event.session_id, opts.session_id) : undefined,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq))
    .limit(32);
  for (const row of rows) {
    const result = await readGradedAttempt(db, row.id);
    if (result?.visible) return result;
  }
  return null;
}
