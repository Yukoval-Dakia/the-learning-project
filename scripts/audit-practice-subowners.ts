/**
 * practice 子 owner 边界审计（docs/design/2026-11-03-practice-split.md §0、§5.1）。
 *
 * - owner 归属：已迁入 `practice/<owner>/` 的文件按目录；仍在根目录的文件按 OWNER_RULES
 *   映射到迁移目标，未命中的归练习面 face（根目录的最终形态）。
 * - 边集合只减不增：非测试、非组合文件发出的跨 owner import 记为 owner 对。出现基线之外的
 *   对即失败；基线里已消失的对只提示，不要求同 PR 删除——并行切片不必争改同一个基线文件，
 *   `--write-baseline` 只收紧（删除消失的对），新增对只能在 PR 里手改基线并说明。
 * - 已建子 owner 目录只能经 `<owner>/public.ts` 被目录外引用；根 `manifest.ts` 另可引用
 *   `<owner>/manifest-part.ts`，根 `tasks/index.ts` 另可引用 `<owner>/tasks/*`（任务目录组合
 *   不得加载应用 public，见 `task-public.ts`）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { importedReferences, resolveImportTarget } from './audit-capability-boundaries';

const PRACTICE = 'src/capabilities/practice/';
const BASELINE_PATH = 'scripts/practice-subowner-baseline.json';
const SOURCE_RE = /\.(?:ts|tsx)$/;
const TEST_RE = /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.tsx?$/;

/** 设计 §0 的依赖顺序，自下而上；kernel-bound 是设计里要下沉 kernel 的文件。 */
export const OWNER_ORDER = [
  'kernel-bound',
  'grading',
  'settlement',
  'question-bank',
  'failure-learning',
  'session',
  'scheduling',
  'supply',
  'placement',
  'face',
] as const;
type Owner = (typeof OWNER_ORDER)[number];
const SUBOWNER_DIRS = new Set<string>(
  OWNER_ORDER.filter((owner) => owner !== 'kernel-bound' && owner !== 'face'),
);

/** 组合文件按设计连接所有 owner，只受 public-only 规则约束，发出的 import 不计边。 */
const COMPOSITION_FILES = new Set([
  'manifest.ts',
  'public.ts',
  'ui-public.ts',
  'task-public.ts',
  'tasks/index.ts',
]);

/**
 * 根目录文件的迁移目标（路径相对 practice/，先命中者生效）。来源：设计证据
 * `owners.py`/`areas.py` 的映射，按设计正文 §2.1、§2.5、§3.1、§4.2、§6.3 修正。
 */
