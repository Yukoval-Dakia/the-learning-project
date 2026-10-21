// `propose_grading_correction` DomainTool（effect:'propose'）。
// Agent（research_meeting / coach / dreaming / Copilot）发现疑似误判时调用本
// 工具落一条可逆的 judge_retraction proposal —— 不是 note，不是直写：
// 1. grounding：目标必须是真实存在的 completed evaluation 行；proposal 携带
// 判词快照（coarse/score/judged_by）与 frozen attempt 事件证据引用。
// pending attempt 是可重试 infra 态不是判词 → rejected。
// 2. 可逆：proposal 天然 pending（人审）；accept 后走既有纠错链 ——
// rejudge → experimental:appeal_request → rejudge job → 冻结输入重评 →
// activation CAS → settlement replay；assert → manual_assert candidate
// 直接激活。两条路径都不回写原评价/FSRS/掌握度。
// 3. 幂等：producer 在同一事务内复查 pending 的 judge_retraction proposal，
// 并发重复调用也只落一单。
// 不自动执行任何判分变更；accept 策略是 owner 决策（见）。

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { evaluation } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { writeEvaluationCorrectionProposal } from '@/kernel/proposals/producers';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';

const ProposeGradingCorrectionInputSchema = z
  .object({
    /** 目标 native evaluation id（eval_*）。 */
    evaluation_id: z.string().trim().min(1),
    /** 纠错理由（写进 proposal.reason_md 与 appeal request）。 */
    reason_md: z.string().trim().min(1).max(2000),
    /**
     * rejudge（默认）= 重评冻结输入，走异步 appeal/rejudge/CAS 激活链；
     * assert = 携带每个在判 unit 的人工判定，accept 后 manual_assert 激活。
     */
    correction_kind: z.enum(['rejudge', 'assert']).default('rejudge'),
    /** correction_kind='assert' 时必填：每个 in-scope unit 一条 correct|incorrect。 */
    asserted_verdicts: z
      .array(
        z.object({
          scoring_unit_id: z.string().min(1),
          verdict: z.enum(['correct', 'incorrect']),
        }),
      )
      .optional(),
    /** 额外事件证据引用（判词/作答/相关事件 id）。 */
    evidence_event_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();
type ProposeGradingCorrectionInput = z.infer<typeof ProposeGradingCorrectionInputSchema>;

const ProposeGradingCorrectionOutputSchema = z.object({
  status: z.enum(['filed', 'duplicate', 'rejected']),
  reason: z.string(),
  proposal_event_id: z.string().nullable(),
  evaluation_id: z.string(),
});
type ProposeGradingCorrectionOutput = z.infer<typeof ProposeGradingCorrectionOutputSchema>;

async function executeProposeGradingCorrection(
  ctx: ToolContext,
  input: ProposeGradingCorrectionInput,
): Promise<ProposeGradingCorrectionOutput> {
  const db: Db = ctx.db;
  const [row] = await db
    .select({
      evaluation_id: evaluation.evaluation_id,
      status: evaluation.status,
      evaluation_group_id: evaluation.evaluation_group_id,
      submission_id: evaluation.submission_id,
      aggregate: evaluation.aggregate,
      unit_results: evaluation.unit_results,
      provenance: evaluation.provenance,
    })
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, input.evaluation_id))
    .limit(1);
  if (!row) {
    return {
      status: 'rejected',
      reason: `evaluation ${input.evaluation_id} not found`,
      proposal_event_id: null,
      evaluation_id: input.evaluation_id,
    };
  }
  if (row.status !== 'completed') {
    return {
      status: 'rejected',
      reason:
        'evaluation attempt is still pending (retryable infra state) — only completed verdicts can be corrected',
      proposal_event_id: null,
      evaluation_id: input.evaluation_id,
    };
  }

  // 判词快照：让 reviewer 不用回查 evaluation 行就能看清在纠错什么。
  const unitResults = Array.isArray(row.unit_results) ? row.unit_results : [];
  const observed = {
    status: row.status,
    aggregate: row.aggregate ?? null,
    provenance_source:
      row.provenance && typeof row.provenance === 'object'
        ? ((row.provenance as { source?: string }).source ?? null)
        : null,
    unit_results: unitResults.map((unit) => {
      const u = unit as Record<string, unknown>;
      return {
        scoring_unit_id: u.scoring_unit_id,
        status: u.status,
        points_awarded: u.points_awarded ?? null,
        judged_by: u.judged_by ?? null,
        pending_reason:
          u.pending && typeof u.pending === 'object'
            ? ((u.pending as { reason?: string }).reason ?? null)
            : null,
      };
    }),
  };

  let written: Awaited<ReturnType<typeof writeEvaluationCorrectionProposal>>;
  try {
    written = await writeEvaluationCorrectionProposal(db, {
      actor_ref: ctx.callerActor.ref,
      evaluation_id: input.evaluation_id,
      correction_kind: input.correction_kind,
      asserted_verdicts: input.asserted_verdicts,
      observed,
      attempt_event_id: `evt_assessment_${row.submission_id}`,
      reason_md: input.reason_md,
      evidence_refs: (input.evidence_event_ids ?? []).map((id) => ({
        kind: 'event' as const,
        id,
      })),
      task_run_id: ctx.taskRunId,
      caused_by_event_id: ctx.causedByEventId ?? null,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        status: 'rejected',
        reason: error.message,
        proposal_event_id: null,
        evaluation_id: input.evaluation_id,
      };
    }
    throw error;
  }
  if (written.status === 'duplicate') {
    return {
      status: 'duplicate',
      reason: 'a pending grading-correction proposal already exists for this evaluation',
      proposal_event_id: null,
      evaluation_id: input.evaluation_id,
    };
  }

  return {
    status: 'filed',
    reason:
      input.correction_kind === 'assert'
        ? 'grading-correction proposal filed — owner accept runs a manual-assert candidate through activation + settlement replay'
        : 'grading-correction proposal filed — owner accept queues a regrade of the frozen submission through the appeal chain',
    proposal_event_id: written.proposal_event_id,
    evaluation_id: input.evaluation_id,
  };
}

export const proposeGradingCorrectionTool: DomainTool<
  ProposeGradingCorrectionInput,
  ProposeGradingCorrectionOutput
> = {
  name: 'propose_grading_correction',
  description:
    'File a REVERSIBLE grading-correction proposal for a completed native evaluation (eval_*) that looks misgraded — e.g. a worked derivation judged 0 because the exact comparator could not read it, or a verdict contradicted by evidence. This does NOT regrade anything itself: it files a judge_retraction proposal that the owner reviews in the inbox. On accept, correction_kind=rejudge re-evaluates the frozen submission through the existing appeal chain (new candidate evaluation → CAS activation → settlement replay recalculates learning effects); correction_kind=assert activates a manual verdict immediately (requires asserted_verdicts covering every in-scope unit: {scoring_unit_id, verdict: correct|incorrect}). Use get_attempt_context / the events of the attempt to ground evidence first — evidence_event_ids are attached to the proposal for review. Pending (incomplete) evaluation attempts are rejected: they are retryable infra state, not verdicts. Duplicate-safe: a pending proposal for the same evaluation returns status duplicate.',
  effect: 'propose',
  inputSchema: ProposeGradingCorrectionInputSchema,
  outputSchema: ProposeGradingCorrectionOutputSchema,
  costClass: 'local',
  execute: executeProposeGradingCorrection,
  summarize: (_input, output) => `grading correction ${output.evaluation_id} → ${output.status}`,
  mirrorEvent: 'when_causal',
};
