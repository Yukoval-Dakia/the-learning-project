// YUK-573 (leg A) — judge-golden REPLAY: deterministic normalization-layer
// regression net for the LLM judges (SemanticJudgeTask / StepsJudgeTask /
// MultimodalDirectJudgeTask consumers).
//
// WHAT IT COVERS (design doc §2.1, honest scope): the pipeline from a FROZEN
// raw LLM output text → normalized JudgeResultV2 — route dispatch
// (resolveQuestionJudgeRoute), extractJsonObject brace-slicing, Zod parse,
// score clamping (normalizeSemanticResult / composeJudgeResult), parse-fail →
// unsupported fallbacks, and the steps accelerator branch. It does NOT cover
// prompt changes (leg B, scripts/judge-prompt-reaudit.ts) nor model changes
// (Deliverable 2 agreement sampling — an offline replay is mathematically
// blind to both: the frozen text never re-runs the model).
//
// HOW IT STAYS PURE: db is a throwing-Proxy sentinel (makeDbSentinel), the LLM
// is a frozen-text stub, images come from an injected stub fetcher (the MF6
// imageFetchFn threading). NOTE the judge routes SWALLOW throws into
// coarse_outcome='unsupported' (question-contract.ts / steps-judge.ts /
// multimodal-direct-judge.ts catch paths) — a sentinel touch does NOT loud
// throw; it surfaces as deterministic drift instead: (i) real-verdict cases
// mismatch on coarse_outcome; (ii) unsupported-expected cases pin
// discriminator evidence keys (raw_text / validation_error / expected / got)
// that the swallow paths ({error, …image_refs}) can never produce, plus a
// universal serialized-marker scan.
//
// FIXTURES (scripts/judge-golden/*.json) are SYNTHETIC — hand-authored or
// desensitized from `experimental:judge_calibration_sample` events (the
// capture chain, scripts/capture-judge-golden.ts); never raw production data.
//
// CLI:
//   pnpm audit:judge-golden            # report-only, exit 0
//   pnpm audit:judge-golden --strict   # exit 1 on drift

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from '@/db/client';
import { type JudgeQuestionRow, judgeAnswer } from '@/server/ai/judges/question-contract';
import { subjectProfiles } from '@/subjects/profile';

/** Unique marker carried by every db-sentinel throw; must never appear in a replay result. */
export const DB_TOUCH_MARKER = '__JUDGE_GOLDEN_DB_TOUCHED__';

/**
 * Evidence keys that discriminate a GENUINE unsupported (parse-fail /
 * signal-mismatch) from a swallowed db/LLM-throw ({error, …image_refs}).
 * Per-route real keys (r3 复核吸收 1, verified against runner sources):
 *   - semantic parse-fail  → { validation_error, raw_text }
 *   - steps/mm parse-fail  → { error, raw_text }
 *   - steps signal-mismatch→ { expected, got }
 * The swallow paths can never produce any of these.
 */
export const UNSUPPORTED_DISCRIMINATOR_KEYS: ReadonlySet<string> = new Set([
  'raw_text',
  'validation_error',
  'expected',
  'got',
]);

export interface JudgeGoldenExpected {
  route: string;
  coarse_outcome: string;
  /** exact (±1e-9); null asserts the unsupported null score. Omit to skip. */
  score?: number | null;
  /** exact (±1e-9). Omit to skip. */
  confidence?: number;
  /** substring the feedback_md must contain. */
  feedback_contains?: string;
  /** keys that must be present in evidence_json (unsupported cases MUST pin ≥1 discriminator). */
  evidence_has_keys?: string[];
}

export interface JudgeGoldenCase {
  id: string;
  description: string;
  question: JudgeQuestionRow;
  answer_md: string;
  student_image_refs?: string[];
  /** id into the committed subjectProfiles registry (route/version fidelity). */
  subject_profile_id: string;
  /** raw LLM output text the stub returns. Omit for llm_must_not_be_called cases. */
  frozen_llm_output?: string;
  /** steps accelerator cases: the LLM stub being called at all is drift. */
  llm_must_not_be_called?: boolean;
  expected: JudgeGoldenExpected;
}

export interface JudgeGoldenFixture {
  version: 1;
  capturedNote: string;
  cases: JudgeGoldenCase[];
}

/**
 * Throwing-Proxy db sentinel: any string-keyed API access (select/insert/…)
 * throws with DB_TOUCH_MARKER; engine-internal symbol reads and thenable
 * probes stay benign (pretty-format / await machinery probe those).
 */
export function makeDbSentinel(): Db {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'constructor') {
          return undefined;
        }
        throw new Error(`${DB_TOUCH_MARKER}:${prop}`);
      },
    },
  ) as unknown as Db;
}

const SCORE_EPS = 1e-9;
const SYNTHETIC_IMAGE_B64 = 'c3ludGhldGljLWp1ZGdlLWdvbGRlbi1pbWFnZQ==';

export interface JudgeGoldenCaseDeps {
  /** test hook (MF6 exposure proof): force the default image-fetch path. */
  omitImageFetchFn?: boolean;
}