const OWNER_RULES: ReadonlyArray<readonly [Owner, RegExp]> = [
  [
    'face',
    /^api\/(paper-contracts|worksheet-contracts)\.ts$|^server\/worksheet\/region-map-validate\.ts$/,
  ],
  ['session', /^worksheet-render-queue\.ts$/],
  ['supply', /^jobs\/(source_verify|question_admission_run)/],
  ['kernel-bound', /^server\/placement-scope\.ts$|^ui\/blocks\/custom-sandbox\.ts$/],
  ['face', /^ui\//],
  [
    'session',
    /^server\/(session-operations\/review-session|review-session-lifecycle|session-summary)\.ts$/,
  ],
  [
    'session',
    /^jobs\/session_summary|^tasks\/session-summary|^api\/(review-sessions|review-session-detail|session-end|session-resources|paper-session-create)/,
  ],
  [
    'grading',
    /^server\/(judge-calibration-sample-core|calibration-sample)|^jobs\/(judge_calibration_sample|judge-calibration-config)/,
  ],
  [
    'question-bank',
    /^server\/(item-prior|fixed-anchor)|^jobs\/(item_prior_backfill|recalibration_nightly)|^tasks\/item-prior|^api\/calibration-anchors/,
  ],
  ['grading', /^server\/(mastery-progress-signal|judge-rating|intervention-diagnostics)\.ts$/],
  ['question-bank', /^server\/(intervention-author|question-scheduling-enrollment)\.ts$/],
  ['settlement', /^server\/attempt-snapshot\.ts$/],
  // Area rules from areas.py, in its order.
  [
    'face',
    /^(manifest|public|ui-public|task-public)\.ts$|^server\/(queue-runtime|task-runtime|config-effective-facts|selection-constants)\.ts$/,
  ],
  ['scheduling', /^server\/stream-replacement-plan/],
  [
    'face',
    /^tasks\/(index|parse-output|generation-prompt-support)\.ts$|^tools\/types\.ts$|^api\/(contracts|resource-routes)\.ts$/,
  ],
  ['scheduling', /^api\/session-resources/],
  ['supply', /placement-(starter|supply-lock)/],
  ['placement', /(^|\/)placement[-_]/],
  [
    'settlement',
    /^server\/(judge-retraction-applier|appeal-operation)\.ts$|^server\/assessment\/appeal|^jobs\/(rejudge|rejudge-config)|^api\/appeal\.ts$|^server\/tools\/propose-grading-correction/,
  ],
  [
    'grading',
    /^server\/judge\/|^server\/judge-|^server\/evaluate-submission|^server\/recorded-model-executor|^jobs\/judge_|^api\/judge-run-status|^tasks\/(judges|jev-typed|assessment-rubric|assessment-rule|source-grounding-verify)/,
  ],
  [
    'failure-learning',
    /failure-learning|^server\/(cause-|merge-attribution|lost-attribution-backfill|enqueue-wrong-streak-nudge)|^jobs\/(attribution_followup|variant_gen)|^tools\/(attribute-mistake|propose-variant)|^server\/tools\/(query-mistakes|get-attempt-context)|^tasks\/(attribution|attribute-retrieve|cause-category-propose|variant-gen)/,
  ],
  [
    'face',
    /^server\/(solve-|hint-explanation|tutor-session)|^api\/solve-|^tasks\/teaching-quality/,
  ],
  [
    'scheduling',
    /^server\/(stream-|stored-stream-budget|selection-|softmax-selection|non-due-selection-plan|post-filter|variant-rotation|candidate-signals|learnable-frontier|knowledge-labels|compose-paid-work-lock)|^jobs\/practice_stream_compose_nightly|^api\/stream|^tasks\/selection-orchestrator/,
  ],
  [
    'session',
    /^server\/(paper-|papers-list|practice-read|answer-draft)|^server\/assessment\/paper-|^server\/worksheet\/|^jobs\/worksheet_render|^api\/(paper|papers-|legacy-paper|worksheet)|^server\/tools\/(write-quiz|tool-quiz-core)/,
  ],
  [
    'scheduling',
    /^server\/(fsrs|rating-advisor|due-list|daily-review-plan|question-pace|review-weekly|advice-operation|day-one-priors|activity-tier|learner-return-wake)|^api\/(due|advice|weekly|review-planning-contracts)|^server\/tools\/question-context/,
  ],
  [
    'grading',
    /^server\/assessment\/|^server\/(review-operation|review-answer-response|activity-ref|assets|native-durable-attempt|review-settlement|paper-submit-session-race)|^api\/(submit|assessment-)|^server\/tools\/submit-review-answer/,
  ],
  [
    'supply',
    /^server\/question-supply\/|^server\/(supply-plan-operation|web-sourcing-operation|question-generation-grounding)|^jobs\/(supply_|quiz_gen|question_supply_nightly|confusable_contrast_nightly|jyeoo_staged_asset_reap)|^server\/tools\/(file-bank-gap|jyeoo-fetch|web-fetch|generate-question-candidate|question-author|submit-question|store-sourced-question)|^server\/quiz\/(sourcing-sequence|fewshot-retrieve|quiz-gen-)|^api\/quiz-gen-trigger|^tasks\/(sourcing|supply-planning|quiz-generation|quiz-planning|question-author|solution-generation)/,
  ],
  [
    'question-bank',
    /^server\/admission\/|^server\/quiz\/verify-|^server\/(verify-dispatch-outbox|reference-solution|learning-content-validation)|^server\/custom-block-preview\/|^jobs\/(quiz_verify|variant_verify|model_slice_admission_run|reference_answer_backfill|answer_class_backfill)|^tasks\/(question-admission-solve|quiz-verify|variant-verify)/,
  ],
  [
    'question-bank',
    /^server\/(question-|serving-action|draft-|proposal-|live-question-reference)|^server\/quiz\/|^server\/tools\/(bank-|search-bank|read-bank|check-bank|edit-question|proposal-tools)|^jobs\/embed_backfill|^api\/(question|review-draft|draft-moderation)|^tasks\/bank-search-semantic/,
  ],
];

export function ownerOf(practicePath: string): Owner {
  const [head] = practicePath.split('/');
  if (head && SUBOWNER_DIRS.has(head) && practicePath.includes('/')) return head as Owner;
  for (const [owner, pattern] of OWNER_RULES) if (pattern.test(practicePath)) return owner;
  return 'face';
}

function subownerDir(practicePath: string): string | undefined {
  const [head] = practicePath.split('/');
  return head && SUBOWNER_DIRS.has(head) && practicePath.includes('/') ? head : undefined;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE_RE.test(entry) && !TEST_RE.test(entry)) out.push(path);
  }
}

