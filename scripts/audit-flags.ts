/**
 * audit:flags — 全仓 flag 双轨清点对账（红线审查 wave F / A5）
 *
 * 决策来源：红线挑战审查（2026-07-07）§5 条目 7 + A5-darkship 簇终裁 KEEP-WITH-COST（B1）。
 * A5 dark-ship / flag 纪律红线（flag 钉在 act/消费点，OFF 期间采集面照常 live；整能力 go-live 门
 * 须当刻登记翻转单）条文健康，但全仓 `*_ENABLED` flag 是**双轨无对账**的散文登记面：env 型
 * （`process.env.X`）与 const 型（`const X = true/false`）混用；env 型的「开」字面量在首跑时
 * 曾混用 `=== '1'` / `=== 'true'` / 双字面量 / 大小写不敏感等写法。YUK-586 已把 runtime
 * reader 收敛到 shared parseFlag；本审计继续清点它们、抓「代码有 / 登记无」和未来语法漂移。
 *
 * ── 什么是「flag」───────────────────────────────────────────────────────────
 *
 * 全仓以 `_ENABLED` 结尾的标识符（`[A-Z][A-Z0-9_]*_ENABLED`，末尾 word-boundary 排除
 * `DEFAULT_ENABLED_BY_KIND` 之类前缀撞名）。两轨：
 *   - **env 型**：运行时读 `process.env.<NAME>`（直读或经 helper + FLAG-name 常量），按比较的
 *     **精确字面量**判真（'1' / 'true' / 大小写不敏感…）。runtime-flippable。
 *   - **const 型**：`export const <NAME> = true|false`，编译期定死，改要重新 build。
 *
 * ── 判据（声明式 ledger + 源码反查，同 audit:relations）─────────────────────────
 *
 * `audit-flags-ledger.json` 是**手维护**的 flag 台账（首版由实扫播种），每条声明 kind / literals
 * （env 的开值集）/ case_insensitive / polarity（opt-in 默认 OFF、opt-out 默认 ON）/ file / notes。
 * 扫描器在**剥注释保字符串**的源码（src/ + server/ + scripts/）上抓每个 `*_ENABLED` token
 * （标识符 + 字符串字面量都算——很多 flag 经 FLAG-name 常量字符串间接读），得到**代码中在册的 flag
 * 名集合**，与 ledger 对账：
 *   - UNREGISTERED       —— 代码里出现但 ledger 没有（新增 flag 漏登记）。
 *   - STALE              —— ledger 有，但其声明的 `file` 里 name 不再命中（flag 删/改名/挪窝 → 台账漂移）。
 *   - READER-DRIFT       —— env flag 的声明文件不再包含 ledger 钉住的 shared `parseFlag` reader marker。
 *   - LITERAL-VARIANCE   —— **report-only 信息表**：把 env flag 按「开值约定签名」（literals + 大小写）
 *                          分组，曝光跨 flag 字面量约定不一致（polarity 是独立的默认值语义）。
 *   - LEDGER-PROBLEM     —— ledger 条目 schema 坏（kind/literals/file/reader_marker 缺失或类型错）。
 *
 * 注释里的 flag 名（如 renamed-away 的 `PREREQ_PROPAGATION_ENABLED` 只剩注释残留）被剥掉 ⇒ 不误报
 * UNREGISTERED——只有**活代码**里的 flag 才入册。
 *
 * ── 默认 report-only（exit 0）；--strict 才非零 exit ────────────────────────────
 *
 * 与 audit:relations / audit:fold-writes 同待遇：默认只报告、**不进 `pnpm test` 硬链**（advisory）。
 * `--strict` 下 UNREGISTERED>0 / STALE>0 / READER-DRIFT>0 / LEDGER-PROBLEM>0 才非零 exit。LITERAL-VARIANCE **永不** fail
 * ——它是信息呈现，字面量统一是 runtime 改动（本 lane 不改 runtime；升级由 owner 拍）。
 *
 * ── 已知限制 ────────────────────────────────────────────────────────────────
 *
 * (1) ledger 手维护：新增 flag 须补一条（否则 UNREGISTERED）。kind/literals 由**人**从实扫填；env
 *     条目还必须钉住 reader_marker。审计不尝试解析任意 TypeScript 表达式，而是用 comment-stripped
 *     exact marker 确认 reader 仍走 shared parseFlag，兼容直接读、computed key 和共享 kind map。
 * (2) 判据是 name-token 级：一个 flag 名在**任意** src/server/scripts 非测试文件里出现即「在册」。
 *
 * 用法：
 *   pnpm audit:flags          # 双轨对账 + 字面量变体表（report-only）
 *   pnpm audit:flags --json   # JSON 输出
 *   pnpm audit:flags --strict # UNREGISTERED / STALE / READER-DRIFT / LEDGER-PROBLEM 即非零 exit
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LEDGER_PATH = join(__dirname, 'audit-flags-ledger.json');

const SCAN_ROOTS = ['src', 'server', 'scripts'] as const;
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);
// The audit's own script must not scan itself (it names flags in doc examples). Its ledger is JSON,
// never walked. Test files are excluded by the walk's suffix filter.
const EXCLUDE_FILES = new Set(['scripts/audit-flags.ts', 'scripts/audit-flags.test.ts']);

// `*_ENABLED` identifier/string token. Trailing (?![A-Z0-9_]) is the KEY guard: it stops
// `DEFAULT_ENABLED` from being extracted out of `DEFAULT_ENABLED_BY_KIND` (a defaults Record, not a
// flag). Leading (?<![A-Z0-9_]) keeps the match to a whole token.
export const FLAG_TOKEN_RE = /(?<![A-Z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_ENABLED(?![A-Z0-9_])/g;

// ── ledger schema ────────────────────────────────────────────────────────────────────────────

export type FlagPolarity = 'opt-in' | 'opt-out';
export type EnvFlagEntry = {
  kind: 'env';
  literals: string[];
  case_insensitive: boolean;
  polarity: FlagPolarity;
  reader_marker: string;
  file: string;
  notes: string;
};
export type ConstFlagEntry = {
  kind: 'const';
  value: boolean;
  file: string;
  notes: string;
};
export type FlagEntry = EnvFlagEntry | ConstFlagEntry;
export type Ledger = Record<string, FlagEntry>;

export type LedgerProblem = { name: string; detail: string };

/** Validate one ledger entry's shape. Pure. */
export function validateLedgerEntry(name: string, entry: unknown): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return [{ name, detail: 'entry must be an object' }];
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.file !== 'string' || e.file.trim() === '') {
    problems.push({ name, detail: 'file must be a non-empty string' });
  }
  if (typeof e.notes !== 'string' || e.notes.trim() === '') {
    problems.push({ name, detail: 'notes must be a non-empty string' });
  }
  if (e.kind === 'env') {
    if (
      !Array.isArray(e.literals) ||
      e.literals.length === 0 ||
      !e.literals.every((l) => typeof l === 'string')
    ) {
      problems.push({ name, detail: "env flag needs a non-empty string[] 'literals'" });
    }
    if (typeof e.case_insensitive !== 'boolean') {
      problems.push({ name, detail: 'env flag needs a boolean case_insensitive' });
    }
    if (e.polarity !== 'opt-in' && e.polarity !== 'opt-out') {
      problems.push({ name, detail: "env flag polarity must be 'opt-in' or 'opt-out'" });
    }
    if (typeof e.reader_marker !== 'string' || e.reader_marker.trim() === '') {
      problems.push({ name, detail: 'env flag needs a non-empty reader_marker' });
    }
  } else if (e.kind === 'const') {
    if (typeof e.value !== 'boolean') {
      problems.push({ name, detail: 'const flag needs a boolean value' });
    }
  } else {
    problems.push({ name, detail: "kind must be 'env' or 'const'" });
  }
  return problems;
}

