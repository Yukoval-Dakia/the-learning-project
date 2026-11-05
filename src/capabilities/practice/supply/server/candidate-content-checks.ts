import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { webSourcedMetadata } from '@/core/schema/provenance';
import { SourcedQuestion, type SourcedQuestionT } from '@/core/schema/sourcing';
import { tool_call_log } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { resolveSubjectProfile } from '@/subjects/profile';
import { checkSourceConsistency, checkStructureCompleteness } from '../../question-bank/public';
import { matchesWhitelist } from './sourced-dedup';

/** The candidate's deterministic content checks run before any ingestion write. */
export function candidateContentIssues(input: {
  subject_id?: string;
  source_route: 'jyeoo_fetch' | 'sourcing_web';
  candidate: {
    question: SourcedQuestionT;
    extraction_hash: string;
    image_refs: readonly string[] | null;
    figures: readonly unknown[] | null;
    structured: unknown | null;
  };
}): { code: string; detail: string }[] {
  const { candidate } = input;
  const q = candidate.question;
  const row = {
    kind: q.kind,
    prompt_md: q.prompt_md,
    reference_md: q.reference_md,
    choices_md: q.choices_md ?? null,
    source: 'web_sourced',
    source_ref: q.source_url,
    metadata: webSourcedMetadata({
      url: q.source_url,
      title: q.source_title,
      extract: q.extract,
      fetched_at: new Date().toISOString(),
      whitelist_match: matchesWhitelist(
        q.source_url,
        input.subject_id
          ? [...(resolveSubjectProfile(input.subject_id).sourceWhitelist ?? [])]
          : [],
      ),
      extraction_hash: candidate.extraction_hash,
    }),
  };
  // Project typed options for checks without changing the fetch-bound candidate.
  const declaredChoiceRows = q.parts?.flatMap((part) =>
    part.units.flatMap((unit) =>
      unit.response_spec.kind === 'select'
        ? [
            {
              ...row,
              kind: 'choice',
              choices_md: unit.response_spec.items.map((item) => item.label_md ?? item.item_id),
            },
          ]
        : [],
    ),
  );
  const checks = [
    ...(declaredChoiceRows?.length ? declaredChoiceRows : [row]).map(checkStructureCompleteness),
    ...(input.source_route === 'sourcing_web' ? [checkSourceConsistency(row)] : []),
  ];
  const issues: { code: string; detail: string }[] = checks
    .filter((check) => check.verdict === 'fail')
    .map((check) => ({ code: check.check, detail: check.reason }));
  if ((candidate.image_refs?.length ?? 0) > 0 && (!candidate.figures || !candidate.structured)) {
    issues.push({
      code: 'figure_incomplete',
      detail: 'Image candidates need figures and structured bindings',
    });
  }
  return issues;
}

/** Only the preparer must prove candidate identity against this run's real fetch receipt. */
export async function questionPreparerCandidateBindingIssue(
  ctx: Pick<ToolContext, 'db' | 'taskRunId' | 'logTaskRunId'> & {
    callerActor?: ToolContext['callerActor'];
  },
  input: {
    source_route: 'sourcing_web' | 'jyeoo_fetch';
    candidate: {
      candidate_id: string;
      extraction_hash: string;
      question: SourcedQuestionT;
    };
  },
): Promise<{ code: string; detail: string } | null> {
  if (ctx.callerActor?.ref.replace(/^agent:/, '') !== 'question_preparer') return null;
  const fetched = await ctx.db
    .select()
    .from(tool_call_log)
    .where(eq(tool_call_log.task_run_id, ctx.logTaskRunId ?? ctx.taskRunId));
  const expectedTool =
    input.source_route === 'sourcing_web' ? 'web_fetch_candidates' : 'jyeoo_fetch_candidates';
  const bound = fetched.some((call) => {
    if (!call.tool_name.endsWith(expectedTool) || call.error_reason) return false;
    const payload = z
      .object({
        candidates: z.array(
          z.object({
            candidate_id: z.string(),
            extraction_hash: z.string(),
            question: SourcedQuestion,
          }),
        ),
      })
      .safeParse(call.output_json);
    return (
      payload.success &&
      payload.data.candidates.some(
        (item) =>
          item.candidate_id === input.candidate.candidate_id &&
          item.extraction_hash === input.candidate.extraction_hash &&
          item.question.source_url === input.candidate.question.source_url &&
          isDeepStrictEqual(item.question, input.candidate.question),
      )
    );
  });
  return bound
    ? null
    : {
        code: 'candidate_fetch_binding_missing',
        detail:
          'Submit an unchanged candidate from this run’s fetch (id, hash, URL and content); edits use a draft',
      };
}
