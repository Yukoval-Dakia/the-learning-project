// YUK-573 (leg B) — judge prompt-render SNAPSHOT golden: freeze the rendered
// system prompt of each judge task × every registry profile and diff on every
// gate run. This is the prompt-change regression net the leg A replay cannot
// provide (a frozen LLM output is mathematically blind to prompt edits — MF7):
// any edit that reaches getTaskSystemPrompt('SemanticJudgeTask'|'StepsJudgeTask'
// |'MultimodalDirectJudgeTask', profile) fails this gate until the author
// re-runs `--write`, turning the change into a reviewable snapshot diff in the
// PR. Pure + offline + zero cost (getTaskSystemPrompt is a pure function).
//
// Model changes remain uncovered by BOTH legs — that surface belongs to the
// Deliverable 2 agreement sampling (design doc §2.1).
//
// CLI:
//   pnpm audit:judge-prompts             # check, report-only, exit 0
//   pnpm audit:judge-prompts --strict    # check, exit 1 on drift
//   pnpm audit:judge-prompts --write     # regenerate snapshots (intentional prompt change)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AiTaskKind, getTaskSystemPrompt } from '@/ai/task-prompts';
import { subjectProfiles } from '@/subjects/profile';

/** The three outcome-bit-producing judge tasks (design doc §0). */
export const JUDGE_PROMPT_TASKS: readonly AiTaskKind[] = [
  'SemanticJudgeTask',
  'StepsJudgeTask',
  'MultimodalDirectJudgeTask',
];

export const PROMPTS_DIR = resolve(
  fileURLToPath(new URL('./judge-golden/prompts', import.meta.url)),
);

export function snapshotFileName(kind: AiTaskKind, profileId: string): string {
  return `${kind}.${profileId}.md`;
}

/** Render every judge task × registry profile. Pure; deterministic. */
export function renderAllJudgePrompts(): Map<string, string> {
  const out = new Map<string, string>();
  const profileIds = Object.keys(subjectProfiles).sort();
  for (const kind of JUDGE_PROMPT_TASKS) {
    for (const id of profileIds) {
      const profile = subjectProfiles[id];
      if (!profile) continue;
      // getTaskSystemPrompt takes the KIND STRING (task-prompts.ts:919 — r3
      // 复核吸收 4②), not a registry task object.
      out.set(snapshotFileName(kind, id), `${getTaskSystemPrompt(kind, profile)}\n`);
    }
  }
  return out;
}

export interface PromptReauditResult {
  checked: number;
  /** human-readable drift lines: missing / content-drift / stale snapshots. */
  drifted: string[];
}

/**
 * True when EVERY rendered prompt is missing its snapshot — i.e. the snapshot
 * dir is absent/empty and the gate would be a silent no-op (leg A's empty-dir
 * exit-2 guard, mirrored per OCR review). Content drift on existing snapshots
 * does NOT trip this.
 */
export function isSilentNoOp(result: PromptReauditResult): boolean {
  return (
    result.checked > 0 &&
    result.drifted.length >= result.checked &&
    result.drifted.filter((d) => d.includes('MISSING')).length >= result.checked
  );
}

/** Diff rendered prompts vs committed snapshots in `dir` (default: committed dir). */
export function reauditJudgePrompts(dir: string = PROMPTS_DIR): PromptReauditResult {
  const rendered = renderAllJudgePrompts();
  const drifted: string[] = [];
  const onDisk = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : []);

  for (const [file, content] of rendered) {
    if (!onDisk.has(file)) {
      drifted.push(`${file}: MISSING snapshot — run pnpm audit:judge-prompts --write`);
      continue;
    }
    const committed = readFileSync(resolve(dir, file), 'utf8');
    if (committed !== content) {
      drifted.push(
        `${file}: CONTENT drift — the rendered prompt no longer matches the committed snapshot`,
      );
    }
  }
  for (const file of onDisk) {
    if (!rendered.has(file)) {
      drifted.push(`${file}: STALE snapshot — no current judge task × profile renders it`);
    }
  }
  return { checked: rendered.size, drifted };
}

/** Regenerate every snapshot (intentional prompt change). Returns written file names. */
export function writeJudgePromptSnapshots(dir: string = PROMPTS_DIR): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [file, content] of renderAllJudgePrompts()) {
    writeFileSync(resolve(dir, file), content);
    written.push(file);
  }
  return written;
}

function main(): void {
  if (process.argv.includes('--write')) {
    const written = writeJudgePromptSnapshots();
    console.log(
      [
        `[judge-prompt-reaudit] wrote ${written.length} snapshot(s) → ${PROMPTS_DIR}`,
        'Commit the diff — it is the reviewable record of the prompt change.',
      ].join('\n'),
    );
    process.exit(0);
  }
  const strict = process.argv.includes('--strict');
  const result = reauditJudgePrompts();
  if (isSilentNoOp(result)) {
    console.error(
      '[judge-prompt-reaudit] no snapshot files under scripts/judge-golden/prompts/ — the gate would be a silent no-op. Run `pnpm audit:judge-prompts --write` and commit the snapshots.',
    );
    process.exit(2);
  }
  if (result.drifted.length === 0) {
    console.log(
      `judge-prompt-reaudit — ${result.checked} rendered prompt(s) match their snapshots. CLEAN.`,
    );
    process.exit(0);
  }
  console.log(`judge-prompt-reaudit — ${result.drifted.length}/${result.checked} DRIFTED:`);
  for (const line of result.drifted) console.log(`  - ${line}`);
  console.log(
    [
      '\nIf the prompt change is INTENTIONAL, re-freeze with `pnpm audit:judge-prompts --write`',
      'and commit the snapshot diff; otherwise revert the prompt edit.',
    ].join('\n'),
  );
  process.exit(strict ? 1 : 0);
}

// CLI-gate (capture-golden.ts precedent): only run as the entry point so tests can import.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
