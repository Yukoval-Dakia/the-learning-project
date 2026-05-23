# L6 `audit:schema` Allowlist Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `pnpm audit:schema` 增加 allowlist `resolves_when` 结构校验与过期校验，防止 schema write-path allowlist 永久累积。

**Architecture:** `scripts/audit-schema-writes.ts` 保持单一入口，新增纯函数校验 allowlist hygiene：非 `_comment*` entry 必须使用对象形态 `resolves_when`，并按 `expected_by`、已合 PR、已 ship phase 三类规则 fail。当前 allowlist 做机械 reformat，不删除 entry；legacy 文本保存在 `resolves_when.ref`，并用 `kind: 'manual'` 明确表示需要人工判断的历史解除条件。

**Tech Stack:** TypeScript / Node fs + git log local inspection / Vitest unit tests / existing `pnpm audit:schema`

**Spec source:** `docs/superpowers/plans/2026-05-23-track2-and-foundation-closeout-phases.md` §L6 + Linear `YUK-45`

**Baseline observed on 2026-05-23:**
- `scripts/audit-schema-allowlist.json`: 69 top-level keys, 67 business entries, 2 `_comment*` markers.
- `YUK-45` body still says 35 entries; current repo and plan SoT say 67 business entries. This plan follows current repo state.
- `pnpm audit:schema --json` passes in normal permissions with 0 unallowed stubs and 16 currently allowed stubs. In sandbox it may fail with `listen EPERM` from `tsx`; treat that as environment-only and rerun normally.

---

## Boundaries

- Do not remove or reinterpret existing allowlist entries in this lane.
- Do not change the schema write-path scanning algorithm.
- Do not add network calls to GitHub or Linear from `audit:schema`.
- Do not touch UI; design-doc pre-flight is not applicable.
- Do not update `YUK-45` state or create a branch until execution starts after plan approval.

---

## File Structure

### Create
- `scripts/audit-schema-writes.test.ts` — pure unit coverage for allowlist `resolves_when` schema, PR merge detection, phase shipped detection, date expiry, and `_comment` marker handling.

### Modify
- `scripts/audit-schema-writes.ts` — export pure helpers, guard CLI execution on direct run, validate allowlist before reporting, include hygiene issues in JSON/non-JSON output.
- `scripts/audit-schema-allowlist.json` — mechanically convert all 67 business entries from string `resolves_when` to object form while preserving `reason` and old text.
- `CLAUDE.md` — document the new allowlist object schema and how `kind` is interpreted.

---

## Task 0: Execution Setup After Approval

**Files:**
- No file changes.

- [ ] **Step 1: Sync main**

Run:

```bash
git checkout main
git pull --ff-only
```

Expected: current branch is `main`, up to date with `origin/main`.

- [ ] **Step 2: Create the YUK-45 branch**

Run:

```bash
git checkout -b yuk-45-audit-schema-allowlist-expiry
```

Expected: branch name is `yuk-45-audit-schema-allowlist-expiry`.

- [ ] **Step 3: Move Linear issue to In Progress**

Use Linear `save_issue`:

```json
{
  "id": "YUK-45",
  "state": "In Progress"
}
```

Expected: Linear `YUK-45` status is `In Progress`.

---

## Task 1: Write Failing Unit Tests For Allowlist Hygiene

**Files:**
- Create: `scripts/audit-schema-writes.test.ts`
- Modify: `scripts/audit-schema-writes.ts`

- [ ] **Step 1: Add the failing test file**