// ── comment stripping (keeps strings; a flag name in a string literal DOES count) ──────────────
//
// Same technique as audit-fold-writes.ts: strip line + block comments, KEEP string/template
// content (many flags are read via a FLAG-name string constant, so the token appears inside a
// string), preserve newlines for line-number alignment. Escape/quote-aware so `//` inside a string
// is not a comment. This is what makes a renamed-away flag that survives ONLY in comments (e.g.
// PREREQ_PROPAGATION_ENABLED) correctly NOT counted as a live flag.
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
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
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (inSingle) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '`') inTemplate = false;
      i += 1;
      continue;
    }
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
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── source walk + flag-token scan ──────────────────────────────────────────────────────────────

export function walkSource(root: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      walkSource(abs, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      const rel = relative(REPO_ROOT, abs);
      if (!EXCLUDE_FILES.has(rel)) out.push(rel);
    }
  }
  return out;
}

/** All `*_ENABLED` flag names present in code (comment-stripped, strings KEPT). Pure. */
export function scanFlagTokens(
  files: string[],
  readFile: (relPath: string) => string | null,
): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const raw = readFile(file);
    if (raw === null) continue;
    const code = stripComments(raw);
    FLAG_TOKEN_RE.lastIndex = 0;
    for (const m of code.matchAll(FLAG_TOKEN_RE)) found.add(m[0]);
  }
  return found;
}

