// YUK-573 (MF1) — judge-golden CAPTURE: turn production calibration
// observations into leg A fixture SKELETONS for the owner to desensitize.
//
// SOURCE (r2 定源，MF1): `experimental:judge_calibration_sample` events. The
// pre-existing tables hold NO raw judge LLM output (ai_task_runs stores only
// input_hash; the three judge tasks produce zero tool_call_log rows; judge
// event payloads are post-normalization) — the calibration sampling job is
// the FIRST writer of raw output text (`payload.rejudge_raw_output`), so it
// doubles as the golden material source. The frozen text comes from the
// RE-JUDGE lane, which is legitimate fixture material because the replay
// target (parse/normalize/dispatch) is lane-agnostic.
//
// OWNER-RUN, OUTPUT NEVER COMMITTED AS-IS: the printed skeletons contain REAL
// production text (prompts / answers / model output). Desensitize by hand —
// keep the structural quirks (prose wrapping, missing fields), replace the
// content — then hand-place the case into scripts/judge-golden/*.json and run
// `pnpm audit:judge-golden` to verify it replays CLEAN.
//
// CLI (owner, against prod / prod-clone):
//   pnpm capture:judge-golden [--limit=20]
//
// db is imported LAZILY inside main() (after ./load-env) so the module's
// top-level exports stay pure — the mapper unit test never touches @/db/client.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JudgeQuestionRow } from '@/server/ai/judges/question-contract';

export interface CaptureCandidate {
  samplePayload: {
    original_outcome: string;
    rejudge_outcome: string;
    rejudge_route: string;
    rejudge_confidence: number;
    rejudge_raw_output: string | null;
    original_judge_event_id: string;
    question_id: string;
    answer_event_id: string;
  };
  question: JudgeQuestionRow;
  answerPayload: Record<string, unknown>;
}

export interface JudgeGoldenCaseSkeleton {
  id: string;
  description: string;
  question: JudgeQuestionRow;
  answer_md: string;
  student_image_refs: string[];
  subject_profile_id: string;
  frozen_llm_output: string;
  expected: { route: string; coarse_outcome: string; confidence: number };
}

/**
 * Pure mapper: one calibration observation → one fixture-case skeleton.
 * Returns null when the row carries no raw output (accelerator path — nothing
 * to freeze). `expected` pins the RE-JUDGE verdict: the replay must reproduce
 * what the frozen raw text normalizes to, not the original judgment.
 */
export function candidateToFixtureSkeleton(c: CaptureCandidate): JudgeGoldenCaseSkeleton | null {
  const raw = c.samplePayload.rejudge_raw_output;
  if (!raw) return null;
  const answerMd =
    (typeof c.answerPayload.answer_md === 'string' && c.answerPayload.answer_md) ||
    (typeof c.answerPayload.user_response_md === 'string' && c.answerPayload.user_response_md) ||
    '';
  const imageRefs = Array.isArray(c.answerPayload.answer_image_refs)
    ? (c.answerPayload.answer_image_refs as string[])
    : [];
  return {
    id: `DESENSITIZE-${c.samplePayload.rejudge_route}-${c.samplePayload.original_judge_event_id}`,
    description:
      'DESENSITIZE: 逐字段替换真实内容（保留结构 quirk），再挑入 scripts/judge-golden/*.json',
    question: {
      ...c.question,
      // Force the route the frozen output was produced under — the replayed
      // case must not drift to a different judge than the raw text targets.
      judge_kind_override: c.samplePayload.rejudge_route,
    },
    answer_md: answerMd,
    student_image_refs: imageRefs,
    subject_profile_id: 'DESENSITIZE: 填 registry profile id（wenyan/math/physics/general）',
    frozen_llm_output: raw,
    expected: {
      route: c.samplePayload.rejudge_route,
      coarse_outcome: c.samplePayload.rejudge_outcome,
      confidence: c.samplePayload.rejudge_confidence,
    },
  };
}

function parseLimit(): number {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  const n = Number.parseInt(arg?.slice('--limit='.length) ?? '', 10);
  return Number.isNaN(n) ? 20 : Math.min(200, Math.max(1, n));
}

async function main(): Promise<void> {
  // Lazy env + db (capture-golden.ts load-env precedent, but deferred so the
  // module top-level stays pure for the mapper unit test).
  await import('./load-env');
  const { db } = await import('@/db/client');
  const { event, question } = await import('@/db/schema');
  const { desc, eq, sql } = await import('drizzle-orm');

  const limit = parseLimit();
  const sampleRows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      sql`${event.action} = 'experimental:judge_calibration_sample' AND ${event.payload}->>'rejudge_raw_output' IS NOT NULL`,
    )
    .orderBy(desc(event.created_at))
    .limit(limit);

  const skeletons: JudgeGoldenCaseSkeleton[] = [];
  for (const row of sampleRows) {
    const p = row.payload as CaptureCandidate['samplePayload'];
    const [q] = await db.select().from(question).where(eq(question.id, p.question_id));
    if (!q) continue;
    const [answerEvent] = await db.select().from(event).where(eq(event.id, p.answer_event_id));
    if (!answerEvent) continue;
    const skeleton = candidateToFixtureSkeleton({
      samplePayload: p,
      question: q as unknown as JudgeQuestionRow,
      answerPayload: answerEvent.payload as Record<string, unknown>,
    });
    if (skeleton) skeletons.push(skeleton);
  }

  console.log(
    [
      '════════════════════════════════════════════════════════════════════════',
      '⚠️  DESENSITIZE BEFORE COMMIT — the skeletons below contain REAL production',
      '   prompts / answers / model output. Replace content field-by-field (keep',
      '   structural quirks), fill subject_profile_id, then hand-place into',
      '   scripts/judge-golden/*.json and verify with `pnpm audit:judge-golden`.',
      '   NEVER commit this output as-is.',
      '════════════════════════════════════════════════════════════════════════',
    ].join('\n'),
  );
  console.log(JSON.stringify({ version: 1, cases: skeletons }, null, 2));
  console.log(`\n[capture-judge-golden] ${skeletons.length} skeleton(s) from ${limit} row(s).`);
}

// CLI-gate (capture-golden.ts precedent): only run as the entry point so tests can import.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[capture-judge-golden] failed:', err);
      process.exit(1);
    });
}