/** Replay ONE case through the real judgeAnswer pipeline; return drift lines (empty = clean). */
export async function reauditJudgeGoldenCase(
  c: JudgeGoldenCase,
  deps: JudgeGoldenCaseDeps = {},
): Promise<string[]> {
  const diffs: string[] = [];
  const profile = subjectProfiles[c.subject_profile_id];
  if (!profile) {
    return [`unknown subject_profile_id '${c.subject_profile_id}'`];
  }

  let llmCalled = false;
  const runTaskFn = async () => {
    llmCalled = true;
    return { text: c.frozen_llm_output ?? '' };
  };
  const imageFetchFn = async (assetIds: string[]) =>
    assetIds.map(() => ({ data: SYNTHETIC_IMAGE_B64, mediaType: 'image/png' }));

  const { route, result } = await judgeAnswer({
    db: makeDbSentinel(),
    question: c.question,
    answer_md: c.answer_md,
    student_image_refs: c.student_image_refs,
    subjectProfile: profile,
    runTaskFn,
    ...(deps.omitImageFetchFn ? {} : { imageFetchFn }),
  });

  if (c.llm_must_not_be_called && llmCalled) {
    diffs.push('llm_must_not_be_called=true but the LLM stub WAS called (accelerator regressed)');
  }
  if (route !== c.expected.route) {
    diffs.push(`route: expected '${c.expected.route}' got '${route}'`);
  }
  if (result.coarse_outcome !== c.expected.coarse_outcome) {
    diffs.push(
      `coarse_outcome: expected '${c.expected.coarse_outcome}' got '${result.coarse_outcome}' (feedback: ${result.feedback_md})`,
    );
  }
  if (c.expected.score !== undefined) {
    const got = result.score;
    const want = c.expected.score;
    const match = want === null ? got === null : got !== null && Math.abs(got - want) <= SCORE_EPS;
    if (!match) diffs.push(`score: expected ${String(want)} got ${String(got)}`);
  }
  if (c.expected.confidence !== undefined) {
    if (Math.abs(result.confidence - c.expected.confidence) > SCORE_EPS) {
      diffs.push(`confidence: expected ${c.expected.confidence} got ${result.confidence}`);
    }
  }
  if (c.expected.feedback_contains && !result.feedback_md.includes(c.expected.feedback_contains)) {
    diffs.push(
      `feedback_md missing '${c.expected.feedback_contains}' (got: ${result.feedback_md})`,
    );
  }
  const evidence = (result.evidence_json ?? {}) as Record<string, unknown>;
  for (const key of c.expected.evidence_has_keys ?? []) {
    if (!(key in evidence)) {
      diffs.push(`evidence_json missing key '${key}' (keys: ${Object.keys(evidence).join(',')})`);
    }
  }
  // Universal db-touch scan: the sentinel marker must never appear anywhere in
  // the normalized result (a swallowed touch embeds it into evidence.error).
  const serialized = JSON.stringify(result);
  if (serialized.includes(DB_TOUCH_MARKER)) {
    diffs.push(`db sentinel was touched during replay: ${serialized.slice(0, 300)}`);
  }
  return diffs;
}

export interface JudgeGoldenReauditResult {
  checked: number;
  drifted: { id: string; diffs: string[] }[];
}

/** Replay every case in a fixture. PURE — no DB, no network, no LLM. */
export async function reauditJudgeGolden(
  fixture: JudgeGoldenFixture,
): Promise<JudgeGoldenReauditResult> {
  const drifted: { id: string; diffs: string[] }[] = [];
  for (const c of fixture.cases) {
    const diffs = await reauditJudgeGoldenCase(c);
    if (diffs.length > 0) drifted.push({ id: c.id, diffs });
  }
  return { checked: fixture.cases.length, drifted };
}

export const GOLDEN_DIR = resolve(fileURLToPath(new URL('./judge-golden', import.meta.url)));

/** Committed fixture files (top-level *.json; prompts/ snapshots are leg B). */
export function listGoldenFixtureFiles(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function loadGoldenFixture(file: string): JudgeGoldenFixture {
  return JSON.parse(readFileSync(resolve(GOLDEN_DIR, file), 'utf8')) as JudgeGoldenFixture;
}

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const files = listGoldenFixtureFiles();
  if (files.length === 0) {
    console.error(
      '[judge-golden-reaudit] no fixture files under scripts/judge-golden/ — the gate would be a silent no-op.',
    );
    process.exit(2);
  }
  let totalChecked = 0;
  let totalDrifted = 0;
  for (const file of files) {
    const fixture = loadGoldenFixture(file);
    const result = await reauditJudgeGolden(fixture);
    totalChecked += result.checked;
    totalDrifted += result.drifted.length;
    if (result.drifted.length === 0) {
      console.log(`judge-golden-reaudit — ${file}: ${result.checked} case(s) CLEAN`);
    } else {
      console.log(
        `judge-golden-reaudit — ${file}: ${result.drifted.length}/${result.checked} case(s) DRIFTED:`,
      );
      for (const d of result.drifted) {
        console.log(`  - ${d.id}:`);
        for (const line of d.diffs) console.log(`      ${line}`);
      }
    }
  }
  if (totalDrifted === 0) {
    console.log(`\nCLEAN — ${totalChecked} case(s) replay to their frozen expectations.`);
    process.exit(0);
  }
  console.log(
    [
      `\nDRIFT — ${totalDrifted} case(s) no longer replay to their frozen expectations.`,
      'Either the normalization change is a regression (fix it), or it is INTENTIONAL —',
      're-freeze the affected fixtures after re-verifying the new expected values are correct.',
    ].join('\n'),
  );
  process.exit(strict ? 1 : 0);
}

// CLI-gate (capture-golden.ts precedent): only run as the entry point so tests can import.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[judge-golden-reaudit] failed:', err);
    process.exit(1);
  });
}
