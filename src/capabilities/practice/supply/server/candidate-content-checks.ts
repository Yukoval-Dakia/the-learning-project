import type { SourcedQuestionT } from '@/core/schema/sourcing';
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
    metadata: {
      web_sourced: {
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
      },
    },
  };
  const checks = [
    checkStructureCompleteness(row),
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
