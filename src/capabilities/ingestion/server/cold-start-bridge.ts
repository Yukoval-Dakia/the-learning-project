import type { TaskTextResult } from '@/ai/task-result';
import {
  ColdStartBridgeError,
  parseColdStartBridgeOutput,
} from '@/capabilities/ingestion/tasks/cold-start-bridge';
/**
 * Cold-start placement bridge: a single-shot, text-only structured task with an
 * injectable runner and strict JSON/Zod parsing. The returned subject_id must be
 * one of the supplied known subjects. It runs only when sourced knowledge_ids are
 * empty, returning both the subject root for a new child KC and a reference answer.
 */
import {
  ColdStartBridgeInput,
  type ColdStartBridgeInputT,
  type ColdStartBridgeOutputT,
} from '@/core/schema/cold-start-bridge';
import type { Db } from '@/db/client';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { redactIngestionText } from './privacy-guard';

/** Thrown when the bridge cannot produce a usable result (provider down, unparseable, or out-of-vocabulary subject). */
export { ColdStartBridgeError };

export type ColdStartBridgeRunTaskFn = (
  kind: string,
  input: ColdStartBridgeInputT,
  ctx: unknown,
) => Promise<TaskTextResult>;

export interface RunColdStartBridgeParams {
  db: Db;
  /** The VLM-extracted question prompt (block.extracted_prompt_md). */
  questionMd: string;
  /** The reference answer OCR already extracted, or null when OCR got only the prompt. */
  existingReferenceMd: string | null;
  /** Soft topic hint from extraction (block.knowledge_hint), or null. */
  knowledgeHint: string | null;
  /** Closed classification vocabulary from the live registry; ids are returned as-is. */
  knownSubjects: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: ColdStartBridgeRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

/**
 * Runs the ColdStartPlacementBridgeTask. Returns a validated output whose
 * `subject_id` is GUARANTEED to be one of `knownSubjects` (an out-of-vocabulary
 * pick throws `ColdStartBridgeError` — never silently coerced, since a wrong
 * subject mis-roots the child KC). On provider failure / unparseable output throws
 * `ColdStartBridgeError` so the accept path can decide whether to persist anyway.
 */
export type ColdStartBridgeResult = ColdStartBridgeOutputT & {
  /**
   * YUK-1604 — the bridge run's provenance, forwarded so KC naming audit events stay
   * provider/model/revision/cost auditable. Absent when the injected runner is a stub.
   */
  task_run_id?: string;
  cost_usd?: number;
};

export async function runColdStartBridge(
  params: RunColdStartBridgeParams,
): Promise<ColdStartBridgeResult> {
  const knownSubjects = Array.from(params.knownSubjects);
  // Redact text before the model sees it; the closed subject vocabulary is untouched.
  const input: ColdStartBridgeInputT = ColdStartBridgeInput.parse({
    question_md: redactIngestionText(params.questionMd).text,
    existing_reference_md:
      params.existingReferenceMd === null
        ? null
        : redactIngestionText(params.existingReferenceMd).text,
    knowledge_hint:
      params.knowledgeHint === null ? null : redactIngestionText(params.knowledgeHint).text,
    known_subjects: [...knownSubjects],
  });

  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db);
  let llmText: string;
  let taskRunId: string | undefined;
  let costUsd: number | undefined;
  try {
    const result = await runTaskFn('ColdStartPlacementBridgeTask', input, params.ctx ?? {});
    llmText = result.text;
    taskRunId = result.task_run_id;
    costUsd = result.cost_usd;
  } catch (err) {
    throw new ColdStartBridgeError('ColdStartPlacementBridgeTask LLM call failed', { cause: err });
  }

  let parsed: ColdStartBridgeOutputT;
  try {
    parsed = parseColdStartBridgeOutput(llmText);
  } catch (err) {
    if (err instanceof ColdStartBridgeError) throw err;
    throw new ColdStartBridgeError(
      'ColdStartPlacementBridgeTask output did not match ColdStartBridgeOutput schema',
      { cause: err },
    );
  }

  // Anti-hallucination: the subject MUST be one of the supplied known ids. A bad
  // pick would create the child KC under a non-existent / wrong seed root.
  // 闭集校验机制保留：对象数组下按 id 判（display_name 只用于分类不作校验轴）。
  if (!knownSubjects.some((s) => s.id === parsed.subject_id)) {
    throw new ColdStartBridgeError(
      `ColdStartPlacementBridgeTask returned out-of-vocabulary subject_id="${parsed.subject_id}" (allowed: ${knownSubjects.map((s) => s.id).join(', ')})`,
    );
  }

  return {
    ...parsed,
    ...(taskRunId !== undefined ? { task_run_id: taskRunId } : {}),
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
  };
}
