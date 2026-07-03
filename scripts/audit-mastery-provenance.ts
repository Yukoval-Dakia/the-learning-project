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
 * ── 判据（report-only，report 不 fail）─────────────────────────────────────
 *
 * 对每个 tracked consumer 文件：若它**读** projection field（`.mastery` / `.theta_hat`）
 * 但文件内**不含**任何 provenance-guard token（`provenance` / `isObserved` / `evidence_count`）
 * ⇒ UNGUARDED。UNGUARDED 且不在 allowlist ⇒ FLAGGED（报告）。allowlist 条目须带
 * `resolves_when{kind,ref,expected_by}`（同 audit:schema 契约）。
 *
 * 判据是 **file-scope 启发式**（非 AST 作用域）——与 audit:relations 的 file:marker 反查
 * 同源、同样是声明式 + 反查、同样有「未声明的新消费路径抓不到」的 shape 限制。tracked 列表
 * 手维护 = getMasteryProjection 的直接 caller + 命名的传递消费者。这忠于「report-only 埋点、
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

// ── field-read + guard-token detection ───────────────────────────────────
//
// `.mastery`（\b 排除 .mastery_lo / .mastery_hi / .mastery_state）与 `.theta_hat`
// （\b 排除 .theta_hat_raw / .theta_hat_json）的读取。
const FIELD_READ_RE = /\.mastery\b|\.theta_hat\b/;

// provenance-awareness token：文件内出现任一即视为「知道借用/观测之分」。
export const GUARD_TOKENS: readonly string[] = [
  'provenance',
  'isObserved',
  'evidence_count',
] as const;

export type FileScan = {
  /** reads a MasteryProjection field (`.mastery` / `.theta_hat`). */
  readsField: boolean;
  /** references at least one provenance-guard token. */
  guarded: boolean;
};

/** Scan one file's source for projection-field reads + guard tokens. Pure. */
export function scanFile(src: string): FileScan {
  return {
    readsField: FIELD_READ_RE.test(src),
    guarded: GUARD_TOKENS.some((t) => src.includes(t)),
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

export type ProvenanceAuditResult = {
  verdicts: ConsumerVerdict[];
  /** unguarded field-reading consumers NOT covered by the allowlist. */
  flagged: string[];
  /** allowlist entries whose file is now guarded (allowlist entry redundant → drift). */
  redundantAllowlist: string[];
  /** allowlist schema problems. */
  allowlistProblems: AllowlistProblem[];
  /** true iff no flagged consumers, no redundant allowlist entries, no allowlist problems. */
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
  const redundantAllowlist: string[] = [];
  const allowlistProblems: AllowlistProblem[] = [];

  for (const file of tracked) {
    const src = readFile(file);
    if (src === null) {
      verdicts.push({ file, status: 'missing' });
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

  return {
    verdicts,
    flagged,
    redundantAllowlist,
    allowlistProblems,
    ok: flagged.length === 0 && redundantAllowlist.length === 0 && allowlistProblems.length === 0,
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
    return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8')) as Allowlist;
  } catch {
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
      const tag =
        v.status === 'flagged'
          ? 'FLAGGED'
          : v.status === 'allowlisted'
            ? 'allow  '
            : v.status === 'guarded'
              ? 'guarded'
              : v.status === 'no-field-read'
                ? 'no-read'
                : 'MISSING';
      console.log(`  [${tag}] ${v.file}`);
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
