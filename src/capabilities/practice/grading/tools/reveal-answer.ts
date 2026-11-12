import { desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { PracticeIssuanceDto } from '@/core/schema/assessment/dto';
import {
  assessment_issuance,
  assessment_submission,
  event,
  question,
  question_revision,
} from '@/db/schema';
import {
  hasPriorSolutionExposure,
  loadIssuanceStudyCoordinate,
} from '@/kernel/records/study-reference';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { recordAssistanceExposure } from '../server/assessment/assistance';
import { projectFrozenStudyContext } from '../server/assessment/study-context';

const Input = z
  .object({ question_id: z.string().min(1).describe('An open issued question id.') })
  .strict();

const Output = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('revealed'),
      question_id: z.string(),
      issuance_id: z.string(),
      prompt_md: z.string(),
      reference_md: z.string(),
      practice_dto: PracticeIssuanceDto,
    })
    .strict(),
  z.object({ status: z.literal('no_open_issuance'), question_id: z.string() }).strict(),
  z.object({ status: z.literal('unknown_question'), question_id: z.string() }).strict(),
  z.object({ status: z.literal('ambiguous'), question_id: z.string() }).strict(),
  z
    .object({
      status: z.literal('already_submitted'),
      question_id: z.string(),
      issuance_id: z.string(),
    })
    .strict(),
  z.object({ status: z.literal('reveal_unavailable'), question_id: z.string() }).strict(),
]);

/** The accepted review_answer original binds one issuance server-side; model arguments never do. */
async function boundIssuanceId(ctx: ToolContext): Promise<string | undefined> {
  const ref = ctx.reviewAnswer?.originalRef;
  if (!ref) return undefined;
  const [row] = await ctx.db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, ref))
    .limit(1);
  const issuance = (
    row?.payload as
      | {
          review_answer?: { original?: { assessment?: { issuance_id?: unknown } } };
        }
      | undefined
  )?.review_answer?.original?.assessment?.issuance_id;
  return typeof issuance === 'string' ? issuance : undefined;
}

async function execute(ctx: ToolContext, raw: unknown): Promise<z.infer<typeof Output>> {
  const input = Input.parse(raw);
  // 组 id 与小题 id 都按真实坐标解析：小题 id 只存在于发行冻结的 part_ids 里。
  const issuances = await ctx.db
    .select({
      issuance_id: assessment_issuance.issuance_id,
      issued_at: assessment_issuance.issued_at,
    })
    .from(assessment_issuance)
    .innerJoin(
      question_revision,
      eq(assessment_issuance.revision_id, question_revision.revision_id),
    )
    .where(
      sql`(${question_revision.group_id} = ${input.question_id} or ${assessment_issuance.part_ids} ? ${input.question_id})`,
    )
    .orderBy(desc(assessment_issuance.issued_at));

  if (issuances.length === 0) {
    const [known] = await ctx.db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, input.question_id))
      .limit(1);
    return {
      status: known ? 'no_open_issuance' : 'unknown_question',
      question_id: input.question_id,
    };
  }

  const submitted = new Set(
    (
      await ctx.db
        .select({ issuance_id: assessment_submission.issuance_id })
        .from(assessment_submission)
        .where(
          inArray(
            assessment_submission.issuance_id,
            issuances.map((row) => row.issuance_id),
          ),
        )
    ).map((row) => row.issuance_id),
  );
  const open = issuances.filter((row) => !submitted.has(row.issuance_id));

  const bound = await boundIssuanceId(ctx);
  const boundCandidate = bound ? issuances.find((row) => row.issuance_id === bound) : undefined;
  const chosen = boundCandidate ?? (open.length === 1 ? open[0] : undefined);
  if (!chosen) {
    if (open.length > 1) return { status: 'ambiguous', question_id: input.question_id };
    const latest = issuances[0];
    return {
      status: 'already_submitted',
      question_id: input.question_id,
      issuance_id: latest.issuance_id,
    };
  }

  const revealed = await ctx.db.transaction(async (tx) => {
    // 与提交同一把 issuance 行锁（锁序见 submit.ts）：锁内复查未提交，
    // 已提交就不再记受助；重复 reveal 依既有 solution 暴露幂等。
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, chosen.issuance_id))
      .for('update')
      .limit(1);
    if (!issuance) return { status: 'no_open_issuance' as const, question_id: input.question_id };
    const [submission] = await tx
      .select({ submission_id: assessment_submission.submission_id })
      .from(assessment_submission)
      .where(eq(assessment_submission.issuance_id, chosen.issuance_id))
      .limit(1);
    if (submission)
      return {
        status: 'already_submitted' as const,
        question_id: input.question_id,
        issuance_id: chosen.issuance_id,
      };
    const loaded = await loadIssuanceStudyCoordinate(tx, chosen.issuance_id, input.question_id);
    if (loaded.status !== 'assistable')
      return { status: 'reveal_unavailable' as const, question_id: input.question_id };
    const context = projectFrozenStudyContext(loaded.revision, loaded.issuance, input.question_id);
    if (!context.reference_md)
      return { status: 'reveal_unavailable' as const, question_id: input.question_id };
    if (!(await hasPriorSolutionExposure(tx, chosen.issuance_id))) {
      await recordAssistanceExposure(tx, {
        issuanceId: chosen.issuance_id,
        questionId: loaded.questionId,
        kind: 'solution',
        impact: 'answer_help',
        contentDigest: `sha256:${canonicalHash(context.reference_md)}`,
      });
    }
    return {
      status: 'revealed' as const,
      question_id: input.question_id,
      issuance_id: chosen.issuance_id,
      prompt_md: context.prompt_md,
      reference_md: context.reference_md,
      practice_dto: context.practice_dto,
    };
  });
  return revealed;
}

export const revealAnswerTool: DomainTool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'reveal_answer',
  description:
    'Give the learner the reference answer for an open issued question — the server records solution/answer_help assistance on that issuance BEFORE returning the frozen prompt, options and reference_md, so the submission is not counted as independent evidence. Use only for an explicit final-answer request on an unsubmitted question — never for hints or option analysis. Statuses: revealed → present reference_md plainly against the returned prompt/options; already_submitted → explain from the existing submission; ambiguous → say honestly the issuance cannot be resolved; no_open_issuance → ask the learner to open it first, never quote an unrecorded answer; unknown_question → the id does not resolve; reveal_unavailable → study assistance not permitted.',
  effect: 'write',
  costClass: 'local',
  inputSchema: Input,
  outputSchema: Output,
  execute,
  summarize(_input, output) {
    return `reveal_answer · ${output.status}`;
  },
  mirrorEvent: 'never',
};
