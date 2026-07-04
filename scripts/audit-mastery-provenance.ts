/**
 * audit:mastery-provenance — 借用 provenance 消费纪律审计 (YUK-559 / S2, worklist #6)
 *
 * 决策来源：docs/design/2026-07-04-kg-borrowing-spec.md M2″ / Q1′-L ③。RP2「observed/
 * inferred 投影层混装」的可观测半：S1 给 `MasteryProjection` 加了 `provenance` 判别式 +
 * `theta_hat_raw` 就地平滑可见性，本审计确保**新增消费者不会把借用/被平滑值静默当实测**。
 *
 * ── 是什么 ──────────────────────────────────────────────────────────────
 *
 * `getMasteryProjection`（src/server/mastery/state.ts）今日返回两类条目混在一个 Map 里：
 *   - `provenance:'observed'`：KC 自己的 mastery_state 证据（count 驱动 p(L) band）。
 *   - `provenance:'inferred'`：A5/A6 借用软层给「请求但未观测」KC 合成的条目（dark）。
 * 二者仅靠 `provenance` + `evidence_count:0` 区分。一个读 `.mastery`/`.theta_hat` 却**不**
 * 看 provenance / isObserved / evidence_count 的消费者，翻 flag 后会把从未作答 KC 的借用
 * θ̃/合成 σ(−β) 当实测 mastery——本审计把这类站点标出来。
 *
 * ── 判据（默认 report-only，report 不 fail）───────────────────────────────
 *
 * 对每个 tracked consumer 文件（先 **stripCommentsAndStrings** 剥离注释 + 字符串/模板内容，
 * 再扫）：若它**读** projection field（`.mastery` / `.theta_hat`）但**不含**任何 **code-shaped**
 * provenance-guard（`.provenance` / `isObserved` / `.evidence_count` —— 成员读或 isObserved
 * 调用/导入，**非**裸标识符、**非** object-literal key `evidence_count:`）⇒ UNGUARDED。UNGUARDED
 * 且不在 allowlist ⇒ FLAGGED（报告）。tracked 文件不存在 ⇒ MISSING（tracked 列表是手维护契约，
 * 改名/删除的 consumer 须重新接地，不静默跳过 → MISSING 也 fail，`--strict` 非零 exit，C2）。
 * allowlist 条目须带 `resolves_when{kind,ref,expected_by}`（同 audit:schema 契约）。
 *
 * 判据是 **file-scope 启发式**（剥离后 code-token 反查，非 AST 作用域）——与 audit:relations 的
 * file:marker 反查同源、同样声明式 + 反查、同样有 shape 限制。**残留限制（不代码修）**：
 * DTO-surfacing / 无关同名字段仍可能假 guarded（node-page / tree / detail / placement-profile
 * 携同名 `.provenance` / `.evidence_count` 字段却未真正 gate 本 projection 的借用行为）——AST 语义
 * 检测超本轮修复；`--strict` 升 hard-gate 须配人工复核 flagged/guarded verdict（开放问题 4）。tracked
 * 列表手维护 = getMasteryProjection 的直接 caller + 命名的传递消费者。这忠于「report-only 埋点、
 * 硬 gate 待翻 flag 前置」（M2″：升 hard-gate 绑「任一借用 flag 翻转」前置，开放问题 4）。
 *
 * ── 默认 report-only（exit 0）；--strict 才非零 exit ──────────────────────────
 *
 * 今日全 dark（GRAPH_LAPLACIAN_ENABLED / PREREQ_THETA_PROPAGATION_ENABLED 皆 false）⇒
 * 零 live 借用条目 ⇒ 无真实误用。故默认只报告、不进 pre-PR 硬链。升级为硬 gate 是 owner
 * 决策（M2″ / §7 开放问题 4，绑任一借用 flag 翻转）。
 *
 * 用法：
 *   pnpm audit:mastery-provenance          # 报告（report-only）
 *   pnpm audit:mastery-provenance --json   # JSON 输出
 *   pnpm audit:mastery-provenance --strict # FLAGGED 或坏 allowlist 即非零 exit（CI gate 模式）
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = join(__dirname, 'audit-mastery-provenance-allowlist.json');

// ── tracked consumers ────────────────────────────────────────────────────
//
// getMasteryProjection 的 9 个直接 call site（spec §1.1 终裁 grep 实数）+ 命名的传递
// 消费者（conjectures/evidence.ts 收 caller 解析好的 projection）。state.ts 自身是
// provenance 的 PRODUCER（定义判别式 + isObserved），不列为 consumer。
// 新增「读 MasteryProjection field」的消费路径时，在此补一条（否则不在反查覆盖内 —
// 同 audit:relations CONSUMER_REGISTRY 的已知 shape 限制）。
export const TRACKED_CONSUMERS: readonly string[] = [
  'src/capabilities/agency/jobs/research_meeting_nightly.ts',
  'src/capabilities/notes/server/mastery-progress-signal.ts',
  'src/capabilities/knowledge/server/node-page.ts',
  'src/capabilities/knowledge/server/frontier-read.ts',
  'src/capabilities/knowledge/server/tree.ts',
  'src/capabilities/practice/server/learnable-frontier.ts',
  'src/capabilities/practice/api/placement-profile.ts',
  'src/server/ai/tools/knowledge-readers.ts',
  'src/server/questions/detail.ts',
  // transitive consumer (spec §1.1): receives a caller-parsed projection.
  'src/server/conjectures/evidence.ts',
] as const;

// ── comment/string stripping (char-stepped, escape-aware) ─────────────────
//
// Both the field-read and guard scans run on the SOURCE WITH COMMENTS AND STRING/TEMPLATE
// CONTENT REMOVED, so a `.mastery` inside a docstring or a bare `evidence_count` token quoted
// in a comment (as in knowledge-readers.ts / conjectures/evidence.ts) is NOT mistaken for a
// real code read/guard. Char-stepping technique mirrors audit-draft-status.ts extractObjectBlock
// (line/block comments; single/double/template strings; escape-aware; `${…}` interpolation code
// is KEPT so `${proj.mastery}` still counts). Nested templates-inside-interpolation are handled
// approximately (a documented heuristic limitation). Regex literals are NOT stripped either — a
// pattern like `/\.mastery\b/` or `/\.theta_hat/` in a tracked consumer would survive and match
// FIELD_READ_RE, yielding a false field-read positive. JS regex-vs-divide lexing is ambiguous
// enough that a heuristic stripper is not worth the risk; no current tracked consumer contains
// such a regex, so this stays a documented limitation (alongside the DTO-surfacing `guarded`
// heuristic noted on scanFile) rather than a code fix.
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  // brace depth (tracked only to know when a `}` closes a `${…}` interpolation vs a plain block).
  let braceDepth = 0;
  const interpStack: number[] = [];
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        inTemplate = false;
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        // enter interpolation — resume emitting CODE until the matching `}`.
        interpStack.push(braceDepth);
        braceDepth += 1;
        inTemplate = false;
        i += 2;
        continue;
      }
      i += 1; // strip template text
      continue;
    }
    // not in any string/comment.
    if (c === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (c === '{') {
      braceDepth += 1;
      out += c;
      i += 1;
      continue;
    }
    if (c === '}') {
      braceDepth -= 1;
      if (interpStack.length > 0 && interpStack[interpStack.length - 1] === braceDepth) {
        // closes a `${…}` interpolation → back to template text; do not emit the brace.
        interpStack.pop();
        inTemplate = true;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── field-read + guard-token detection (on the stripped source) ───────────
//
// `.mastery`（\b 排除 .mastery_lo / .mastery_hi / .mastery_state）与 `.theta_hat`
// （\b 排除 .theta_hat_raw / .theta_hat_json）的读取。
const FIELD_READ_RE = /\.mastery\b|\.theta_hat\b/;

// provenance-awareness guards — CODE-SHAPED (not bare substring): a member read `.provenance`
// / `.evidence_count`, or an `isObserved` call/import. A bare identifier or an object-literal
// KEY (`evidence_count:`) does NOT guard — a guard must be a real read of the discriminant.
export const GUARD_TOKEN_PATTERNS: readonly RegExp[] = [
  /\.provenance\b/,
  /\bisObserved\b/,
  /\.evidence_count\b/,
] as const;

export type FileScan = {
  /** reads a MasteryProjection field (`.mastery` / `.theta_hat`). */
  readsField: boolean;
  /** references at least one provenance-guard token. */
  guarded: boolean;
};

