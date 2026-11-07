/**
 * practice 子 owner 边界审计（docs/design/2026-11-03-practice-split.md §0、§5.1）。
 *
 * - owner 归属：已迁入 `practice/<owner>/` 的文件按目录；仍在根目录的文件按 OWNER_RULES
 *   映射到迁移目标，未命中的归练习面 face（根目录的最终形态）。
 * - 非测试、非组合文件发出的跨 owner import 记为 owner 对；新对只能向下且经目标 public.ts。
 *   不可变的比较基（`--base <sha>` / `CAPABILITY_BASE_SHA`，否则与 origin/main 的 merge-base）：
 *   同一套映射在基提交的树上重算 owner 对，HEAD 新增的对校验方向和入口。存量对只按
 *   base 实测 grandfather，无台账。
 * - 已建子 owner 目录只能经 `<owner>/public.ts` 被目录外引用；根 `manifest.ts` 另可引用
 *   `<owner>/manifest-part.ts`，根 `tasks/index.ts` 另可引用 `<owner>/tasks/*`（任务目录组合
 *   不得加载应用 public，见 `task-public.ts`）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importedReferences, resolveImportTarget } from './audit-capability-boundaries';
import {
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  resolveSpecifierInTree,
} from './lib/git-base-scan';

const PRACTICE = 'src/capabilities/practice/';
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

// Agent tools may read priors at any attempt stage. Learner transport must not carry
// them, and independent solving/judging must not read stored solution evidence.
const SOLUTION_PRIOR_RE =
  /readSolutionPriorForServer|nearestQuestionsByMethod|question_solution_prior|admission\/solution-prior/;
const PRIOR_FIELD_RE = /\b(?:solution_prior|solutionPrior|SolutionPrior|StoredSolutionPrior)\w*\b/;
const LEARNER_SURFACE_RE =
  /(?:^|\/)(?:api|ui)\/|(?:^|\/)ui-public\.tsx?$|^server\/|^src\/core\/schema\/|(?:^|\/)[^/]*(?:contracts?|dto)[^/]*\.tsx?$/i;
const INDEPENDENT_IMPORT_RE =
  /(?:^|\/)grading\/|(?:^|\/)tasks\/[^/]*(?:solve|adjudicat|grad|judg)[^/]*\.tsx?$|(?:^|\/)admission\/adjudicate\.ts$/;
const INDEPENDENT_RE =
  /(?:^|\/)grading\/|(?:^|\/)tasks\/[^/]*(?:solve|adjudicat|grad|judg)[^/]*\.tsx?$|(?:^|\/)admission\/(?:solve|adjudicate)\.ts$/;
// solve.ts also produces priors after settling keys; generating a prior is not a read.
const PRIOR_READ_RE = /readSolutionPriorForServer|nearestQuestionsByMethod|question_solution_prior/;

export function scanSolutionPriorExposure(projectRoot: string): string[] {
  const files: string[] = [];
  for (const dir of ['src', 'server', 'web/src']) {
    const root = resolve(projectRoot, dir);
    if (existsSync(root)) walk(root, files);
  }
  const violations: string[] = [];
  for (const file of files) {
    const path = relative(projectRoot, file).split(sep).join('/');
    const code = readFileSync(file, 'utf8');
    if (
      LEARNER_SURFACE_RE.test(path) &&
      (SOLUTION_PRIOR_RE.test(code) || PRIOR_FIELD_RE.test(code))
    ) {
      violations.push(`learner surface carries or reads the solution prior: ${path}`);
    }
    if (
      INDEPENDENT_RE.test(path) &&
      (PRIOR_READ_RE.test(code) ||
        (INDEPENDENT_IMPORT_RE.test(path) && SOLUTION_PRIOR_RE.test(code)))
    ) {
      violations.push(`independent solve/adjudication/grading reads the solution prior: ${path}`);
    }
  }
  return violations;
}

export function main(argv = process.argv.slice(2), projectRoot = process.cwd()): void {
  const { edges, publicOnlyViolations } = scanPracticeSubowners(projectRoot);
  const current = sortPairs(edges.keys());
  const baseIndex = argv.indexOf('--base');
  if (baseIndex !== -1 && !argv[baseIndex + 1]) throw new Error('--base requires a commit SHA.');
  const baseSha = resolveAuditBaseSha(
    projectRoot,
    baseIndex === -1 ? process.env.CAPABILITY_BASE_SHA : argv[baseIndex + 1],
  );
  const baseEdges = scanPracticeSubownersAtRef(projectRoot, baseSha).edges;
  const addedSinceBase = current.filter((pair) => !baseEdges.has(pair));

  const failures: string[] = [];
  for (const pair of addedSinceBase) {
    const [from, to] = rank(pair);
    const target = pair.split(' -> ')[1];
    const imports = edges.get(pair) ?? [];
    if (to > from || imports.some((edge) => edge.split(' -> ')[1] !== `${target}/public.ts`)) {
      failures.push(
        `new owner edge ${pair} must point down through target public.ts (base ${baseSha.slice(0, 12)}):\n    ${imports.join('\n    ')}`,
      );
    }
  }
  for (const violation of publicOnlyViolations) {
    failures.push(`sub-owner entered outside its public.ts: ${violation}`);
  }
  for (const violation of scanSolutionPriorExposure(projectRoot)) {
    failures.push(violation);
  }
  const fileEdges = [...edges.values()].reduce((sum, list) => sum + list.length, 0);
  const upward = current.filter((pair) => {
    const [from, to] = rank(pair);
    return to > from;
  }).length;
  if (failures.length > 0) {
    console.error(`audit:practice-subowners FAILED\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `audit:practice-subowners OK — ${current.length} owner pairs (${upward} against the design order, ${fileEdges} file edges) compared with ${baseEdges.size} pairs at base ${baseSha.slice(0, 12)}; new pairs point down through public.ts; sub-owner entries obey public-only rules.`,
  );
  if (argv.includes('--list')) {
    for (const pair of current) console.log(`  ${pair}  ${edges.get(pair)?.length ?? 0}`);
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main();
}