Create `scripts/audit-schema-writes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  extractMergedPrRefsFromGitLog,
  validateAllowlistHygiene,
} from './audit-schema-writes';

const OPTIONS = {
  today: '2026-05-23',
  mergedPrRefs: new Set<string>(),
  statusText: '',
};

describe('audit-schema allowlist hygiene', () => {
  it('rejects legacy string resolves_when on business entries', () => {
    const result = validateAllowlistHygiene(
      {
        'question.rubric_json': {
          reason: 'Sub 1 JudgeTask grading config; not yet written by ingestion',
          resolves_when: 'Sub 1 JudgeTask + question authoring path implemented',
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'question.rubric_json',
        code: 'invalid_resolves_when',
      }),
    ]);
    expect(result.allowlist).toEqual({});
  });

  it('does not require reason or resolves_when on _comment markers', () => {
    const result = validateAllowlistHygiene(
      {
        _comment: 'schema fields with no write path',
        _comment_phase1c1_lane_a: 'historical marker',
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([]);
    expect(result.allowlist).toEqual({});
  });

  it('rejects entries whose expected_by date has passed', () => {
    const result = validateAllowlistHygiene(
      {
        'answer.input_kind': {
          reason: 'Answer table currently unused; review submit will write',
          resolves_when: {
            kind: 'manual',
            ref: 'Phase 1c.2 review submit path implemented',
            expected_by: '2026-05-22',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'answer.input_kind',
        code: 'expired_expected_by',
      }),
    ]);
  });

  it('extracts merged PR refs from squash-merge and merge-commit subjects', () => {
    const refs = extractMergedPrRefsFromGitLog(
      [
        'a2b119a docs(plan): YUK-38 fix codex review findings + Linear reorg (#107)',
        'abc1234 Merge pull request #104 from Yukoval-Dakia/yuk-38-track2',
        'def5678 chore: unrelated commit',
      ].join('\n'),
    );

    expect([...refs].sort()).toEqual(['104', '107']);
  });

  it('rejects pr entries whose ref is already merged into local history', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.title': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'pr',
            ref: '#107',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        mergedPrRefs: new Set(['107']),
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.title',
        code: 'merged_pr',
      }),
    ]);
  });

  it('rejects phase entries whose ref appears in a shipped status line', () => {
    const result = validateAllowlistHygiene(
      {
        'artifact.generated_by': {
          reason: 'Same as artifact.id',
          resolves_when: {
            kind: 'phase',
            ref: 'Foundation closeout P0',
            expected_by: '2026-07-31',
          },
        },
      },
      {
        ...OPTIONS,
        statusText:
          '**最后更新**：2026-05-23（Foundation closeout P-1 + P0 已 ship — PR #86 / #91）',
      },
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        key: 'artifact.generated_by',
        code: 'shipped_phase',
      }),
    ]);
  });

  it('accepts manual entries that preserve the current legacy text as ref', () => {
    const result = validateAllowlistHygiene(
      {
        'memory_brief_note.scope_key': {
          reason:
            'Schema lands in the LearningRecord migration; scheduled Dreaming refresh writes the row in the next batch',
          resolves_when: {
            kind: 'manual',
            ref: 'memory_brief_refresh boss handler implemented',
            expected_by: '2026-07-31',
          },
        },
      },
      OPTIONS,
    );

    expect(result.issues).toEqual([]);
    expect(result.allowlist['memory_brief_note.scope_key']).toEqual({
      reason:
        'Schema lands in the LearningRecord migration; scheduled Dreaming refresh writes the row in the next batch',
      resolves_when: {
        kind: 'manual',
        ref: 'memory_brief_refresh boss handler implemented',
        expected_by: '2026-07-31',
      },
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
pnpm vitest run --config vitest.unit.config.ts scripts/audit-schema-writes.test.ts
```

Expected: FAIL because `scripts/audit-schema-writes.ts` does not export `extractMergedPrRefsFromGitLog` or `validateAllowlistHygiene`, and importing the script still runs the CLI entrypoint.

- [ ] **Step 3: Commit the red test file if using subagent-driven review checkpoints**

```bash
git add scripts/audit-schema-writes.test.ts
git commit -m "test: YUK-45 cover audit schema allowlist expiry"
```

Expected: commit succeeds on branch `yuk-45-audit-schema-allowlist-expiry`. If using inline execution without checkpoint commits, keep the changes staged for later.

---

## Task 2: Implement Allowlist Hygiene Validation

**Files:**
- Modify: `scripts/audit-schema-writes.ts`

- [ ] **Step 1: Add imports for local git/status inspection**

Change the import block at the top from:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
```

to:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
```