/**
 * Scan one file's source for projection-field reads + guard tokens, on the COMMENT/STRING-
 * STRIPPED source. Pure. NOTE (heuristic limitation): `guarded` is a post-strip code-token
 * heuristic, NOT AST scope analysis — a file that merely DTO-surfaces a same-named field
 * (`provenance` / `evidence_count` on an unrelated shape — node-page / tree / detail /
 * placement-profile carry such fields) can read as guarded without actually gating the
 * borrow-aware behaviour on THIS projection. Upgrading `--strict` to a hard gate must pair
 * with human review of the flagged/guarded verdicts (spec §7 open question 4).
 */
export function scanFile(src: string): FileScan {
  const code = stripCommentsAndStrings(src);
  return {
    readsField: FIELD_READ_RE.test(code),
    guarded: GUARD_TOKEN_PATTERNS.some((re) => re.test(code)),
  };
}

// ── allowlist contract (mirrors audit:schema resolves_when) ───────────────

export type ResolvesWhen = { kind: 'pr' | 'phase' | 'manual'; ref: string; expected_by: string };
export type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };
export type Allowlist = Record<string, AllowlistEntry>;

export type AllowlistProblem = {
  file: string;
  problem:
    | 'missing_reason'
    | 'invalid_resolves_when'
    | 'invalid_kind'
    | 'invalid_ref'
    | 'invalid_expected_by'
    | 'expired_expected_by';
  detail: string;
};

