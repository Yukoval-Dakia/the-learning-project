import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { assessment_issuance, assessment_submission, question_revision } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { revealFrozenStudyReference } from '../server/assessment/study-context';

const Input = z.object({ question_id: z.string().min(1) }).strict();

const Output = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('revealed'),
      question_id: z.string(),
      issuance_id: z.string(),
      reference_md: z.string(),
    })
    .strict(),
  z.object({ status: z.literal('no_open_issuance'), question_id: z.string() }).strict(),
  z
    .object({
      status: z.literal('already_submitted'),
      question_id: z.string(),
      issuance_id: z.string(),
    })
    .strict(),
  z.object({ status: z.literal('reveal_unavailable'), question_id: z.string() }).strict(),
]);

async function execute(ctx: ToolContext, raw: unknown): Promise<z.infer<typeof Output>> {
  const input = Input.parse(raw);
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
    .where(eq(question_revision.group_id, input.question_id))
    .orderBy(desc(assessment_issuance.issued_at));

  for (const row of issuances) {
    const [submission] = await ctx.db
      .select({ submission_id: assessment_submission.submission_id })
      .from(assessment_submission)
      .where(eq(assessment_submission.issuance_id, row.issuance_id))
      .limit(1);
    if (submission) continue;
    try {
      const revealed = await revealFrozenStudyReference(ctx.db, row.issuance_id);
      if (revealed.reference_md)
        return {
          status: 'revealed',
          question_id: input.question_id,
          issuance_id: row.issuance_id,
          reference_md: revealed.reference_md,
        };
      return { status: 'reveal_unavailable', question_id: input.question_id };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'reveal_unavailable')
        return { status: 'reveal_unavailable', question_id: input.question_id };
      throw error;
    }
  }
  const latest = issuances[0];
  if (latest)
    return {
      status: 'already_submitted',
      question_id: input.question_id,
      issuance_id: latest.issuance_id,
    };
  return { status: 'no_open_issuance', question_id: input.question_id };
}

export const revealAnswerTool: DomainTool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'reveal_answer',
  description:
    'Give the learner the reference answer for an open issued question — the server records solution/answer_help assistance on that issuance BEFORE returning it, so the submission is not counted as independent evidence. Use this whenever the learner explicitly asks for the final answer on an unjudged question; never for hints or option analysis. Statuses: revealed → present reference_md plainly; already_submitted → the attempt was judged, explain from that instead; no_open_issuance → the question is not open in practice — ask the learner to open it first rather than quoting an unrecorded answer; reveal_unavailable → this assessment does not permit study assistance.',
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
