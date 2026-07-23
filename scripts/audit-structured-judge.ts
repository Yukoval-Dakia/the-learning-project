/**
 * audit:structured-judge — YUK-591 §7 enforcement (owner-locked 2026-07-23).
 *
 * Every JUDGE TASK in the AI task registry (`src/ai/registry.ts`) MUST declare a
 * `structuredOutputSchema` — the SDK structured-output contract wired through the
 * YUK-299 `outputFormat` seam — OR be listed in
 * `scripts/audit-structured-judge-allowlist.json` with a `reason` +
 * `resolves_when{kind,ref,expected_by}` (same allowlist shape as
 * audit:fold-writes / audit:schema).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * The two vision judges (StepsJudgeTask / MultimodalDirectJudgeTask) used to fish
 * a JSON object out of free-text model output (`extractJsonObject` →
 * `Schema.parse`); malformed output became silent `unsupported` waste. YUK-591
 * migrated them to the SDK `outputFormat` seam (schema-constrained + SDK-retried
 * extraction, with a Zod second-pass; endpoints that ignore it fall back to the
 * char-scan path, so the declaration is a zero-loss opt-in). This audit is the
 * machine-checkable guard that a NEW judge task cannot regress to free-text
 * JSON-fishing without an explicit, dated waiver.
 *
 * ── JUDGE-TASK DETECTION (documented limitation) ─────────────────────────────
 * The judge-task set = registry kinds ending in `JudgeTask`. All three of today's
 * LLM judge tasks (SemanticJudgeTask / StepsJudgeTask / MultimodalDirectJudgeTask)
 * follow this convention. A future judge task that does NOT end in `JudgeTask`
 * would escape the sweep — the self-test pins the current set so a rename that
 * drops the suffix (or a new judge task under a different name) surfaces in review.
 *
 * ── HARD GATE ────────────────────────────────────────────────────────────────
 * Unlike the report-only siblings (audit:fold-writes / audit:relations), this runs
 * in the `pnpm test` chain and exits non-zero on ANY violation, stale allowlist,
 * or redundant allowlist entry. §7 is an automated CI audit, not docs.
 *
 * 用法:
 *   pnpm audit:structured-judge          # human report; exit 1 on any problem
 *   pnpm audit:structured-judge --json   # JSON output
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from '@/ai/registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, 'audit-structured-judge-allowlist.json');

/** A judge task is any registry kind ending in this suffix. */
export const JUDGE_TASK_SUFFIX = 'JudgeTask';

/** Minimal registry shape this audit reads (decoupled from the full TaskDef). */
export type TaskDefLike = { structuredOutputSchema?: unknown };

// Judge-shaped tasks that do NOT carry the `JudgeTask` suffix. The suffix sweep alone
// misses them (PR #1042 codex P2: UnitDimensionFallback is the Judge v2 physics fallback
// parsing free-text model output into a verdict). Keep this list in lockstep with the
// self-test's pinned kind set — a new judge-shaped kind belongs either on the suffix
// convention or in here.
export const EXTRA_JUDGE_KINDS: ReadonlySet<string> = new Set(['UnitDimensionFallback']);

export type JudgeTaskDecl = {
  kind: string;
  /** true iff the registry entry declares a `structuredOutputSchema`. */
  hasStructuredOutput: boolean;
};

/**
 * Collect the judge tasks from a registry-like map: kinds ending in `JudgeTask`,
 * each flagged for whether it declares a structured-output schema. Pure + sorted
 * for a stable report. Exported for the self-test.
 */
