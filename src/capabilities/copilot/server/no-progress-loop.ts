import { type HelpProviderFault, helpExitLead } from '@/ai/help-provider-fault';
import type { EvidenceFact, NoProgressCloseReason, NoProgressClosure } from '@/ai/no-progress-loop';
import type { Db, Tx } from '@/db/client';
import { writeEvaluationCorrectionProposal } from '@/kernel/proposals/producers';
import { getQuestionTimeline } from '@/kernel/read-models/question-activity';

export type {
  EvidenceFact,
  EvidenceKind,
  NoProgressCloseReason,
  NoProgressClosure,
} from '@/ai/no-progress-loop';

export type VerifiedFallback =
  | {
      readonly kind: 'grading_correction';
      readonly operation: 'writeEvaluationCorrectionProposal';
      readonly evaluationId: string;
      readonly attemptEventId: string | null;
      /** explicit: the same object stated a dispute reason. none: ids only. */
      readonly dispute: 'explicit' | 'none';
    }
  | {
      readonly kind: 'continue_session';
      readonly operation: 'durable_copilot_session';
      readonly sessionId: string;
      readonly questionId: string | null;
      readonly attemptEventIds: readonly string[];
    };

/** Written only after the reply marker is accepted in the settlement transaction. */
export interface SealedCorrectionFiling {
  readonly evaluationId: string;
  readonly attemptEventId: string | null;
  readonly reasonMd: string;
  readonly evidenceEventIds: readonly string[];
  readonly actorRef: string;
  readonly taskRunId: string;
  readonly causedByEventId?: string;
}

async function resolveEvaluation(
  db: Db,
  facts: readonly EvidenceFact[],
): Promise<{ evaluationId: string; attemptEventId: string | null } | null> {
  const direct = facts.find((fact) => fact.kind === 'evaluation');
  const attempt = facts.find((fact) => fact.kind === 'attempt');
  if (direct) return { evaluationId: direct.id, attemptEventId: attempt?.id ?? null };
  const questionIds = [
    ...new Set(facts.filter((fact) => fact.kind === 'question').map((fact) => fact.id)),
  ].slice(0, 3);
  const attemptIds = new Set(
    facts.filter((fact) => fact.kind === 'attempt' || fact.kind === 'event').map((fact) => fact.id),
  );
  const judgeIds = new Set(
    facts.filter((fact) => fact.kind === 'judge_event').map((fact) => fact.id),
  );
  for (const questionId of questionIds) {
    const timeline = await getQuestionTimeline(db, questionId, 10);
    const matched = timeline.find((entry) => {
      if (entry.kind !== 'attempt') return false;
      if (attemptIds.has(entry.event_id)) return true;
      const judge = entry.judge;
      return (
        judge !== null &&
        (judgeIds.has(judge.original_event_id) ||
          (judge.effective_event_id !== null && judgeIds.has(judge.effective_event_id)))
      );
    });
    const evaluationId =
      matched?.kind === 'attempt'
        ? (matched.assessment?.effective_evaluation_id ??
          matched.assessment?.original_evaluation_id)
        : null;
    if (matched?.kind === 'attempt' && evaluationId) {
      return { evaluationId, attemptEventId: matched.event_id };
    }
  }
  return null;
}

/**
 * Read-only choice. Attempt and evaluation ids from ordinary reads are disclosed,
 * not filed. A proposal is prepared only when the same object states a dispute reason.
 */