function hasLiveFlagReference(code: string, name: string, allowEnvNameConstant: boolean): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A few readers centralize the env-key string in a `<NAME>_ENV` constant. Count that whole
  // identifier for env flags without loosening const-flag matching or accepting arbitrary
  // prefixes. Env entries separately require a live reader_marker, so a leftover key constant
  // alone still fails reconciliation as READER-DRIFT.
  const suffix = allowEnvNameConstant ? '(?:_ENV)?' : '';
  return new RegExp(`(?<![A-Z0-9_])${escaped}${suffix}(?![A-Z0-9_])`).test(code);
}

// ── reconciliation ─────────────────────────────────────────────────────────────────────────────

export type FlagReconciliation = {
  /** flag names found in code but not in the ledger. */
  unregistered: string[];
  /** ledger entries whose declared `file` no longer contains the flag name (registry ↔ code drift). */
  stale: { name: string; file: string; problem: 'file-missing' | 'name-missing' }[];
  /** env entries whose declared file no longer contains the shared-reader marker. */
  readerDrift: { name: string; file: string; marker: string }[];
  ledgerProblems: LedgerProblem[];
  /** true iff no unregistered, stale, reader drift, or ledger problems. */
  ok: boolean;
};

/**
 * Reconcile the code-found flag set against the ledger. STALE is a PER-ENTRY reverse-check: the
 * ledger entry's declared file must exist AND still contain the flag as a live token. Env entries
 * must also contain their exact reader marker in live code, catching regressions to ad-hoc parsing.
 * Exported pure for unit testing.
 */
export function reconcileFlags(
  found: Set<string>,
  ledger: Ledger,
  readFile: (relPath: string) => string | null,
): FlagReconciliation {
  const ledgerNames = new Set(Object.keys(ledger));

  const unregistered = [...found].filter((n) => !ledgerNames.has(n)).sort();

  const ledgerProblems: LedgerProblem[] = [];
  const stale: FlagReconciliation['stale'] = [];
  const readerDrift: FlagReconciliation['readerDrift'] = [];
  const cache = new Map<string, string | null>();
  const read = (f: string): string | null => {
    if (!cache.has(f)) cache.set(f, readFile(f));
    return cache.get(f) ?? null;
  };
  for (const [name, entry] of Object.entries(ledger)) {
    ledgerProblems.push(...validateLedgerEntry(name, entry));
    const file = (entry as { file?: unknown }).file;
    if (typeof file !== 'string' || file.trim() === '') continue; // shape problem already recorded.
    const src = read(file);
    if (src === null) {
      stale.push({ name, file, problem: 'file-missing' });
      continue;
    }

    const code = stripComments(src);
    if (!hasLiveFlagReference(code, name, entry.kind === 'env')) {
      stale.push({ name, file, problem: 'name-missing' });
      continue;
    }

    if (entry.kind === 'env') {
      const marker = entry.reader_marker;
      // Keep the runtime guard because the JSON ledger is untrusted at load time even though the
      // public TypeScript type is precise; validateLedgerEntry reports malformed shapes above.
      if (typeof marker === 'string' && marker.trim() !== '' && !code.includes(marker)) {
        readerDrift.push({ name, file, marker });
      }
    }
  }

  return {
    unregistered,
    stale,
    readerDrift,
    ledgerProblems,
    ok:
      unregistered.length === 0 &&
      stale.length === 0 &&
      readerDrift.length === 0 &&
      ledgerProblems.length === 0,
  };
}

// ── literal-variance (report-only observability) ─────────────────────────────────────────────

export type VarianceGroup = {
  /** canonical signature: the enabled-literal grammar of this convention. */
  signature: string;
  flags: string[];
};

