// What the feedback card needs from a settled judgment, from any of the routes it can arrive by.

import { z } from 'zod';
import { GradingProvenanceEntry, type GradingProvenanceEntryT } from '@/core/schema/capability';
import type { JudgePreview, QuestionFullDetail, SubmitResult } from './practice-api';

export type JudgeFeedback = Pick<
  JudgePreview,
  'route' | 'coarse_outcome' | 'confidence' | 'feedback_md' | 'suggested_rating'
> & {
  partial_units?: Extract<JudgePreview, { coarse_outcome: 'partial_unknown' }>['partial_units'];
  grading_provenance?: GradingProvenanceEntryT[];
};

const WithProvenance = z.object({ grading_provenance: z.array(GradingProvenanceEntry) });

/** The AI label from a durable run's terminal result, when it has one. */
export function provenanceOf(result: unknown): Pick<JudgeFeedback, 'grading_provenance'> {
  const parsed = WithProvenance.safeParse(result);
  return parsed.success ? { grading_provenance: parsed.data.grading_provenance } : {};
}

export function feedbackFromCommittedAttempt(result: SubmitResult): JudgeFeedback {
  if (!result.judge) {
    throw new Error('诊断提交没有返回服务端判分');
  }
  return {
    route: result.judge.route,
    coarse_outcome: result.judge.coarse_outcome,
    ...(result.judge.coarse_outcome === 'partial_unknown'
      ? { partial_units: result.judge.partial_units }
      : {}),
    confidence: result.judge.confidence,
    feedback_md: result.judge.feedback_md,
    ...(result.judge.grading_provenance
      ? { grading_provenance: result.judge.grading_provenance }
      : {}),
    // auto_rate 的正常回执恒带 suggested_rating；旧/滚动部署响应若漏掉，
    // review_event.rating 仍是服务端最终实际采用的评级，不能在 UI 侧猜。
    suggested_rating:
      result.judge.coarse_outcome === 'partial_unknown'
        ? null
        : (result.judge.suggested_rating ??
          ('rating' in result.review_event ? result.review_event.rating : null)),
  };
}

export function feedbackFromCommittedDiagnosticAttempt(
  result: NonNullable<QuestionFullDetail['committed_attempt']>,
): JudgeFeedback {
  return {
    route: result.judge.route,
    coarse_outcome: result.judge.coarse_outcome,
    confidence: result.judge.confidence,
    feedback_md: result.judge.feedback_md,
    suggested_rating: result.judge.suggested_rating,
  };
}
