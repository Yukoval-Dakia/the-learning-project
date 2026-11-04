/**
 * practice 子 owner 边界审计（docs/design/2026-11-03-practice-split.md §0、§5.1）。
 *
 * - owner 归属：已迁入 `practice/<owner>/` 的文件按目录；仍在根目录的文件按 OWNER_RULES
 *   映射到迁移目标，未命中的归练习面 face（根目录的最终形态）。
 * - 边集合只减不增：非测试、非组合文件发出的跨 owner import 记为 owner 对。出现基线之外的
 *   对即失败；基线里已消失的对只提示，不要求同 PR 删除——并行切片不必争改同一个基线文件，
 *   `--write-baseline` 只收紧（删除消失的对）。
 * - 第二道上限是不可变的比较基（`--base <sha>` / `CAPABILITY_BASE_SHA`，否则与 origin/main 的
 *   merge-base）：同一套映射在基提交的树上重算 owner 对，HEAD 出现基上没有的对即失败，
 *   手改基线也放不进新边。
 * - 已建子 owner 目录只能经 `<owner>/public.ts` 被目录外引用；根 `manifest.ts` 另可引用
 *   `<owner>/manifest-part.ts`，根 `tasks/index.ts` 另可引用 `<owner>/tasks/*`（任务目录组合
 *   不得加载应用 public，见 `task-public.ts`）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { importedReferences, resolveImportTarget } from './audit-capability-boundaries';
import {
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  resolveSpecifierInTree,
} from './lib/git-base-scan';

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
 * `owners.py`/`areas.py` 的映射，按设计正文 §2.1、§2.5、§3.1、§4.2、§6.3 修正。不再决定任何
 * 根目录文件归属的规则随文件迁出删除。
 */