- [ ] **Step 2: Replace allowlist types with the object schema**

Replace:

```ts
type AllowlistEntry = { reason: string; resolves_when: string };
type Allowlist = Record<string, AllowlistEntry>;
```

with:

```ts
type ResolveKind = 'pr' | 'phase' | 'manual';
type ResolvesWhen = {
  kind: ResolveKind;
  ref: string;
  expected_by: string;
};
type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };
type Allowlist = Record<string, AllowlistEntry>;
type AllowlistHygieneIssueCode =
  | 'invalid_entry'
  | 'missing_reason'
  | 'invalid_resolves_when'
  | 'invalid_kind'
  | 'invalid_ref'
  | 'invalid_expected_by'
  | 'expired_expected_by'
  | 'merged_pr'
  | 'shipped_phase';
export type AllowlistHygieneIssue = {
  key: string;
  code: AllowlistHygieneIssueCode;
  message: string;
};
type AllowlistHygieneOptions = {
  today: string;
  mergedPrRefs: Set<string>;
  statusText: string;
};
type AllowlistHygieneResult = {
  allowlist: Allowlist;
  issues: AllowlistHygieneIssue[];
};
```

- [ ] **Step 3: Add pure validation helpers**

Add this block after `const TRIVIAL_FIELDS = ...`:

```ts
const RESOLVE_KINDS = new Set<ResolveKind>(['pr', 'phase', 'manual']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizePrRef(ref: string): string | null {
  const match = ref.match(/(?:#|pull\/|PR\s*)?(\d+)/i);
  return match?.[1] ?? null;
}

function normalizePhaseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function isShippedStatusLine(line: string): boolean {
  return line.includes('✅') || /已\s*ship|shipped|done/i.test(line);
}

function isPhaseShipped(ref: string, statusText: string): boolean {
  const normalizedRef = normalizePhaseText(ref);
  if (!normalizedRef) return false;
  return statusText
    .split('\n')
    .filter(isShippedStatusLine)
    .some((line) => normalizePhaseText(line).includes(normalizedRef));
}

export function extractMergedPrRefsFromGitLog(log: string): Set<string> {
  const refs = new Set<string>();
  for (const match of log.matchAll(/\(#(\d+)\)|Merge pull request #(\d+)/gi)) {
    const ref = match[1] ?? match[2];
    if (ref) refs.add(ref);
  }
  return refs;
}

function readMergedPrRefs(): Set<string> {
  try {
    const log = execFileSync(
      'git',
      ['log', '--oneline', '--first-parent', '--decorate=short', '-n', '2000'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return extractMergedPrRefsFromGitLog(log);
  } catch {
    return new Set();
  }
}

function readStatusText(): string {
  const statusPath = resolve(REPO_ROOT, 'docs/superpowers/status.md');
  if (!existsSync(statusPath)) return '';
  return readFileSync(statusPath, 'utf8');
}

function issue(
  key: string,
  code: AllowlistHygieneIssueCode,
  message: string,
): AllowlistHygieneIssue {
  return { key, code, message };
}

export function validateAllowlistHygiene(
  raw: unknown,
  options: AllowlistHygieneOptions,
): AllowlistHygieneResult {
  const allowlist: Allowlist = {};
  const issues: AllowlistHygieneIssue[] = [];

  if (!isRecord(raw)) {
    return {
      allowlist,
      issues: [issue('<root>', 'invalid_entry', 'allowlist root must be a JSON object')],
    };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;

    if (!isRecord(value)) {
      issues.push(issue(key, 'invalid_entry', 'allowlist entry must be an object'));
      continue;
    }

    const reason = value.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      issues.push(issue(key, 'missing_reason', 'allowlist entry requires non-empty reason'));
      continue;
    }

    const resolvesWhen = value.resolves_when;
    if (!isRecord(resolvesWhen)) {
      issues.push(
        issue(
          key,
          'invalid_resolves_when',
          'resolves_when must be { kind, ref, expected_by }, not a legacy string',
        ),
      );
      continue;
    }

    const kind = resolvesWhen.kind;
    const ref = resolvesWhen.ref;
    const expectedBy = resolvesWhen.expected_by;

    if (typeof kind !== 'string' || !RESOLVE_KINDS.has(kind as ResolveKind)) {
      issues.push(issue(key, 'invalid_kind', "resolves_when.kind must be 'pr', 'phase', or 'manual'"));
      continue;
    }
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      issues.push(issue(key, 'invalid_ref', 'resolves_when.ref must be a non-empty string'));
      continue;
    }
    if (typeof expectedBy !== 'string' || !ISO_DATE_RE.test(expectedBy)) {
      issues.push(issue(key, 'invalid_expected_by', 'resolves_when.expected_by must be YYYY-MM-DD'));
      continue;
    }
    if (expectedBy < options.today) {
      issues.push(
        issue(
          key,
          'expired_expected_by',
          `resolves_when.expected_by ${expectedBy} is before ${options.today}`,
        ),
      );
      continue;
    }

    if (kind === 'pr') {
      const prRef = normalizePrRef(ref);
      if (!prRef) {
        issues.push(issue(key, 'invalid_ref', 'pr resolves_when.ref must contain a PR number'));
        continue;
      }
      if (options.mergedPrRefs.has(prRef)) {
        issues.push(issue(key, 'merged_pr', `resolves_when PR #${prRef} is already merged`));
        continue;
      }
    }

    if (kind === 'phase' && isPhaseShipped(ref, options.statusText)) {
      issues.push(issue(key, 'shipped_phase', `resolves_when phase "${ref}" is already shipped`));
      continue;
    }

    allowlist[key] = {
      reason,
      resolves_when: {
        kind: kind as ResolveKind,
        ref,
        expected_by: expectedBy,
      },
    };
  }

  return { allowlist, issues };
}
```

- [ ] **Step 4: Change `loadAllowlist()` to return raw JSON**

Replace:

```ts
function loadAllowlist(): Allowlist {
  if (!existsSync(ALLOWLIST_PATH)) return {};
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}
```

with:

```ts
function loadAllowlist(): unknown {
  if (!existsSync(ALLOWLIST_PATH)) return {};
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}
```

- [ ] **Step 5: Wire hygiene validation into `main()`**

In `main()`, replace:

```ts
  const results = audit();
  const allowlist = loadAllowlist();
  const stubs = results.filter((r) => r.status === 'stub');