/**
 * Group env flags by their literal-parsing convention (literals + case sensitivity) so the report
 * can surface the inconsistency (the "四变体字面量" the challenge flagged). Polarity remains an
 * explicit ledger property, but does not create a second literal grammar: opt-in and opt-out flags
 * share parseFlag and differ only in their fallback default. const flags have no runtime literal,
 * so they are excluded. Pure.
 */
export function computeLiteralVariance(ledger: Ledger): VarianceGroup[] {
  const bySig = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(ledger)) {
    if (entry.kind !== 'env') continue;
    const ci = entry.case_insensitive ? 'ci' : 'cs';
    const lits = [...entry.literals]
      .sort()
      .map((l) => `'${l}'`)
      .join('|');
    const sig = `literals=${lits} match=${ci}`;
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig)?.push(name);
  }
  return [...bySig.entries()]
    .map(([signature, flags]) => ({ signature, flags: flags.sort() }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function loadLedger(): Ledger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(LEDGER_PATH, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `[audit:flags] ledger at ${LEDGER_PATH} has a non-object root; treating as empty`,
      );
      return {};
    }
    return parsed as Ledger;
  } catch (err) {
    console.error(
      `[audit:flags] failed to load ledger at ${LEDGER_PATH}; treating as empty:`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');

  const ledger = loadLedger();
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walkSource(join(REPO_ROOT, root), files);
  files.sort();

  const found = scanFlagTokens(files, readFileOrNull);
  const recon = reconcileFlags(found, ledger, readFileOrNull);
  const variance = computeLiteralVariance(ledger);

  // kind tallies for the header.
  const envFlags = Object.values(ledger).filter((e) => e.kind === 'env').length;
  const constFlags = Object.values(ledger).filter((e) => e.kind === 'const').length;

  if (isJson) {
    console.log(JSON.stringify({ found: [...found].sort(), recon, variance }, null, 2));
  } else {
    console.log('audit:flags — 全仓 flag 双轨清点对账 (红线审查 wave F / A5)\n');
    console.log(
      `  ledger: ${Object.keys(ledger).length} flags (env×${envFlags}, const×${constFlags}); code found: ${found.size} flag-name tokens.\n`,
    );

    if (recon.unregistered.length === 0) {
      console.log('  UNREGISTERED (in code, not in ledger):  (none)');
    } else {
      console.log(`  UNREGISTERED (in code, not in ledger):  ${recon.unregistered.length}`);
      for (const n of recon.unregistered)
        console.log(`    - ${n}: add to audit-flags-ledger.json with kind/literals/file/notes.`);
    }
    console.log('');

    if (recon.stale.length === 0) {
      console.log('  STALE (in ledger, name no longer in its declared file):  (none)');
    } else {
      console.log(
        `  STALE (in ledger, name no longer in its declared file):  ${recon.stale.length}`,
      );
      for (const s of recon.stale) console.log(`    - ${s.name} (${s.file}): ${s.problem}`);
    }
    console.log('');

    if (recon.readerDrift.length === 0) {
      console.log('  READER-DRIFT (env flag no longer uses its shared reader marker):  (none)');
    } else {
      console.log(
        `  READER-DRIFT (env flag no longer uses its shared reader marker):  ${recon.readerDrift.length}`,
      );
      for (const drift of recon.readerDrift) {
        console.log(`    - ${drift.name} (${drift.file}): missing ${drift.marker}`);
      }
    }
    console.log('');

    if (recon.ledgerProblems.length > 0) {
      console.log(`  LEDGER problems:  ${recon.ledgerProblems.length}`);
      for (const p of recon.ledgerProblems) console.log(`    - ${p.name}: ${p.detail}`);
      console.log('');
    }

    console.log(
      `  LITERAL-VARIANCE — env-flag enabled-literal conventions (report-only, ${variance.length} distinct):`,
    );
    for (const g of variance) {
      console.log(`    · ${g.signature}`);
      for (const f of g.flags) console.log(`        ${f}`);
    }
    console.log(
      `\n  ${variance.length} distinct env-flag literal conventions across the repo. YUK-586 established one shared grammar; more than one group indicates parsing drift. This audit remains OBSERVABILITY ONLY and never changes runtime behavior.`,
    );

    console.log(
      '\n  A5 dark-ship / flag 纪律：报告 flag 双轨清点 + 字面量约定盘点. report-only (exit 0); --strict opts\n' +
        '  into a CI gate on UNREGISTERED / STALE / READER-DRIFT / LEDGER problems.',
    );
  }

  if (isStrict && !recon.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
