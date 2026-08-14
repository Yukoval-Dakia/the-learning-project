import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import {
  ColdStartBridgeOutput,
  type ColdStartBridgeOutputT,
} from '@/core/schema/cold-start-bridge';
import { parseTaskJsonObject } from './parse-json';

export class ColdStartBridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ColdStartBridgeError';
  }
}

export function parseColdStartBridgeOutput(text: string): ColdStartBridgeOutputT {
  return ColdStartBridgeOutput.parse(
    parseTaskJsonObject(
      text,
      'ColdStartPlacementBridgeTask',
      (message, cause) =>
        new ColdStartBridgeError(message, cause === undefined ? undefined : { cause }),
    ),
  );
}

const COLD_START_BRIDGE_PROMPT =
  'You are a cold-start placement bridge for a personal learning tool. You are given ONE question that a learner uploaded, plus the closed list of subjects the tool supports. Do THREE things in a single strict-JSON reply.\n\nINPUT (a JSON object): `question_md` (the question prompt text), `existing_reference_md` (the reference answer already extracted from the image, or null), `knowledge_hint` (a soft topic hint or null), and `known_subjects` (the ONLY subjects you may pick from). Each `known_subjects` entry is an object: `id` (an OPAQUE identifier to copy back — it may be a readable slug like "yuwen" or a meaningless token like "subj_x3k9q"; NEVER read meaning into it, never interpret or transform it), `display_name` (the human-facing subject name — classify by THIS), and optionally `aliases` (alternate names for the same subject).\n\nTASK 1 — CLASSIFY SUBJECT: pick the ONE `known_subjects` en' +
  'try whose `display_name` (or `aliases`) best fits the question, and return that entry\'s `id` copied back VERBATIM as `subject_id`. Judge the fit by `display_name`/`aliases` only, never by the id text. Never invent an id, never return one outside the list. If genuinely ambiguous, pick the closest fit.\n\nTASK 2 — NAME THE CONCEPT: write `kc_name`, a concise knowledge-concept label (a topic/skill name, at most ~60 characters) describing what the question tests. This is a category name (e.g. "二次函数求根" / "Newton\'s second law" / "虚词「之」的用法"), NOT a restatement of the question and NOT the answer.\n\nTASK 3 — REFERENCE ANSWER: produce `reference_md`, the correct reference answer for `question_md`. If `existing_reference_md` is non-null, ECHO it back unchanged (do not regenerate or "improve" it). If it is null, SOLVE the question yourself and give the correct, concise answer (include the key working o' +
  'nly when it is essential to justify the answer). If you truly cannot answer, return an empty string for `reference_md`.\n\nOUTPUT: strict JSON only, exactly these four keys and nothing else: `subject_id` (an `id` copied verbatim from `known_subjects`), `kc_name` (string), `reference_md` (string), `reasoning` (a one-sentence justification). No markdown fences, no prose outside the JSON.';

export const coldStartPlacementBridgeTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'ColdStartPlacementBridgeTask',
    description:
      'YUK-478 — cold-start upload→placement bridge. Runs ONCE per uploaded question whose VLM extraction matched NO knowledge node (the thin-seed tree from YUK-477 has only subject roots, so TaggingTask drops every suggestion). COMBINES two bridges in ONE text-only structured call: (①) classify the question into one KNOWN_SUBJECT_ID so a child KC can be created under seed:<subjectId>:root, and (③) generate a correct reference answer FOR the existing prompt when OCR extracted no answer, so the judge has a real grading anchor. Output = { subject_id, kc_name, reference_md }.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'inline', text: COLD_START_BRIDGE_PROMPT },
  },
  outputSchema: ColdStartBridgeOutput,
  parseText: parseColdStartBridgeOutput,
} satisfies TaskSpec<unknown, ColdStartBridgeOutputT>;
