import { tasks } from '@/ai/registry';
import {
  type InterventionAuthoringContextT,
  loadInterventionAuthoringContext,
} from '@/capabilities/agency/public';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/public';
import { evaluateConjectureProbeResponseStructure } from '@/core/schema/business';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionPackage,
  InterventionPackageModelOutput,
  type InterventionPackageModelOutputT,
  InterventionPackageReviewAudit,
  type InterventionPackageReviewAuditT,
  InterventionPackageReviewModelOutput,
  type InterventionPackageReviewModelOutputT,
  type InterventionPackageT,
  InterventionPreparationAttempt,
  type InterventionPreparationAttemptT,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';

export interface InterventionAuthorDeps {
  runTaskFn?: TaskTextRunFn;
  attempt?: 1 | 2;
}

const authorOutputSchema = tasks.InterventionPackageAuthorTask.structuredOutputSchema;
const AUTHOR_OUTPUT_FORMAT = authorOutputSchema
  ? zodToJsonSchemaOutputFormat(authorOutputSchema)
  : undefined;
const reviewOutputSchema = tasks.InterventionPackageReviewTask.structuredOutputSchema;
const REVIEW_OUTPUT_FORMAT = reviewOutputSchema
  ? zodToJsonSchemaOutputFormat(reviewOutputSchema)
  : undefined;

function parseTaskOutput<T>(
  result: TaskTextResult,
  label: string,
  parse: (value: unknown) => T,
): T {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return parse(result.structured_output);
  }
  const extracted = parseJsonObjectLoose(result.text, label, { riskyRepair: 'reject' });
  if (!extracted) throw new Error(`${label} did not contain a JSON object`);
  return parse(extracted.json);
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function answerLeaks(prompt: string, answer: string): boolean {
  const normalizedAnswer = normalizeIdentity(answer);
  // Very short tokens occur frequently in prose, so substring matching would
  // produce excessive false positives. Their leakage remains a reviewer check.
  if (normalizedAnswer.length < 3) return false;
  return normalizeIdentity(prompt).includes(normalizedAnswer);
}

export function validateInterventionPackageDeterministically(
  context: InterventionAuthoringContextT,
  packageValue: InterventionPackageT,
): string[] {
  const failures: string[] = [];
  if (
    packageValue.intervention_id !== context.snapshot.intervention_id ||
    packageValue.intervention_version !== context.snapshot.intervention_version
  ) {
    failures.push('lineage_mismatch');
  }
  if (
    packageValue.method_id !== context.recommendation.method_id ||
    packageValue.method_definition_version !== context.recommendation.method_definition_version
  ) {
    failures.push('method_mismatch');
  }

  const diagnostics = [
    packageValue.diagnostics.immediate,
    packageValue.diagnostics.delayed,
    packageValue.diagnostics.transfer,
  ];
  const promptIdentities = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.tested_claim_md !== context.snapshot.conjecture.claim_md) {
      failures.push(`${diagnostic.kind}:tested_claim_mismatch`);
    }
    if (diagnostic.target_error_rule_md !== context.snapshot.conjecture.target_error_rule_md) {
      failures.push(`${diagnostic.kind}:target_error_mismatch`);
    }
    const probeSpec = diagnostic.probe_spec;
    const promptIdentity = normalizeIdentity(probeSpec.prompt_md);
    if (promptIdentities.has(promptIdentity)) failures.push(`${diagnostic.kind}:duplicate_prompt`);
    promptIdentities.add(promptIdentity);
    for (const code of evaluateConjectureProbeResponseStructure(probeSpec)) {
      failures.push(`${diagnostic.kind}:${code}`);
    }
    if (
      answerLeaks(probeSpec.prompt_md, probeSpec.reference_md) ||
      answerLeaks(probeSpec.prompt_md, probeSpec.expected_target_error_answer_md)
    ) {
      failures.push(`${diagnostic.kind}:answer_leak`);
    }
  }
  if (!packageValue.diagnostics.transfer.context_change_md.trim()) {
    failures.push('transfer:context_change_missing');
  }
  return [...new Set(failures)].sort();
}

async function runPackageAuthor(
  runTaskFn: TaskTextRunFn,
  context: InterventionAuthoringContextT,
  subjectProfile: Awaited<ReturnType<typeof resolveSubjectProfileForKnowledgeIds>>,
): Promise<
  | { status: 'ok'; package: InterventionPackageT }
  | { status: 'invalid'; taskRunId?: string; failureCode: string }
