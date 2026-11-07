// Background solution-method annotation for one ingested question.
//
// Deliberately receives only the prompt/kind/knowledge label — never reference_md —
// so the annotation cannot become an answer key. Parse and provider failures throw;
// the caller counts a bounded attempt and the row stays unannotated for retry.
//
// AI-boundary privacy: the prompt is redacted by the ingestion privacy guard before
// it leaves the server, the send is bound to the source document's live derivation
// policy (restricted documents are never sent), and every attempted send writes an
// ingestion usage receipt recording policy + fired redaction categories — never
// values — under the document/session keys a consent withdrawal already filters.
import { eq } from 'drizzle-orm';
import type { TaskTextResult } from '@/ai/task-result';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import {
  SOLUTION_ANNOTATION_CONTRACT,
  SolutionAnnotationOutput,
  type SolutionAnnotationOutputT,
  type StoredSolutionAnnotationT,
} from '@/core/schema/solution-annotation';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';
import { parseTaskOutput } from '@/kernel/parse-task-output';
import {
  resolveDocumentDerivationPolicy,
  resolveSessionDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import { markAiTaskRunOutputInvalid } from '@/server/ai/log';
import { type RunTaskCallCtx, makeRunTaskTextFn } from '@/server/ai/runner-fn';
import {
  IngestionUsagePolicyError,
  redactIngestionText,
  writeIngestionUsageReceipt,
} from './privacy-guard';

export class SolutionAnnotationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SolutionAnnotationError';
  }
}

/**
 * Thrown before anything is sent when the resolved derivation policy forbids
 * model use — or no session/document anchor exists to resolve one (fail closed).
 */
export class SolutionAnnotationPolicyError extends IngestionUsagePolicyError {
  constructor(policy: DerivationPolicyT | 'unresolvable') {
    super(policy);
    this.name = 'SolutionAnnotationPolicyError';
  }
}

export type SolutionAnnotationRunTaskFn = (
  kind: string,
  input: unknown,
  ctx?: RunTaskCallCtx,
) => Promise<TaskTextResult>;

export interface GenerateSolutionAnnotationParams {
  db: Db;
  promptMd: string;
  kind: string;
  /** First attributed knowledge name, or null when the question is still unlabelled. */
  knowledgeLabel: string | null;
  /**
   * The question's bound ingestion session and source document. Session resolves
   * policy first; document is the fallback anchor; when neither resolves the
   * send is refused (fail closed). The usage receipt anchors on whichever ids
   * exist — a doc-less session send proceeds under that session's resolved
   * policy but leaves no receipt.
   */
  usage?: { sessionId: string | null; sourceDocumentId: string | null };
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: SolutionAnnotationRunTaskFn;
  ctx?: RunTaskCallCtx;
}

export async function generateSolutionAnnotation(
  params: GenerateSolutionAnnotationParams,
): Promise<StoredSolutionAnnotationT & { cost_usd?: number }> {
  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db);

  // Policy first, fail closed: session → document → no anchor at all means
  // nothing can prove this send is allowed, so it does not happen. Resolution
  // happens per call so a consent change takes effect on the very next attempt.
  const sessionId = params.usage?.sessionId ?? null;
  const sourceDocumentId = params.usage?.sourceDocumentId ?? null;
  const derivationPolicy =
    sessionId !== null
      ? await resolveSessionDerivationPolicy(params.db, sessionId)
      : sourceDocumentId !== null
        ? await resolveDocumentDerivationPolicy(params.db, sourceDocumentId)
        : 'unresolvable';
  if (derivationPolicy !== 'allow') {
    throw new SolutionAnnotationPolicyError(derivationPolicy);
  }

  // Deterministic redaction at the boundary; the stored prompt is never sent raw.
  const redacted = redactIngestionText(params.promptMd);
  const recordUsage = async () => {
    if (sessionId === null || sourceDocumentId === null) return;
    try {
      await writeIngestionUsageReceipt(params.db, {
        sourceDocumentId,
        sessionId,
        derivationPolicy,
        engine: 'ingestion_solution_annotation',
        redactedFields: redacted.fields,
        redactionCounts: redacted.counts,
        channels: { page_images: 'none', extracted_text: 'redacted' },
      });
    } catch (err) {
      // The send is already recorded in ai_task_runs; losing the receipt is an
      // observability gap, not a reason to burn a second paid call on retry.
      console.error('[solution_annotation] usage receipt write failed', err);
    }
  };

  let text: string;
  let taskRunId: string | undefined;
  let costUsd: number | undefined;
  try {
    const result = await runTaskFn(
      'IngestionSolutionAnnotationTask',
      {
        prompt_md: redacted.text,
        kind: params.kind,
        knowledge_label: params.knowledgeLabel,
      },
      params.ctx,
    );
    text = result.text;
    taskRunId = result.task_run_id;
    costUsd = result.cost_usd;
    await recordUsage();
  } catch (err) {
    // An attempted send is usage too: receipt first, then the failure surfaces.
    await recordUsage();
    throw new SolutionAnnotationError('IngestionSolutionAnnotationTask LLM call failed', {
      cause: err,
    });
  }

  let parsed: SolutionAnnotationOutputT;
  try {
    parsed = parseTaskOutput(text, 'IngestionSolutionAnnotationTask', SolutionAnnotationOutput);
  } catch (err) {
    if (taskRunId !== undefined) {
      try {
        await markAiTaskRunOutputInvalid(
          params.db,
          taskRunId,
          err instanceof Error ? err.message : String(err),
        );
      } catch (markErr) {
        console.error('[solution_annotation] failed to mark invalid task output', markErr);
      }
    }
    throw new SolutionAnnotationError(
      'IngestionSolutionAnnotationTask output did not match SolutionAnnotationOutput schema',
      { cause: err },
    );
  }

  const facts = await runFacts(params.db, taskRunId);
  return {
    ...parsed,
    contract: SOLUTION_ANNOTATION_CONTRACT,
    task_run_id: taskRunId ?? null,
    provider: facts.provider,
    model: facts.model,
    generated_at: new Date().toISOString(),
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
  };
}

async function runFacts(
  db: Db,
  taskRunId: string | undefined,
): Promise<{ provider: string; model: string }> {
  if (taskRunId === undefined) return { provider: 'unknown', model: 'unknown' };
  try {
    const [row] = await db
      .select({ provider: ai_task_runs.provider, model: ai_task_runs.model })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId))
      .limit(1);
    return { provider: row?.provider ?? 'unknown', model: row?.model ?? 'unknown' };
  } catch {
    return { provider: 'unknown', model: 'unknown' };
  }
}
