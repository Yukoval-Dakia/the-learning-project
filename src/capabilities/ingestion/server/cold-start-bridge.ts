/**
 * ColdStartPlacementBridgeTask invoker — YUK-478 (cold-start upload→placement bridge).
 *
 * Single-shot structured-output AI task (NOT multimodal — the question is already
 * text by the time the VLM has extracted it). Mirrors the `runTaggingTask`
 * invoker pattern: an injectable `runTaskFn` seam (so DB tests stub the model),
 * strict-JSON parse + Zod validation, and an anti-hallucination check that the
 * returned `subject_id` is the `id` of one of the supplied `known_subjects`.
 *
 * Called from the image-candidate accept path (src/.../image-candidate-accept.ts)
 * ONLY when the sourcing-resolved knowledge_ids are empty — i.e. the uploaded
 * question matched no node on the thin-seed tree (YUK-477). It returns the subject
 * to root a new child KC under (bridge ①) + a reference answer for the prompt
 * (bridge ③), in one LLM pass.
 */
import {
  ColdStartBridgeInput,
  type ColdStartBridgeInputT,
  ColdStartBridgeOutput,
  type ColdStartBridgeOutputT,
} from '@/core/schema/cold-start-bridge';
import type { Db } from '@/db/client';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';

/** Thrown when the bridge cannot produce a usable result (provider down, unparseable, or out-of-vocabulary subject). */
export class ColdStartBridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ColdStartBridgeError';
  }
}

export type ColdStartBridgeRunTaskFn = (
  kind: string,
  input: ColdStartBridgeInputT,
  ctx: unknown,
) => Promise<{ text: string }>;

export interface RunColdStartBridgeParams {
  db: Db;
  /** The VLM-extracted question prompt (block.extracted_prompt_md). */
  questionMd: string;
  /** The reference answer OCR already extracted, or null when OCR got only the prompt. */
  existingReferenceMd: string | null;
  /** Soft topic hint from extraction (block.knowledge_hint), or null. */
  knowledgeHint: string | null;
  /** 闭集分类词表（YUK-600：对象数组——display_name 分类、id 原样回传；活 registry 取数）。 */
  knownSubjects: ReadonlyArray<{ id: string; display_name: string; aliases?: string[] }>;
  /** Inject in tests; defaults to the production runner. */
  runTaskFn?: ColdStartBridgeRunTaskFn;
  /** Forwarded to runTask ctx (db / subjectProfile). */
  ctx?: unknown;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new ColdStartBridgeError(
      'ColdStartPlacementBridgeTask output did not contain a JSON object',
    );
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new ColdStartBridgeError('ColdStartPlacementBridgeTask output was not valid JSON', {
      cause: err,
    });
  }
}

/**
 * Runs the ColdStartPlacementBridgeTask. Returns a validated output whose
 * `subject_id` is GUARANTEED to be one of `knownSubjects` (an out-of-vocabulary
 * pick throws `ColdStartBridgeError` — never silently coerced, since a wrong
 * subject mis-roots the child KC). On provider failure / unparseable output throws
 * `ColdStartBridgeError` so the accept path can decide whether to persist anyway.
 */
export async function runColdStartBridge(
  params: RunColdStartBridgeParams,
): Promise<ColdStartBridgeOutputT> {
  const knownSubjects = Array.from(params.knownSubjects);
  const input: ColdStartBridgeInputT = ColdStartBridgeInput.parse({
    question_md: params.questionMd,
    existing_reference_md: params.existingReferenceMd,
    knowledge_hint: params.knowledgeHint,
    known_subjects: [...knownSubjects],
  });

  const runTaskFn = params.runTaskFn ?? makeRunTaskTextFn(params.db);
  let llmText: string;
  try {
    const result = await runTaskFn('ColdStartPlacementBridgeTask', input, params.ctx ?? {});
    llmText = result.text;
  } catch (err) {
    throw new ColdStartBridgeError('ColdStartPlacementBridgeTask LLM call failed', { cause: err });
  }

  let parsed: ColdStartBridgeOutputT;
  try {
    parsed = ColdStartBridgeOutput.parse(extractJsonObject(llmText));
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

  return parsed;
}