> {
  const result = await runTaskFn(
    'InterventionPackageAuthorTask',
    {
      snapshot: context.snapshot,
      recommendation: context.recommendation,
      output_contract: {
        material_count: 1,
        diagnostic_kinds: ['immediate', 'delayed', 'transfer'],
        tested_claim_md: context.snapshot.conjecture.claim_md,
        target_error_rule_md: context.snapshot.conjecture.target_error_rule_md,
      },
    },
    {
      subjectProfile,
      ...(AUTHOR_OUTPUT_FORMAT ? { outputFormat: AUTHOR_OUTPUT_FORMAT } : {}),
    },
  );
  if (!result.task_run_id) {
    return { status: 'invalid', failureCode: 'author_task_run_id_missing' };
  }

  let draft: InterventionPackageModelOutputT;
  try {
    draft = parseTaskOutput(result, 'intervention package author', (value) =>
      InterventionPackageModelOutput.parse(value),
    );
  } catch {
    return {
      status: 'invalid',
      taskRunId: result.task_run_id,
      failureCode: 'author_output_invalid',
    };
  }
  return {
    status: 'ok',
    package: InterventionPackage.parse({
      ...draft,
      intervention_id: context.snapshot.intervention_id,
      intervention_version: context.snapshot.intervention_version,
      package_version: INTERVENTION_CONTRACT_VERSION,
      method_id: context.recommendation.method_id,
      method_definition_version: context.recommendation.method_definition_version,
      author_task_run_id: result.task_run_id,
    }),
  };
}

async function runPackageReview(
  runTaskFn: TaskTextRunFn,
  context: InterventionAuthoringContextT,
  packageValue: InterventionPackageT,
  subjectProfile: Awaited<ReturnType<typeof resolveSubjectProfileForKnowledgeIds>>,
): Promise<
  | { status: 'ok'; review: InterventionPackageReviewAuditT }
  | { status: 'invalid'; failureCode: string }
> {
  const result = await runTaskFn(
    'InterventionPackageReviewTask',
    {
      snapshot: context.snapshot,
      recommendation: context.recommendation,
      package: packageValue,
    },
    {
      subjectProfile,
      ...(REVIEW_OUTPUT_FORMAT ? { outputFormat: REVIEW_OUTPUT_FORMAT } : {}),
    },
  );
  if (!result.task_run_id) {
    return { status: 'invalid', failureCode: 'review_task_run_id_missing' };
  }

  let review: InterventionPackageReviewModelOutputT;
  try {
    review = parseTaskOutput(result, 'intervention package review', (value) =>
      InterventionPackageReviewModelOutput.parse(value),
    );
  } catch {
    review = InterventionPackageReviewModelOutput.parse({
      verdict: 'fail',
      failure_codes: ['review_output_invalid'],
      summary_md: 'Review output failed structured-output validation.',
    });
  }
  return {
    status: 'ok',
    review: InterventionPackageReviewAudit.parse({
      review_version: INTERVENTION_CONTRACT_VERSION,
      package_digest_sha256: sha256CanonicalJson(packageValue),
      review_task_run_id: result.task_run_id,
      result: review,
    }),
  };
}

/**
 * Intervention-scoped QuestionAuthor public entry.
 *
 * The only domain identifier supplied by the caller is `interventionId`.
 * Snapshot and recommendation are hydrated from Agency's public reader; raw
 * claim/evidence/method/package inputs cannot bypass authoritative lineage.
 */
export async function authorInterventionPackage(
  db: Db,
  interventionId: string,
  deps: InterventionAuthorDeps = {},
): Promise<InterventionPreparationAttemptT> {
  const attempt = deps.attempt ?? 1;
  const context = await loadInterventionAuthoringContext(db, interventionId);
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, [
    context.snapshot.conjecture.knowledge_id,
  ]);
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);

  const authored = await runPackageAuthor(runTaskFn, context, subjectProfile);
  if (authored.status === 'invalid') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      ...(authored.taskRunId ? { author_task_run_id: authored.taskRunId } : {}),
      failure_code: authored.failureCode,
    });
  }

  // Same provider/model route as the author task, but a separate task invocation
  // and task_run_id: this is the owner-selected independent same-model self-review.
  const reviewed = await runPackageReview(runTaskFn, context, authored.package, subjectProfile);
  if (reviewed.status === 'invalid') {
    return InterventionPreparationAttempt.parse({
      kind: 'author_failed',
      attempt,
      author_task_run_id: authored.package.author_task_run_id,
      failure_code: reviewed.failureCode,
    });
  }
  const deterministicFailures = validateInterventionPackageDeterministically(
    context,
    authored.package,
  );
  return InterventionPreparationAttempt.parse({
    kind: 'reviewed_package',
    attempt,
    package: authored.package,
    review: reviewed.review,
    deterministic_failure_codes: deterministicFailures,
  });
}