export async function chooseVerifiedFallback(input: {
  db: Db;
  sessionId: string;
  taskRunId: string;
  actorRef: string;
  causedByEventId?: string;
  allowProposal: boolean;
  evidence: readonly EvidenceFact[];
}): Promise<{ fallback: VerifiedFallback; filing?: SealedCorrectionFiling }> {
  const questionId = input.evidence.find((fact) => fact.kind === 'question')?.id ?? null;
  const attemptEventIds = input.evidence
    .filter((fact) => fact.kind === 'attempt')
    .map((fact) => fact.id);
  const continueSession: VerifiedFallback = {
    kind: 'continue_session',
    operation: 'durable_copilot_session',
    sessionId: input.sessionId,
    questionId,
    attemptEventIds,
  };
  const dispute = input.evidence.find((fact) => fact.kind === 'dispute' && fact.detail);
  let resolved: { evaluationId: string; attemptEventId: string | null } | null = null;
  if (dispute) {
    resolved = {
      evaluationId: dispute.id,
      attemptEventId: attemptEventIds[0] ?? null,
    };
  } else {
    try {
      resolved = await resolveEvaluation(input.db, input.evidence);
    } catch (error) {
      console.error('[no-progress-loop] evaluation lookup failed', { error });
    }
  }
  if (!resolved) return { fallback: continueSession };
  const filing =
    input.allowProposal && dispute?.detail && dispute.id === resolved.evaluationId
      ? {
          evaluationId: resolved.evaluationId,
          attemptEventId: resolved.attemptEventId,
          reasonMd: dispute.detail,
          evidenceEventIds: [
            ...new Set(
              input.evidence
                .filter(
                  (fact) =>
                    fact.kind === 'event' || fact.kind === 'attempt' || fact.kind === 'judge_event',
                )
                .map((fact) => fact.id),
            ),
          ].slice(0, 12),
          actorRef: input.actorRef,
          taskRunId: input.taskRunId,
          ...(input.causedByEventId ? { causedByEventId: input.causedByEventId } : {}),
        }
      : undefined;
  return {
    fallback: {
      kind: 'grading_correction',
      operation: 'writeEvaluationCorrectionProposal',
      evaluationId: resolved.evaluationId,
      attemptEventId: resolved.attemptEventId,
      dispute: filing ? 'explicit' : 'none',
    },
    ...(filing ? { filing } : {}),
  };
}

export async function fileSealedCorrection(
  db: Db | Tx,
  filing: SealedCorrectionFiling,
): Promise<void> {
  await writeEvaluationCorrectionProposal(db, {
    actor_ref: filing.actorRef,
    evaluation_id: filing.evaluationId,
    correction_kind: 'rejudge',
    reason_md: filing.reasonMd,
    attempt_event_id: filing.attemptEventId,
    observed: { dispute_reason: filing.reasonMd },
    evidence_refs: filing.evidenceEventIds.map((id) => ({ kind: 'event' as const, id })),
    task_run_id: filing.taskRunId,
    caused_by_event_id: filing.causedByEventId ?? null,
  });
}

export function mergeNoProgressReply(prose: string, closure: string, limit: number): string {
  const head = prose.trim();
  const tail = closure.trim();
  if (!head) return tail.slice(0, limit);
  if (!tail) return head.slice(0, limit);
  const gap = '\n\n';
  if (head.length + gap.length + tail.length <= limit) return `${head}${gap}${tail}`;
  const tailBudget = Math.min(tail.length, Math.max(limit - gap.length - 1, 0));
  const keptTail = tail.slice(0, tailBudget);
  const headBudget = limit - gap.length - keptTail.length;
  if (headBudget <= 0) return tail.slice(0, limit);
  return `${head.slice(0, headBudget)}${gap}${keptTail}`;
}

export function assistantProse(streamed: string, terminal: string): string {
  const stream = streamed.trim();
  const end = terminal.trim();
  if (!stream) return end;
  if (!end) return stream;
  if (stream === end || stream.endsWith(end) || end.endsWith(stream)) {
    return stream.length >= end.length ? stream : end;
  }
  return `${stream}\n\n${end}`;
}

function helpFaultOfReason(reason: NoProgressCloseReason): HelpProviderFault | undefined {
  if (reason === 'help_quota') return { kind: 'quota', httpStatus: 429 };
  if (reason === 'help_bad_gateway') return { kind: 'bad_gateway', httpStatus: 502 };
  if (reason === 'help_parse') return { kind: 'parse' };
  return undefined;
}

/**
 * Learner-facing seal note appended to the model's own answer. It carries no
 * internal ids, tool names or operation names — the evidence list stays in
 * `NoProgressClosure.evidence` and the actionable entry in `fallback`, both
 * for the server's own settlement and correction-filing use only.
 */
export function renderNoProgressClosure(
  closure: NoProgressClosure,
  fallback: VerifiedFallback,
): string {
  const helpFault = helpFaultOfReason(closure.reason);
  const why = helpFault
    ? helpExitLead(helpFault)
    : closure.reason === 'budget_landing'
      ? '这次运行快到时间上限，先把已经拿到的内容交给你，不再继续查。'
      : '同样的查询没有带来新证据，所以停在这里，不再重复查。';
  const next =
    fallback.kind === 'grading_correction'
      ? fallback.dispute === 'explicit'
        ? '已经按这次对话里说明的判词异议登记了一条判分复核提案；接受后按冻结作答重判，不改写原来的评价。'
        : '如果对这次判分有疑问，直接在这条对话里说明，可以发起一次判分复核：复核按冻结作答重判，不改写原来的评价。'
      : '可以在这次对话里直接继续，说明下一步要看哪一题或哪一次作答。';
  return [why, '', '下一步', next].join('\n');
}