/** Validate one allowlist entry against the resolves_when contract. Pure. */
export function validateAllowlistEntry(
  file: string,
  entry: AllowlistEntry,
  today: string,
): AllowlistProblem[] {
  const problems: AllowlistProblem[] = [];
  // loadAllowlist() casts JSON.parse output with an unsafe `as Allowlist`, so a hand-edited
  // allowlist may carry a null / non-object value. Guard first: report it gracefully as an
  // invalid entry rather than TypeError-crashing on entry.reason / entry.resolves_when.
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [
      {
        file,
        problem: 'invalid_resolves_when',
        detail: 'allowlist entry must be an object with reason/resolves_when',
      },
    ];
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
    problems.push({ file, problem: 'missing_reason', detail: 'reason must be a non-empty string' });
  }
  const rw = entry.resolves_when;
  if (rw === null || typeof rw !== 'object') {
    problems.push({
      file,
      problem: 'invalid_resolves_when',
      detail: 'resolves_when must be { kind, ref, expected_by }',
    });
    return problems;
  }
  if (rw.kind !== 'pr' && rw.kind !== 'phase' && rw.kind !== 'manual') {
    problems.push({
      file,
      problem: 'invalid_kind',
      detail: "resolves_when.kind must be 'pr', 'phase', or 'manual'",
    });
  }
  if (typeof rw.ref !== 'string' || rw.ref.trim().length === 0) {
    problems.push({ file, problem: 'invalid_ref', detail: 'resolves_when.ref must be non-empty' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rw.expected_by)) {
    problems.push({
      file,
      problem: 'invalid_expected_by',
      detail: 'resolves_when.expected_by must be YYYY-MM-DD',
    });
  } else if (Number.isNaN(Date.parse(rw.expected_by))) {
    problems.push({
      file,
      problem: 'invalid_expected_by',
      detail: `resolves_when.expected_by ${rw.expected_by} is not a valid date`,
    });
  } else if (rw.expected_by < today) {
    problems.push({
      file,
      problem: 'expired_expected_by',
      detail: `resolves_when.expected_by ${rw.expected_by} is before ${today}`,
    });
  }
  return problems;
}

// ── audit ─────────────────────────────────────────────────────────────────

export type ConsumerVerdict = {
  file: string;
  status: 'missing' | 'guarded' | 'no-field-read' | 'allowlisted' | 'flagged';
};

/** Fixed-width console tag per verdict status (lookup map — nested ternaries are banned). */
const STATUS_TAGS: Record<ConsumerVerdict['status'], string> = {
  flagged: 'FLAGGED',
  allowlisted: 'allow  ',
  guarded: 'guarded',
  'no-field-read': 'no-read',
  missing: 'MISSING',
};

export type ProvenanceAuditResult = {
  verdicts: ConsumerVerdict[];
  /** unguarded field-reading consumers NOT covered by the allowlist. */
  flagged: string[];
  /** tracked consumers whose file no longer exists (stale tracked list → drift). */
  missing: string[];
  /** allowlist entries whose file is now guarded (allowlist entry redundant → drift). */
  redundantAllowlist: string[];
  /** allowlist schema problems. */
  allowlistProblems: AllowlistProblem[];
  /**
   * true iff no flagged consumers, no MISSING tracked files, no redundant allowlist entries,
   * and no allowlist problems. A MISSING tracked file fails the audit — the tracked list is a
   * hand-maintained contract, so a renamed/deleted consumer must be re-grounded, not silently
   * skipped (C2).
   */
  ok: boolean;
};

/**
 * Core audit. For each tracked consumer, classify it; a field-reading, unguarded,
 * non-allowlisted consumer is FLAGGED. `readFile` + `allowlist` injected for unit
 * testing without touching disk. Pure.
 */