```

with:

```ts
  const results = audit();
  const hygiene = validateAllowlistHygiene(loadAllowlist(), {
    today: todayIso(),
    mergedPrRefs: readMergedPrRefs(),
    statusText: readStatusText(),
  });
  const allowlist = hygiene.allowlist;
  const stubs = results.filter((r) => r.status === 'stub');
```

Then replace the JSON output block:

```ts
  if (asJson) {
    console.log(JSON.stringify({ results, unallowedStubs, allowedStubs }, null, 2));
    process.exit(listOnly ? 0 : unallowedStubs.length > 0 ? 1 : 0);
  }
```

with:

```ts
  if (asJson) {
    console.log(
      JSON.stringify(
        { results, unallowedStubs, allowedStubs, allowlistIssues: hygiene.issues },
        null,
        2,
      ),
    );
    process.exit(listOnly ? 0 : unallowedStubs.length > 0 || hygiene.issues.length > 0 ? 1 : 0);
  }
```

Before the existing `if (unallowedStubs.length > 0 && !listOnly)` block, add:

```ts
  if (hygiene.issues.length > 0 && !listOnly) {
    console.log('\n⚠️  Allowlist hygiene issues found:\n');
    for (const item of hygiene.issues) {
      console.log(`  - ${item.key}: ${item.code} — ${item.message}`);
    }
    console.log(
      "\nUse resolves_when: { kind: 'pr' | 'phase' | 'manual', ref: string, expected_by: 'YYYY-MM-DD' }.",
    );
    process.exit(1);
  }
