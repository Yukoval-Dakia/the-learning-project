/**
 * audit:structured-judge — judge tasks must declare a structured-output contract.
 *
 * Every judge task in the AI task registry must declare a `structuredOutputSchema`, consumed at
 * the call site by the structured-output-or-text-parse dispatch. Free-text JSON fishing turns
 * malformed output into silent `unsupported` waste; this audit stops a new judge task from
 * regressing to it.
 *
 * Judge detection is suffix-based (`*JudgeTask`) plus a small explicit extras list, so a
 * differently named judge can escape the sweep. This is a hard gate: it runs in the test chain and
 * fails on any violation.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from '@/capabilities/task-registry';

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

// ── audit verdict ──────────────────────────────────────────────────────────────

export type StructuredJudgeAuditResult = {
  judgeTasks: JudgeTaskDecl[];
  /** judge tasks with no structuredOutputSchema. */
  violations: string[];
  ok: boolean;
};

/** A judge task is compliant iff it declares a schema. Pure. */
export function computeStructuredJudgeAudit(
  judgeTasks: JudgeTaskDecl[],
): StructuredJudgeAuditResult {
  const violations = judgeTasks
    .filter((task) => !task.hasStructuredOutput)
    .map((task) => task.kind);
  return { judgeTasks, violations, ok: violations.length === 0 };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(): void {
  const isJson = process.argv.includes('--json');

  const judgeTasks = collectJudgeTasks(tasks as Record<string, TaskDefLike>);
  const result = computeStructuredJudgeAudit(judgeTasks);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  console.log('audit:structured-judge — judge tasks must declare structured output (YUK-591 §7)\n');
  console.log('  judge tasks (kind → structured-output declared):');
  for (const task of result.judgeTasks) {
    console.log(
      `    - ${task.kind.padEnd(28)} ${task.hasStructuredOutput ? 'declared' : 'MISSING'}`,
    );
  }
  console.log('');

  if (result.violations.length === 0) {
    console.log('  VIOLATIONS (judge task with no structuredOutputSchema):  (none)');
  } else {
    console.log(
      `  VIOLATIONS (judge task with no structuredOutputSchema):  ${result.violations.length}`,
    );
    for (const kind of result.violations) console.log(`    - ${kind}`);
    console.log(
      '\n  Fix: declare `structuredOutputSchema: <ZodSchema>` on the task in src/ai/registry.ts and\n' +
        '  dispatch on `structured_output`-or-text-parse with it at the judge call site (see\n' +
        '  steps-judge.ts / multimodal-direct-judge.ts).',
    );
  }
  console.log('');

  console.log(
    '  §7 (owner-locked 2026-07-23): judge tasks funnel free-text model output into a verdict; a\n' +
      '  structured-output declaration turns malformed-output waste into schema-enforced extraction.\n' +
      '  Hard gate — a new judge task must declare it.',
  );

  if (!result.ok) process.exit(1);
}

// CLI-gate: only run when invoked directly, so importing the pure functions has no side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
