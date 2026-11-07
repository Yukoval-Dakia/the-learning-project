import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { backtrace_work, event } from '@/db/schema';
import { readGradedAttempt, resolveBacktraceAnchor } from '@/kernel/read-models/graded-attempt';
import { loadBacktraceInput } from './backtrace-input';
import { backtracePool } from './backtrace-pool';
import { currentInsight, currentJudgement } from './backtrace-store';

/** Read-only: never invokes a provider. Every cache source is re-authorized before returning text. */
export async function readBacktrace(
  db: Db,
  opts: { attempt_event_id?: string; question_id?: string; session_id?: string },
) {
  const attempt = await resolveBacktraceAnchor(db, opts);
  if (!attempt)
    return {
      status: 'unavailable' as const,
      anchor: null,
      same_question: [],
      similar_mistakes: [],
      similar_solutions: [],
      broader: [],
      judgement: null,
    };
  const anchor = {
    attempt_event_id: attempt.id,
    question_id: attempt.question_id,
    outcome: attempt.outcome,
  };
  if (!attempt.visible)
    return {
      status: 'buffered' as const,
      anchor: null,
      same_question: [],
      similar_mistakes: [],
      similar_solutions: [],
      broader: [],
      judgement: null,
    };
  const earlier = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.subject_id, attempt.question_id),
        inArray(event.action, ['attempt', 'review', 'experimental:assessment_attempt']),
        lt(event.created_at, new Date(attempt.created_at)),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq))
    .limit(32);
  const sameQuestion = [];
  for (const source of earlier) {
    const row = await readGradedAttempt(db, source.id);
    if (!row?.visible) continue;
    sameQuestion.push({
      attempt_event_id: row.id,
      question_id: row.question_id,
      answer_md: row.answer_md,
      created_at: row.created_at,
      outcome: row.outcome,
      insight: (await currentInsight(db, row.id))?.insight ?? null,
    });
    if (sameQuestion.length === 5) break;
  }
  const basis = await loadBacktraceInput(db, attempt.id);
  const work = await db
    .select()
    .from(backtrace_work)
    .where(eq(backtrace_work.attempt_event_id, attempt.id));
  const unresolved = (digests: string[]) =>
    work.some(
      (x) =>
        digests.includes(x.input_digest) &&
        (x.state === 'needs_reconciliation' ||
          (x.state === 'sending' && Date.now() - x.created_at.getTime() > 600_000)),
    );
  const failed = basis && work.find((x) => x.input_digest === basis.digest && x.state === 'failed');
  const insight = await currentInsight(db, attempt.id);
  if (!insight)
    return {
      status: failed
        ? ('failed' as const)
        : basis && unresolved([basis.digest])
          ? ('needs_reconciliation' as const)
          : ('pending_insight' as const),
      ...(failed
        ? {
            failure: {
              reason_md: String(failed.result?.reason_md ?? '描述任务失败'),
              cost_upper_usd:
                typeof failed.result?.cost_upper_usd === 'number'
                  ? failed.result.cost_upper_usd
                  : null,
            },
          }
        : {}),
      anchor,
      same_question: sameQuestion,
      similar_mistakes: [],
      similar_solutions: [],
      broader: [],
      judgement: null,
    };
  const { pool, digest } = await backtracePool(db, insight);
  const judged = await currentJudgement(db, attempt.id, digest);
  const failure = failed || work.find((x) => x.input_digest === digest && x.state === 'failed');
  const historyByQuestion = new Map<string, Array<{ created_at: string; outcome: string }>>();
  for (const questionId of new Set(pool.map((x) => x.insight.question_id))) {
    const rows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.subject_id, questionId),
          inArray(event.action, ['attempt', 'review', 'experimental:assessment_attempt']),
        ),
      )
      .orderBy(desc(event.created_at), desc(event.dispatch_seq));
    const history = [];
    for (const source of rows) {
      const row = await readGradedAttempt(db, source.id);
      if (row?.visible) history.push({ created_at: row.created_at, outcome: row.outcome });
    }
    historyByQuestion.set(questionId, history);
  }
  const matches = (judged?.judgement.matches ?? [])
    .flatMap((match) => {
      if (match.relation === 'not_similar') return [];
      const candidate = pool.find((x) => x.attempt_event_id === match.attempt_event_id);
      if (!candidate) return [];
      const age = Math.max(0, (Date.now() - Date.parse(candidate.created_at)) / 86400000);
      const generic = match.specificity === 'broad' ? 1 : 0;
      const questionAttempts = historyByQuestion.get(candidate.insight.question_id) ?? [];
      const count = questionAttempts.length;
      const fixed = questionAttempts.some(
        (x) => x.outcome === 'success' && x.created_at > candidate.created_at,
      );
      const errorRate =
        questionAttempts.filter((x) => x.outcome !== 'success').length / Math.max(1, count);
      const score =
        (0.45 * candidate.sim +
          0.2 * Math.exp(-age / 30) +
          0.15 * Math.min(1, Math.log2(1 + count) / 3) +
          0.2 *
            (match.relation === 'same_mechanism'
              ? Number(!fixed)
              : candidate.outcome === 'success'
                ? 1
                : candidate.outcome === 'partial'
                  ? 0.4
                  : 0)) *
        (1 - 0.5 * generic);
      return [
        {
          ...match,
          question_id: candidate.insight.question_id,
          prompt_snippet: candidate.prompt_md,
          answer_md: candidate.answer_md,
          created_at: candidate.created_at,
          outcome: candidate.outcome,
          insight: candidate.insight,
          signals: {
            basis: 'same_question_history' as const,
            count,
            last_seen_at: questionAttempts[0]?.created_at ?? candidate.created_at,
            fixed_later: fixed,
            error_rate: errorRate,
            sim: candidate.sim,
            generic,
          },
          score,
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(a.specificity === 'broad') - Number(b.specificity === 'broad') || b.score - a.score,
    );
  return {
    status: judged
      ? ('ready' as const)
      : failure
        ? ('failed' as const)
        : unresolved([digest, insight.basis.digest])
          ? ('needs_reconciliation' as const)
          : ('judging' as const),
    ...(failure
      ? {
          failure: {
            reason_md: String(failure.result?.reason_md ?? '历史比较失败'),
            cost_upper_usd:
              typeof failure.result?.cost_upper_usd === 'number'
                ? failure.result.cost_upper_usd
                : null,
          },
        }
      : {}),
    anchor: { ...anchor, insight: insight.insight },
    same_question: sameQuestion,
    similar_mistakes: matches.filter(
      (x) => x.specificity === 'specific' && x.relation === 'same_mechanism',
    ),
    similar_solutions: matches.filter(
      (x) =>
        x.specificity === 'specific' &&
        x.outcome === 'success' &&
        x.insight.method?.provenance === 'evidence' &&
        ['same_method', 'needs_this_method'].includes(x.relation),
    ),
    broader: matches.filter((x) => x.specificity === 'broad'),
    judgement: judged
      ? {
          event_id: judged.row.id,
          task_run_id: judged.row.task_run_id,
          judged_at: judged.row.created_at.toISOString(),
        }
      : null,
  };
}

export async function backtraceContext(
  db: Db,
  opts: { attempt_event_id?: string; question_id?: string; session_id?: string },
) {
  const view = await readBacktrace(db, opts);
  if (view.status !== 'ready') return null;
  return JSON.stringify({
    anchor: view.anchor?.attempt_event_id,
    similar_mistakes: view.similar_mistakes.slice(0, 1).map((x) => ({
      attempt_event_id: x.attempt_event_id,
      why_md: x.why_md.slice(0, 180),
      outcome: x.outcome,
      key_step_md: x.insight.method?.key_step_md.slice(0, 160),
      mechanism_md: x.insight.mechanism?.what_went_wrong_md.slice(0, 180),
    })),
    similar_solutions: view.similar_solutions.slice(0, 1).map((x) => ({
      attempt_event_id: x.attempt_event_id,
      why_md: x.why_md.slice(0, 180),
      outcome: x.outcome,
      key_step_md: x.insight.method?.key_step_md.slice(0, 160),
    })),
  });
}