```

- [ ] **Step 6: Guard CLI execution so tests can import helpers**

Replace the final line:

```ts
main();
```

with:

```ts
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
```

- [ ] **Step 7: Run the focused test and verify green**

Run:

```bash
pnpm vitest run --config vitest.unit.config.ts scripts/audit-schema-writes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit implementation if using checkpoint commits**

```bash
git add scripts/audit-schema-writes.ts scripts/audit-schema-writes.test.ts
git commit -m "feat: YUK-45 validate audit schema allowlist expiry"
```

Expected: commit succeeds.

---

## Task 3: Reformat The Existing Allowlist Entries

**Files:**
- Modify: `scripts/audit-schema-allowlist.json`

- [ ] **Step 1: Mechanically convert business entries**

Run a mechanical conversion that preserves every existing `reason`, preserves every old `resolves_when` string as `resolves_when.ref`, leaves `_comment*` markers unchanged, and sets the initial project-level expiry date to `2026-07-31`:

```bash
node -e 'const fs=require("node:fs"); const p="scripts/audit-schema-allowlist.json"; const data=JSON.parse(fs.readFileSync(p,"utf8")); for (const [key,value] of Object.entries(data)) { if (key.startsWith("_")) continue; if (!value || typeof value !== "object" || typeof value.resolves_when !== "string") throw new Error(`unexpected allowlist entry: ${key}`); value.resolves_when = { kind: "manual", ref: value.resolves_when, expected_by: "2026-07-31" }; } fs.writeFileSync(p, JSON.stringify(data,null,2)+"\n");'
```

Expected: all 67 business entries now have `resolves_when.kind/ref/expected_by`; `_comment` and `_comment_phase1c1_lane_a` remain strings.

- [ ] **Step 2: Verify entry counts did not change**

Run:

```bash
jq '. | with_entries(select(.key | startswith("_") | not)) | length' scripts/audit-schema-allowlist.json
```

Expected:

```text
67
```

Run:

```bash
jq 'keys | length' scripts/audit-schema-allowlist.json
```

Expected:

```text
69
```

- [ ] **Step 3: Verify there are no legacy string `resolves_when` values**

Run:

```bash
jq -e 'to_entries | map(select(.key | startswith("_") | not) | select(.value.resolves_when | type != "object")) | length == 0' scripts/audit-schema-allowlist.json
```

Expected: command exits 0 and prints `true`.

- [ ] **Step 4: Run schema audit**

Run:

```bash
pnpm audit:schema
```

Expected: PASS. If this fails with `listen EPERM` from `tsx`, rerun in normal permissions and record that the first failure was sandbox-only.

- [ ] **Step 5: Commit allowlist conversion if using checkpoint commits**

```bash
git add scripts/audit-schema-allowlist.json
git commit -m "chore: YUK-45 reformat audit schema allowlist expiry metadata"
```

Expected: commit succeeds.

---

## Task 4: Document The New Allowlist Contract

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the `pnpm audit:schema` paragraph**

In `CLAUDE.md`, replace the paragraph that starts with:

