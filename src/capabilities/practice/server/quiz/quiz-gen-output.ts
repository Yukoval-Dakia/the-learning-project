// Validates generated quiz output before the job checks its accepted plan or persists rows.
import { parseJsonObjectLoose } from '@/core/json-extract';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import { QuizGenOutput, type QuizGenOutputT } from '@/core/schema/quiz_gen';
import type { SubjectProfile } from '@/subjects/profile';
import { assertGeneratedQuestionHasJudgeContract } from '../judge/question-contract';
import {
  type PlacementStarterFailure,
  placementSchemaFailure,
} from '../question-supply/placement-starter-outcome';

// §2 / §5 — output JSON parse + judge-contract assertion. The gate itself is
// the SHARED assertGeneratedQuestionHasJudgeContract (question-contract.ts) —
// extracted for YUK-308 so the question_draft author flow enforces the same
// contract; output validation failures retain sanitized schema paths and codes.
// YUK-996 — `subjectProfile` is the run's resolved profile (same value threaded
// to the QuizGenTask call ctx): the judge contract resolves the route the
// runtime invoker will dispatch for the PERSISTED row.
export class QuizGenOutputFailure extends Error {
  constructor(readonly reason: PlacementStarterFailure) {
    super(`parseOutput: ${reason.code}: ${JSON.stringify(reason)}`);
  }
}

export function parseOutput(
  text: string,
  subjectProfile: SubjectProfile,
): { parsed: QuizGenOutputT; parseRepaired: boolean } {
  // YUK-607 — 宽松提取（jsonrepair 修复带）：mimo 对长中文字符串题型（阅读理解材料）常产出
  // 字符串值内未转义引号的 JSON，旧硬解析在此整批阵亡。
  let extracted: ReturnType<typeof parseJsonObjectLoose>;
  try {
    extracted = parseJsonObjectLoose(text, 'quiz_gen parseOutput');
  } catch {
    throw new QuizGenOutputFailure({ code: 'json_invalid' });
  }
  if (extracted === null) {
    throw new QuizGenOutputFailure({ code: 'json_object_missing' });
  }
  const json: unknown = extracted.json;
  const parsed = QuizGenOutput.safeParse(json);
  if (!parsed.success) {
    throw new QuizGenOutputFailure(placementSchemaFailure(parsed.error.issues));
  }
  for (const q of parsed.data.questions) {
    // The INSERT below persists judge_kind_override = defaultJudgeKindForQuestion(q)
    // (never null), which short-circuits the runtime resolver to that pinned
    // value — so the contract asserts on the persisted shape, not the raw model
    // output (a missing model-declared override must NOT fall through to the
    // profile ladder here; at judge time it won't).
    // YUK-1011 — a composite item (structured stem+subs) persists with a FORCED
    // 'semantic' override and choices_md=null (the whole-composite answer is
    // semantically graded against the merged reference; per-sub options live in
    // the tree, not the column). Assert on THAT persisted shape so a composite
    // without rubric_json.required_points is rejected before any insert.
    const isComposite = q.structured != null;
    assertGeneratedQuestionHasJudgeContract(
      {
        ...q,
        judge_kind_override: isComposite ? 'semantic' : defaultJudgeKindForQuestion(q),
        choices_md: isComposite ? null : q.choices_md,
      },
      'quiz_gen',
      subjectProfile,
    );
  }
  // jsonrepair 级修复 = 内容完整性无法机证 → 上抛给 metadata（quiz_verify 晋级门隔离）。
  return { parsed: parsed.data, parseRepaired: extracted.repaired === 'jsonrepair' };
}
