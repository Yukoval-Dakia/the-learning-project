/**
 * audit:structured-judge — judge tasks must declare a structured-output contract.
 *
 * Every judge task in the AI task registry must declare a `structuredOutputSchema`, consumed at
 * the call site by the structured-output-or-text-parse dispatch, or carry an allowlist entry with
 * a reason and resolves_when. Free-text JSON fishing turns malformed output into silent
 * `unsupported` waste; this audit stops a new judge task from regressing to it without a dated
 * waiver.
 *
 * Judge detection is suffix-based (`*JudgeTask`) plus a small explicit extras list, so a
 * differently named judge can escape the sweep. This is a hard gate: it runs in the test chain and
 * fails on any violation, stale allowlist, or redundant entry.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from '@/capabilities/task-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, 'audit-structured-judge-allowlist.json');

/** A judge task is any registry kind ending in this suffix. */
export const JUDGE_TASK_SUFFIX = 'JudgeTask';

/** Minimal registry shape this audit reads (decoupled from the full TaskDef). */
export type TaskDefLike = { structuredOutputSchema?: unknown };

// Judge-shaped tasks without the suffix. Keep this in lockstep with the self-test's pinned kind
// set; a new judge-shaped kind belongs here or on the suffix convention.
export const EXTRA_JUDGE_KINDS: ReadonlySet<string> = new Set(['UnitDimensionFallback']);

export type JudgeTaskDecl = {
  kind: string;
  /** true iff the registry entry declares a `structuredOutputSchema`. */
  hasStructuredOutput: boolean;
};

/**
 * Collect judge tasks from a registry-like map and flag whether each declares a structured-output
 * schema. Pure and sorted for a stable report.
 */
export function collectJudgeTasks(taskDefs: Record<string, TaskDefLike>): JudgeTaskDecl[] {
  return Object.entries(taskDefs)
    .filter(([kind]) => kind.endsWith(JUDGE_TASK_SUFFIX) || EXTRA_JUDGE_KINDS.has(kind))
    .map(([kind, def]) => ({
      kind,
      // Only a real Zod-like schema counts. Guards against null/false/'' reading as compliant.
      hasStructuredOutput:
        typeof (def.structuredOutputSchema as { safeParse?: unknown } | undefined)?.safeParse ===
        'function',
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

// ── allowlist contract (same resolves_when shape as audit:fold-writes / audit:schema) ──

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
  /** judge tasks with no structuredOutputSchema and not allowlisted. */
  violations: string[];
  /** judge tasks with no structuredOutputSchema but explicitly allowlisted. */
  allowlisted: string[];
  allowlistProblems: AllowlistProblem[];
  /**
   * Allowlist keys that do not match a missing-schema judge task: dead config, same drift check
   * as audit:fold-writes.
   */
  redundantAllowlist: string[];
  ok: boolean;
};

/**
 * A judge task is compliant iff it declares a schema; otherwise it must carry a valid allowlist
 * entry. Pure.
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
        '  dispatch on `structured_output`-or-text-parse with it at the judge call site (see\n' +
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

// CLI-gate: only run when invoked directly, so importing the pure functions has no side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
