// scripts/sanity-vision-rejudge.ts
/**
 * Sanity check: 同一道 derivation 题（无图，纯文本步骤）走 runStepsJudge 3 次，
 * 报告 3 个 score 的最大分差。spec §3 M2 #7 exit criteria：< 0.1。
 *
 * 不进 CI 默认套（CI 跑会消耗真实 vision LLM quota）；phase exit 前手动跑：
 *   pnpm tsx scripts/sanity-vision-rejudge.ts
 * 或 pnpm sanity:vision-rejudge
 *
 * Exit codes:
 *   0 — 分差 < 0.1，sanity 通过
 *   1 — 分差 >= 0.1，vision LLM 输出不稳定，phase M2 须停下复核
 *   2 — env 配置缺失 / 调用失败
 *
 * Env required:
 *   XIAOMI_API_KEY  (StepsJudgeTask routes to xiaomi provider)
 *
 * Output: JSON saved to docs/preflight/YYYY-MM-DD-vision-rejudge.json
 * (gitignored; run locally at phase exit, do not commit output).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { loadMathDerivationFixtures } from '../src/subjects/math/fixtures/derivation';
import { runStepsJudge } from '../src/server/ai/judges/steps-judge';
import { resolveSubjectProfile } from '../src/subjects/profile';
import type { JudgeQuestionRow } from '../src/server/ai/judges/question-contract';
import type { Db } from '../src/db/client';

config({ path: '.env' });

const OUT_DIR = resolve(process.cwd(), 'docs/preflight');
const OUT_FILE = resolve(OUT_DIR, `${new Date().toISOString().slice(0, 10)}-vision-rejudge.json`);

async function main() {
  // StepsJudgeTask uses the 'xiaomi' provider (see src/ai/registry.ts).
  // XIAOMI_API_KEY is the required credential; ANTHROPIC_API_KEY is for
  // Anthropic-direct tasks only.
  if (!process.env.XIAOMI_API_KEY) {
    console.error('FAIL: XIAOMI_API_KEY not set in environment');
    console.error('Hint: check .env file — StepsJudgeTask routes to xiaomi provider');
    process.exit(2);
  }

  const fixtures = loadMathDerivationFixtures();
  const fixture = fixtures[0]; // math-derivation-001 (平方差)
  if (!fixture) {
    console.error('FAIL: no derivation fixtures found');
    process.exit(2);
  }

  const judgeRow: JudgeQuestionRow = {
    id: 'sanity-rejudge',
    kind: 'derivation',
    prompt_md: fixture.prompt_md,
    reference_md: fixture.reference_md,
    rubric_json: fixture.rubric_json,
    choices_md: null,
    judge_kind_override: null,
    image_refs: [],
  };

  // Text answer that requires LLM judgment (not in answer_equivalents, so
  // accelerator skipped — exercises full vision LLM path).
  const studentAnswer = '分子写成 (a-b)(a+b)，约去 a-b，得 a+b';
  const mathProfile = resolveSubjectProfile('math');
  // mockDb is only typed; runStepsJudge receives it but the no-image path
  // never dereferences it (image fetch is skipped when image_refs is empty).
  const mockDb = {} as Db;

  const scores: number[] = [];
  const results: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    let result: Awaited<ReturnType<typeof runStepsJudge>>;
    try {
      result = await runStepsJudge({
        db: mockDb,
        question: judgeRow,
        answer_md: studentAnswer,
        subjectProfile: mathProfile,
        imageFetchFn: async () => [], // no images — text-only derivation
      });
    } catch (err) {
      console.error(`FAIL: iteration ${i + 1} threw:`, err);
      process.exit(2);
    }
    results.push({
      iteration: i + 1,
      elapsed_ms: Date.now() - start,
      score: result.score,
      coarse_outcome: result.coarse_outcome,
      confidence: result.confidence,
      evidence_json: result.evidence_json,
    });
    if (typeof result.score === 'number') scores.push(result.score);
    console.log(
      `  [${i + 1}/3] score=${result.score != null ? result.score.toFixed(3) : 'null'} outcome=${result.coarse_outcome} elapsed=${Date.now() - start}ms`,
    );
  }

  const maxDiff =
    scores.length >= 2
      ? Math.max(...scores) - Math.min(...scores)
      : Number.POSITIVE_INFINITY;
  const pass = scores.length >= 2 && maxDiff < 0.1;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        fixture_ref: fixture.ref,
        student_answer: studentAnswer,
        scores,
        max_diff: maxDiff === Number.POSITIVE_INFINITY ? null : maxDiff,
        threshold: 0.1,
        pass,
        runs: results,
      },
      null,
      2,
    ),
  );

  console.log(`\nSanity rejudge: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`Scores: ${scores.map((s) => s.toFixed(3)).join(' / ')}`);
  console.log(
    `Max diff: ${maxDiff === Number.POSITIVE_INFINITY ? 'n/a (< 2 numeric scores)' : maxDiff.toFixed(3)} (threshold 0.1)`,
  );
  console.log(`Saved: ${OUT_FILE}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Sanity rejudge crashed:', err);
  process.exit(2);
});