export interface PracticeSubownerScan {
  /** `from -> to` owner pair → distinct `file -> file` import edges. */
  edges: Map<string, string[]>;
  publicOnlyViolations: string[];
}

export function scanPracticeSubowners(projectRoot: string): PracticeSubownerScan {
  const root = resolve(projectRoot, PRACTICE);
  const files: string[] = [];
  walk(root, files);
  const edges = new Map<string, string[]>();
  const publicOnlyViolations: string[] = [];
  for (const file of files.sort()) {
    const from = relative(root, file).split(sep).join('/');
    const fromDir = subownerDir(from);
    for (const reference of importedReferences(readFileSync(file, 'utf8'), file)) {
      const target = resolveImportTarget(projectRoot, file, reference.source);
      if (!target || !existsSync(target)) continue;
      const to = relative(root, target).split(sep).join('/');
      if (to.startsWith('..')) continue;
      const toDir = subownerDir(to);
      if (toDir && toDir !== fromDir) {
        const allowed =
          to === `${toDir}/public.ts` ||
          (from === 'manifest.ts' && to === `${toDir}/manifest-part.ts`) ||
          (from === 'tasks/index.ts' && to.startsWith(`${toDir}/tasks/`));
        if (!allowed) publicOnlyViolations.push(`${from} -> ${to}`);
      }
      if (COMPOSITION_FILES.has(from) || TEST_RE.test(to)) continue;
      const pair = `${ownerOf(from)} -> ${ownerOf(to)}`;
      if (ownerOf(from) === ownerOf(to)) continue;
      const list = edges.get(pair) ?? [];
      list.push(`${from} -> ${to}`);
      edges.set(pair, list);
    }
  }
  return { edges, publicOnlyViolations };
}

const baselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  edgeUnit: z.literal('owner-pair'),
  edges: z.array(z.string().regex(/^[a-z-]+ -> [a-z-]+$/)),
});

function rank(pair: string): [number, number] {
  const [from, to] = pair.split(' -> ') as [Owner, Owner];
  return [OWNER_ORDER.indexOf(from), OWNER_ORDER.indexOf(to)];
}

function sortPairs(pairs: Iterable<string>): string[] {
  return [...pairs].sort((left, right) => {
    const [a, b] = rank(left);
    const [c, d] = rank(right);
    return a - c || b - d;
  });
}

export function main(argv = process.argv.slice(2), projectRoot = process.cwd()): void {
  const { edges, publicOnlyViolations } = scanPracticeSubowners(projectRoot);
  const baselineFile = resolve(projectRoot, BASELINE_PATH);
  const baseline = existsSync(baselineFile)
    ? baselineSchema.parse(JSON.parse(readFileSync(baselineFile, 'utf8'))).edges
    : undefined;
  const current = sortPairs(edges.keys());
  const added = baseline ? current.filter((pair) => !baseline.includes(pair)) : [];
  const stale = baseline ? baseline.filter((pair) => !edges.has(pair)) : [];

  if (argv.includes('--write-baseline')) {
    if (baseline && added.length > 0) {
      throw new Error(
        `--write-baseline only tightens; new owner pairs need a reviewed baseline edit: ${added.join(', ')}`,
      );
    }
    const body = { schemaVersion: 1, edgeUnit: 'owner-pair', edges: current };
    writeFileSync(baselineFile, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`wrote ${BASELINE_PATH}: ${current.length} owner pairs`);
    return;
  }
  if (!baseline) throw new Error(`${BASELINE_PATH} is missing; run with --write-baseline`);

  const failures: string[] = [];
  for (const pair of added) {
    failures.push(`new owner edge ${pair}:\n    ${(edges.get(pair) ?? []).join('\n    ')}`);
  }
  for (const violation of publicOnlyViolations) {
    failures.push(`sub-owner entered outside its public.ts: ${violation}`);
  }
  const fileEdges = [...edges.values()].reduce((sum, list) => sum + list.length, 0);
  const upward = current.filter((pair) => {
    const [from, to] = rank(pair);
    return to > from;
  }).length;
  if (stale.length > 0) {
    console.log(
      `note: ${stale.length} baseline pair(s) no longer occur (tighten with --write-baseline): ${stale.join(', ')}`,
    );
  }
  if (failures.length > 0) {
    console.error(`audit:practice-subowners FAILED\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `audit:practice-subowners OK — ${current.length} owner pairs (${upward} against the design order, ${fileEdges} file edges) within the ${baseline.length}-pair baseline; sub-owner directories entered only through public.ts.`,
  );
  if (argv.includes('--list')) {
    for (const pair of current) console.log(`  ${pair}  ${edges.get(pair)?.length ?? 0}`);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main();
}