export function collectJudgeTasks(taskDefs: Record<string, TaskDefLike>): JudgeTaskDecl[] {
  return Object.entries(taskDefs)
    .filter(([kind]) => kind.endsWith(JUDGE_TASK_SUFFIX) || EXTRA_JUDGE_KINDS.has(kind))
    .map(([kind, def]) => ({
      kind,
      // Only a real schema counts: a Zod-like object exposing safeParse. Guards against
      // structuredOutputSchema: null/false/'' accidentally reading as compliant (PR #1042 OCR).
      hasStructuredOutput:
        typeof (def.structuredOutputSchema as { safeParse?: unknown } | undefined)?.safeParse ===
        'function',
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

// ── allowlist contract (mirrors audit:fold-writes / audit:schema resolves_when) ──

export type ResolvesWhen = { kind: 'pr' | 'phase' | 'manual'; ref: string; expected_by: string };
export type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };
/** allowlist key = the judge task kind (e.g. "SemanticJudgeTask"). */
export type Allowlist = Record<string, AllowlistEntry>;

export type AllowlistProblem = { key: string; detail: string };

export function validateAllowlistEntry(
  key: string,
  entry: AllowlistEntry,
  today: string,
): AllowlistProblem[] {
  const problems: AllowlistProblem[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [{ key, detail: 'allowlist entry must be an object with reason/resolves_when' }];
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
    problems.push({ key, detail: 'reason must be a non-empty string' });
  }
  const rw = entry.resolves_when;
  if (rw === null || typeof rw !== 'object' || Array.isArray(rw)) {
    problems.push({ key, detail: 'resolves_when must be { kind, ref, expected_by }' });
    return problems;
  }
  if (rw.kind !== 'pr' && rw.kind !== 'phase' && rw.kind !== 'manual') {
    problems.push({ key, detail: "resolves_when.kind must be 'pr', 'phase', or 'manual'" });
  }
  if (typeof rw.ref !== 'string' || rw.ref.trim().length === 0) {
    problems.push({ key, detail: 'resolves_when.ref must be non-empty' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rw.expected_by)) {
    problems.push({ key, detail: 'resolves_when.expected_by must be YYYY-MM-DD' });
  } else if (Number.isNaN(Date.parse(rw.expected_by))) {
    problems.push({
      key,
      detail: `resolves_when.expected_by ${rw.expected_by} is not a valid date`,
    });
  } else if (rw.expected_by < today) {
    problems.push({
      key,
      detail: `resolves_when.expected_by ${rw.expected_by} is before ${today}`,
    });
  }
  return problems;
}

// ── audit verdict ──────────────────────────────────────────────────────────────

export type StructuredJudgeAuditResult = {
  judgeTasks: JudgeTaskDecl[];
  /** judge tasks with NO structuredOutputSchema and NOT allowlisted. */
  violations: string[];
  /** judge tasks with NO structuredOutputSchema but explicitly allowlisted. */
  allowlisted: string[];
  allowlistProblems: AllowlistProblem[];
  /**
   * allowlist keys that do not correspond to a missing-schema judge task — either
   * not a judge task at all, or a judge task that already declares a schema. Dead
   * config → drift (matches the audit:fold-writes redundant-allowlist reverse-check).
   */
  redundantAllowlist: string[];
  ok: boolean;
};

/**
 * Core audit. Pure, exported for the self-test. A judge task is COMPLIANT iff it
 * declares a schema; otherwise it must be allowlisted (with a valid entry). An
 * allowlist key that matches no missing-schema judge task is dead config.
 */
export function computeStructuredJudgeAudit(
  judgeTasks: JudgeTaskDecl[],
  allowlist: Allowlist,
  today: string,
): StructuredJudgeAuditResult {
  const violations: string[] = [];
  const allowlisted: string[] = [];
  const allowlistProblems: AllowlistProblem[] = [];
  const usedAllowlistKeys = new Set<string>();

  for (const task of judgeTasks) {
    if (task.hasStructuredOutput) continue;
    if (Object.hasOwn(allowlist, task.kind)) {
      allowlisted.push(task.kind);
      usedAllowlistKeys.add(task.kind);
      allowlistProblems.push(...validateAllowlistEntry(task.kind, allowlist[task.kind], today));
      continue;
    }
    violations.push(task.kind);
  }

  const redundantAllowlist = Object.keys(allowlist)
    .filter((key) => !usedAllowlistKeys.has(key))
    .sort();

  return {
    judgeTasks,
    violations,
    allowlisted,
    allowlistProblems,
    redundantAllowlist,
    ok:
      violations.length === 0 && allowlistProblems.length === 0 && redundantAllowlist.length === 0,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function loadAllowlist(): Allowlist {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `[audit:structured-judge] allowlist at ${ALLOWLIST_PATH} has a non-object root; treating as empty`,
      );
      return {};
    }
    return parsed as Allowlist;
  } catch (err) {
    console.error(
      `[audit:structured-judge] failed to load allowlist at ${ALLOWLIST_PATH}; treating as empty:`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const today = new Date().toISOString().slice(0, 10);

  const judgeTasks = collectJudgeTasks(tasks as Record<string, TaskDefLike>);
  const result = computeStructuredJudgeAudit(judgeTasks, loadAllowlist(), today);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  console.log('audit:structured-judge — judge tasks must declare structured output (YUK-591 §7)\n');
  console.log('  judge tasks (kind → structured-output declared):');
  for (const task of result.judgeTasks) {
    const mark = task.hasStructuredOutput
      ? 'declared'
      : result.allowlisted.includes(task.kind)
        ? 'allowlisted'
        : 'MISSING';
    console.log(`    - ${task.kind.padEnd(28)} ${mark}`);
  }
  console.log('');

  if (result.violations.length === 0) {
    console.log(
      '  VIOLATIONS (judge task with no structuredOutputSchema, not allowlisted):  (none)',
    );
  } else {
    console.log(
      `  VIOLATIONS (judge task with no structuredOutputSchema, not allowlisted):  ${result.violations.length}`,
    );
    for (const kind of result.violations) console.log(`    - ${kind}`);
    console.log(
      '\n  Fix: declare `structuredOutputSchema: <ZodSchema>` on the task in src/ai/registry.ts and\n' +
        '  build `outputFormat: zodToJsonSchemaOutputFormat(schema)` at the judge call site (see\n' +
        '  steps-judge.ts / multimodal-direct-judge.ts) — OR add the kind to\n' +
        '  scripts/audit-structured-judge-allowlist.json with a reason + resolves_when.',
    );
  }
  console.log('');

  if (result.redundantAllowlist.length > 0) {
    console.log(
      `  REDUNDANT allowlist entries (no matching missing-schema judge task):  ${result.redundantAllowlist.length}`,
    );
    for (const k of result.redundantAllowlist) console.log(`    - ${k}: drop from allowlist.`);
    console.log('');
  }

  if (result.allowlistProblems.length > 0) {
    console.log(`  ALLOWLIST problems:  ${result.allowlistProblems.length}`);
    for (const p of result.allowlistProblems) console.log(`    - ${p.key}: ${p.detail}`);
    console.log('');
  }

  console.log(
    '  §7 (owner-locked 2026-07-23): judge tasks funnel free-text model output into a verdict; a\n' +
      '  structured-output declaration turns malformed-output waste into schema-enforced extraction.\n' +
      '  Hard gate — a new judge task must declare it or carry a dated waiver.',
  );

  if (!result.ok) process.exit(1);
}

// CLI-gate (mirrors audit-fold-writes.ts): only run + exit when invoked as a CLI so
// the self-test can import the pure functions without the top-level audit firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