```md
`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段
```

with:

```md
`pnpm audit:schema` 扫描 `src/db/schema.ts` 所有业务字段，验证每个都有 INSERT 或 UPDATE write path。例外字段须在 `scripts/audit-schema-allowlist.json` 显式声明 `reason` + `resolves_when`，其中 `resolves_when` 必须是 `{ "kind": "pr" | "phase" | "manual", "ref": string, "expected_by": "YYYY-MM-DD" }`。`kind: "pr"` 的 `ref` 写 GitHub PR 号或 `#N`，若本地 git history 已包含该 PR 会 fail；`kind: "phase"` 的 `ref` 要能匹配 `docs/superpowers/status.md` 的已 ship 行；`kind: "manual"` 只用于无法机器判定的历史解除条件，仍受 `expected_by` 到期约束。引入新表 / 字段时，要么实现 write path，要么加入 allowlist 并标注可检查的解除条件。详见 `docs/design/2026-05-15-data-assumptions.md`。
```

- [ ] **Step 2: Run touched-file Biome check**

Run:

```bash
pnpm biome check CLAUDE.md scripts/audit-schema-writes.ts scripts/audit-schema-writes.test.ts
```

Expected: PASS. If Biome reports formatting changes needed, run `pnpm biome check --write CLAUDE.md scripts/audit-schema-writes.ts scripts/audit-schema-writes.test.ts`, then rerun the check.

- [ ] **Step 3: Commit docs if using checkpoint commits**

```bash
git add CLAUDE.md
git commit -m "docs: YUK-45 document audit schema allowlist expiry"
```

Expected: commit succeeds.

---

## Task 5: Acceptance And Pre-PR Gate

**Files:**
- No new source files beyond previous tasks.

- [ ] **Step 1: Prove a merged PR ref fails**

Create a backup, then temporarily change one business entry in `scripts/audit-schema-allowlist.json` to a merged PR ref:

```bash
cp scripts/audit-schema-allowlist.json /tmp/yuk-45-audit-schema-allowlist.good.json
node -e 'const fs=require("node:fs"); const p="scripts/audit-schema-allowlist.json"; const data=JSON.parse(fs.readFileSync(p,"utf8")); data["learning_item.ai_score"].resolves_when = { kind: "pr", ref: "#107", expected_by: "2026-07-31" }; fs.writeFileSync(p, JSON.stringify(data,null,2)+"\n");'
```

Run:

```bash
pnpm audit:schema
```

Expected: FAIL with an allowlist hygiene issue containing `merged_pr`.

Restore the real allowlist before continuing:

```bash
cp /tmp/yuk-45-audit-schema-allowlist.good.json scripts/audit-schema-allowlist.json
```

Expected: `git diff -- scripts/audit-schema-allowlist.json` shows only the real object-schema conversion, not the temporary `#107` mutation.

- [ ] **Step 2: Prove the real allowlist passes**

Run:

```bash
pnpm audit:schema
```

Expected: PASS.

- [ ] **Step 3: Run the focused unit test**

Run:

```bash
pnpm vitest run --config vitest.unit.config.ts scripts/audit-schema-writes.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full pre-PR gate**

Run:

```bash
pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm test
```

Expected: PASS. DB tests require Docker/Testcontainers. If DB tests fail because Docker is unavailable, record the exact environment error and rerun once Docker is available before opening PR.

- [ ] **Step 5: Final commit if checkpoint commits were skipped**

```bash
git add scripts/audit-schema-writes.ts scripts/audit-schema-writes.test.ts scripts/audit-schema-allowlist.json CLAUDE.md
git commit -m "feat: YUK-45 enforce audit schema allowlist expiry"
```

Expected: commit message contains `YUK-45` and no bare `#N`.

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin yuk-45-audit-schema-allowlist-expiry
gh pr create --title "YUK-45 enforce audit:schema allowlist expiry" --body "Closes YUK-45"
```

Expected: PR created against `main`; Linear attaches through `Closes YUK-45`.

---

## Self-Review

**Spec coverage:**
- `pnpm audit:schema` parses `resolves_when`: Task 2.
- New schema `{ kind, ref, expected_by }`: Task 2 + Task 3 + Task 4.
- Existing business entries reformatted without removing entries: Task 3.
- `_comment` markers remain exempt: Task 1 test + Task 3 checks.
- Merged PR failure: Task 1 test + Task 5 acceptance.
- Shipped phase failure: Task 1 test + Task 2 status-line matching.
- CLAUDE.md command documentation: Task 4.

**Known spec tension resolved in this plan:**
- Linear says 35 entries, current repo says 67 business entries. Execution uses 67.
- Current legacy `resolves_when` strings are not all safely machine-classifiable without turning this lane into cleanup. This plan converts them to `kind: "manual"` to preserve semantics and keep L6 scoped to format + enforcement. New entries should use `kind: "pr"` or `kind: "phase"` when possible.

**Placeholder scan:** No task depends on unspecified paths or future code. All code snippets use concrete file paths and exact command lines.

**Type consistency:** Tests import `extractMergedPrRefsFromGitLog` and `validateAllowlistHygiene`; Task 2 exports those exact names and returns the exact `{ allowlist, issues }` shape.