export function computeProvenanceAudit(
  tracked: readonly string[],
  readFile: (relPath: string) => string | null,
  allowlist: Allowlist,
  today: string,
): ProvenanceAuditResult {
  const verdicts: ConsumerVerdict[] = [];
  const flagged: string[] = [];
  const missing: string[] = [];
  const redundantAllowlist: string[] = [];
  const allowlistProblems: AllowlistProblem[] = [];

  for (const file of tracked) {
    const src = readFile(file);
    if (src === null) {
      verdicts.push({ file, status: 'missing' });
      missing.push(file);
      continue;
    }
    const scan = scanFile(src);
    const allowed = Object.hasOwn(allowlist, file);
    if (!scan.readsField) {
      verdicts.push({ file, status: 'no-field-read' });
      if (allowed) redundantAllowlist.push(file); // allowlisted but reads no field → drift
      continue;
    }
    if (scan.guarded) {
      verdicts.push({ file, status: 'guarded' });
      if (allowed) redundantAllowlist.push(file); // allowlisted but now guarded → drift
      continue;
    }
    // unguarded field read
    if (allowed) {
      verdicts.push({ file, status: 'allowlisted' });
      allowlistProblems.push(...validateAllowlistEntry(file, allowlist[file], today));
    } else {
      verdicts.push({ file, status: 'flagged' });
      flagged.push(file);
    }
  }

  // Reverse check: allowlist entries whose file is no longer in TRACKED_CONSUMERS are
  // dead configuration (e.g. a consumer renamed and re-added under a new path). Surface
  // them via the same redundantAllowlist channel so they fail --strict instead of
  // silently accumulating.
  const trackedSet = new Set(tracked);
  for (const file of Object.keys(allowlist)) {
    if (!trackedSet.has(file)) redundantAllowlist.push(file);
  }

  return {
    verdicts,
    flagged,
    missing,
    redundantAllowlist,
    allowlistProblems,
    ok:
      flagged.length === 0 &&
      missing.length === 0 &&
      redundantAllowlist.length === 0 &&
      allowlistProblems.length === 0,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function loadAllowlist(): Allowlist {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));
    // Syntactically-valid JSON can still be a non-object root (null / array / scalar).
    // Object.hasOwn / allowlist[file] on such a value would misbehave (crash or coerce),
    // so treat it like a corrupt file: diagnose to stderr and degrade to {} (fail-visible).
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `[audit:mastery-provenance] allowlist at ${ALLOWLIST_PATH} has a non-object root (${Array.isArray(parsed) ? 'array' : typeof parsed}); treating as empty — previously-allowlisted consumers will FLAG`,
      );
      return {};
    }
    return parsed as Allowlist;
  } catch (err) {
    // A corrupt / missing allowlist silently degrades to {} → every previously-allowlisted
    // consumer flips to FLAGGED (and --strict CI fails) with no visible root cause. Emit a
    // stderr diagnostic so the failure mode is attributable; behaviour (return {}) unchanged.
    console.error(
      `[audit:mastery-provenance] failed to load allowlist at ${ALLOWLIST_PATH}; treating as empty — previously-allowlisted consumers will FLAG:`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');
  const today = new Date().toISOString().slice(0, 10);
  const result = computeProvenanceAudit(TRACKED_CONSUMERS, readFileOrNull, loadAllowlist(), today);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('audit:mastery-provenance — 借用 provenance 消费纪律审计 (YUK-559 / S2)\n');
    for (const v of result.verdicts) {
      console.log(`  [${STATUS_TAGS[v.status]}] ${v.file}`);
    }
    console.log('');
    if (result.flagged.length === 0) {
      console.log('  FLAGGED (unguarded field read, not allowlisted):  (none)');
    } else {
      console.log(`  FLAGGED (unguarded field read, not allowlisted):  ${result.flagged.length}`);
      for (const f of result.flagged) {
        console.log(
          `    - ${f}: reads .mastery/.theta_hat without provenance/isObserved/evidence_count. Gate borrow-aware behaviour on provenance (isObserved) or evidence_count, or add an allowlist entry with resolves_when.`,
        );
      }
    }
    if (result.missing.length > 0) {
      console.log(
        `\n  MISSING (tracked consumer file not found — re-ground the tracked list):  ${result.missing.length}`,
      );
      for (const f of result.missing) console.log(`    - ${f}`);
    }
    if (result.redundantAllowlist.length > 0) {
      console.log(
        `\n  REDUNDANT allowlist entries (file now guarded / reads no field):  ${result.redundantAllowlist.length}`,
      );
      for (const f of result.redundantAllowlist) console.log(`    - ${f}: drop from allowlist.`);
    }
    if (result.allowlistProblems.length > 0) {
      console.log(`\n  ALLOWLIST problems:  ${result.allowlistProblems.length}`);
      for (const p of result.allowlistProblems) console.log(`    - ${p.file}: ${p.detail}`);
    }
    console.log(
      '\n  report-only (exit 0). Today all borrow flags are dark ⇒ no live inferred entries. ' +
        'Upgrading to a hard gate is an owner decision, gated on "any borrow flag flips on" ' +
        '(spec §7 open question 4).',
    );
  }

  // Default report-only; --strict opts into a CI gate.
  if (isStrict && !result.ok) process.exit(1);
}

// CLI-gate (mirrors audit-relations.ts): only run + exit when invoked as a CLI so the
// self-test can import the pure functions without the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