const OWNER_RULES: ReadonlyArray<readonly [Owner, RegExp]> = [
  [
    'face',
    /^api\/(paper-contracts|worksheet-contracts)\.ts$|^server\/worksheet\/region-map-validate\.ts$/,
  ],
  ['kernel-bound', /^ui\/blocks\/custom-sandbox\.ts$/],
  ['face', /^ui\//],
  ['settlement', /^server\/attempt-snapshot\.ts$/],
  // Area rules from areas.py, in its order.
  [
    'face',
    /^(manifest|public|ui-public|task-public)\.ts$|^server\/(config-effective-facts|selection-constants)\.ts$/,
  ],
  ['face', /^tasks\/index\.ts$|^tools\/types\.ts$|^api\/(contracts|resource-routes)\.ts$/],
  [
    'settlement',
    /^server\/(judge-retraction-applier|appeal-operation)\.ts$|^server\/assessment\/appeal|^jobs\/(rejudge|rejudge-config)|^api\/appeal\.ts$|^server\/tools\/propose-grading-correction/,
  ],
  [
    'face',
    /^server\/(solve-|hint-explanation|tutor-session)|^api\/solve-|^tasks\/teaching-quality/,
  ],
  [
    'grading',
    /^server\/assessment\/|^server\/(review-operation|review-answer-response|activity-ref|assets|native-durable-attempt|review-settlement|paper-submit-session-race)|^api\/(submit|assessment-)|^server\/tools\/submit-review-answer/,
  ],
  [
    'supply',
    /^server\/question-supply\/|^server\/(supply-plan-operation|web-sourcing-operation|question-generation-grounding)|^jobs\/(supply_|quiz_gen|question_supply_nightly|jyeoo_staged_asset_reap)|^server\/tools\/(file-bank-gap|jyeoo-fetch|web-fetch|generate-question-candidate|question-author|submit-question|store-sourced-question)|^server\/quiz\/(sourcing-sequence|fewshot-retrieve|quiz-gen-)|^api\/quiz-gen-trigger|^tasks\/(sourcing|supply-planning|quiz-generation|quiz-planning|question-author|solution-generation)/,
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

interface PracticeSource {
  /** Path relative to practice/, posix. */
  path: string;
  code: string;
  /** Resolves an import specifier to a practice-relative path, or undefined. */
  resolve(source: string): string | undefined;
}

function scanSources(sources: readonly PracticeSource[]): PracticeSubownerScan {
  const edges = new Map<string, string[]>();
  const publicOnlyViolations: string[] = [];
  for (const source of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    const from = source.path;
    const fromDir = subownerDir(from);
    for (const reference of importedReferences(source.code, from)) {
      const to = source.resolve(reference.source);
      if (!to) continue;
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

export function scanPracticeSubowners(projectRoot: string): PracticeSubownerScan {
  const root = resolve(projectRoot, PRACTICE);
  const files: string[] = [];
  walk(root, files);
  return scanSources(
    files.map((file) => ({
      path: relative(root, file).split(sep).join('/'),
      code: readFileSync(file, 'utf8'),
      resolve(source: string) {
        const target = resolveImportTarget(projectRoot, file, source);
        if (!target || !existsSync(target)) return undefined;
        const to = relative(root, target).split(sep).join('/');
        return to.startsWith('..') ? undefined : to;
      },
    })),
  );
}

/** Same scan over the committed tree at `ref` (blobs, not the worktree). */
export function scanPracticeSubownersAtRef(projectRoot: string, ref: string): PracticeSubownerScan {
  const tree = listTreeFiles(projectRoot, ref, []);
  const pathSet = new Set(tree.map((entry) => entry.path));
  const paths = tree
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(PRACTICE) && SOURCE_RE.test(path) && !TEST_RE.test(path))
    .filter((path) => !path.split('/').some((segment) => segment.startsWith('.')));
  const blobs = readBlobs(projectRoot, ref, paths);
  if (blobs.size !== paths.length) {
    throw new Error(`cannot read every practice source at ${ref}`);
  }
  return scanSources(
    paths.map((path) => ({
      path: path.slice(PRACTICE.length),
      code: blobs.get(path) ?? '',
      resolve(source: string) {
        const target = resolveSpecifierInTree(pathSet, posix.dirname(path), source);
        if (!target || !pathSet.has(target) || !target.startsWith(PRACTICE)) return undefined;
        return target.slice(PRACTICE.length);
      },
    })),
  );
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

// The question solution prior reveals the solution path. Tools, routes and UI reach
// learners, so none may touch it directly; a learner-facing read must gate on the attempt.
// The practice root barrel is covered too: exporting from it opens every other capability.
const SOLUTION_PRIOR_RE =
  /readSolutionPriorForServer|question_solution_prior|admission\/solution-prior/;
const LEARNER_SURFACE_RE =
  /(?:^|\/)(?:tools|api|ui)\/|^src\/capabilities\/practice\/(?:ui-)?public\.tsx?$|^server\//;

export function scanSolutionPriorExposure(projectRoot: string): string[] {
  const files: string[] = [];
  for (const dir of ['src/capabilities', 'server']) {
    const root = resolve(projectRoot, dir);
    if (existsSync(root)) walk(root, files);
  }
  return files
    .map((file) => relative(projectRoot, file).split(sep).join('/'))
    .filter((path) => LEARNER_SURFACE_RE.test(path))
    .filter((path) => SOLUTION_PRIOR_RE.test(readFileSync(resolve(projectRoot, path), 'utf8')));
}

export function main(argv = process.argv.slice(2), projectRoot = process.cwd()): void {
  const { edges, publicOnlyViolations } = scanPracticeSubowners(projectRoot);
  const baselineFile = resolve(projectRoot, BASELINE_PATH);
  const baseline = existsSync(baselineFile)
    ? baselineSchema.parse(JSON.parse(readFileSync(baselineFile, 'utf8'))).edges
    : undefined;
  const current = sortPairs(edges.keys());
  const added = baseline ? current.filter((pair) => !baseline.includes(pair)) : [];
  const baseIndex = argv.indexOf('--base');
  if (baseIndex !== -1 && !argv[baseIndex + 1]) throw new Error('--base requires a commit SHA.');
  const baseSha = resolveAuditBaseSha(
    projectRoot,
    baseIndex === -1 ? process.env.CAPABILITY_BASE_SHA : argv[baseIndex + 1],
  );
  const baseEdges = scanPracticeSubownersAtRef(projectRoot, baseSha).edges;
  const addedSinceBase = current.filter((pair) => !baseEdges.has(pair));
  const stale = baseline ? baseline.filter((pair) => !edges.has(pair)) : [];

  if (argv.includes('--write-baseline')) {
    const widened = [...new Set([...added, ...addedSinceBase])];
    if (widened.length > 0) {
      throw new Error(`--write-baseline only tightens; new owner pairs: ${widened.join(', ')}`);
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
  for (const pair of addedSinceBase) {
    failures.push(
      `owner edge ${pair} is absent at base ${baseSha.slice(0, 12)}:\n    ${(edges.get(pair) ?? []).join('\n    ')}`,
    );
  }
  for (const violation of publicOnlyViolations) {
    failures.push(`sub-owner entered outside its public.ts: ${violation}`);
  }
  for (const path of scanSolutionPriorExposure(projectRoot)) {
    failures.push(`learner-reachable path touches the solution prior: ${path}`);
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
    `audit:practice-subowners OK — ${current.length} owner pairs (${upward} against the design order, ${fileEdges} file edges) within the ${baseline.length}-pair baseline and the ${baseEdges.size} pairs at base ${baseSha.slice(0, 12)}; sub-owner directories entered only through public.ts.`,
  );
  if (argv.includes('--list')) {
    for (const pair of current) console.log(`  ${pair}  ${edges.get(pair)?.length ?? 0}`);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main();
}
