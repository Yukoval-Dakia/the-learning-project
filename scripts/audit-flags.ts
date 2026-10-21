/**
 * audit:flags — 全仓 flag 双轨清点对账
 *
 * `_ENABLED` controls exist in two forms: runtime `process.env.X` reads and compile-time consts.
 * The ledger is hand-maintained; this audit reconciles it against live source so a new flag or a
 * removed/renamed one fails --strict instead of drifting silently. Non-ENABLED boolean and
 * enum/CSV/JSON controls are covered by a bounded, independent census; this is not a general
 * configuration-discovery engine.
 *
 * Scanning strips comments but keeps strings, because many flags are read through a FLAG-name
 * constant. A name left only in a comment therefore does not count as live.
 *
 * Default report-only. --strict exits non-zero on UNREGISTERED / STALE / READER-DRIFT /
 * LEDGER-PROBLEM; LITERAL-VARIANCE is informational and never fails.
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const LEDGER_PATH = join(__dirname, 'audit-flags-ledger.json');

const SCAN_ROOTS = ['src', 'server', 'scripts'] as const;
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);
// The audit's own script names flags in doc examples, so it must not scan itself. Its ledger is
// JSON and never walked; test files are excluded by the walk's suffix filter.
const EXCLUDE_FILES = new Set(['scripts/audit-flags.ts', 'scripts/audit-flags.test.ts']);

// Whole-token match; the trailing guard keeps DEFAULT_ENABLED out of DEFAULT_ENABLED_BY_KIND.
export const FLAG_TOKEN_RE = /(?<![A-Z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_ENABLED(?![A-Z0-9_])/g;

// Bounded census, independent of ledger membership: removing a ledger entry cannot hide a live
// control. New controls outside *_ENABLED and this list still require an explicit census update.
export const SCOPED_CONTROL_NAMES = [
  'PROJECTION_IS_WRITER_ITEM_CALIBRATION',
  'HUB_SYNC_MODE',
  'SELECTION_POLICY',
  'MEMORY_RECONCILE_HANDOFF_MODE',
  'INTERVENTION_DISABLED_METHOD_IDS',
  'EXTRACT_OCR_ENGINE',
  'DOCX_CONVERT_ENGINE',
  'AI_PROVIDER_SESSION_ADMISSION_MODE',
  'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON',
  'AI_PROVIDER_ATTEMPT_ADMISSION_MODE',
  'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
] as const;

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
/** Non-boolean controls have their own value grammar, never an enabled-literal set. */
export type ConfigControlEntry = {
  kind: 'config';
  reader_marker: string;
  file: string;
  notes: string;
} & ({ value_type: 'enum'; values: string[] } | { value_type: 'csv' | 'json' });
export type FlagEntry = EnvFlagEntry | ConstFlagEntry | ConfigControlEntry;
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
  } else if (e.kind === 'config') {
    if (e.value_type !== 'enum' && e.value_type !== 'csv' && e.value_type !== 'json') {
      problems.push({ name, detail: "config control value_type must be 'enum', 'csv' or 'json'" });
    }
    if (e.value_type === 'enum') {
      if (
        !Array.isArray(e.values) ||
        e.values.length === 0 ||
        !e.values.every((value) => typeof value === 'string' && value.trim() !== '') ||
        new Set(e.values).size !== e.values.length
      ) {
        problems.push({ name, detail: 'enum control needs non-empty distinct string values' });
      }
    } else if ('values' in e) {
      problems.push({ name, detail: 'only enum controls may declare values' });
    }
    if ('literals' in e || 'case_insensitive' in e || 'polarity' in e) {
      problems.push({ name, detail: 'config controls must not declare boolean flag grammar' });
    }
    if (typeof e.reader_marker !== 'string' || e.reader_marker.trim() === '') {
      problems.push({ name, detail: 'config control needs a non-empty reader_marker' });
    }
  } else if (e.kind === 'const') {
    if (typeof e.value !== 'boolean') {
      problems.push({ name, detail: 'const flag needs a boolean value' });
    }
  } else {
    problems.push({ name, detail: "kind must be 'env', 'const' or 'config'" });
  }
  return problems;
}

// ── comment stripping (keeps strings; a flag name in a string literal DOES count) ──────────────
//
// Strip comments, keep string/template content (many flags are read through a FLAG-name string),
// and preserve newlines for line alignment. Escape-aware, so `//` inside a string stays a string.
// This is what keeps a flag that survives only in comments from counting as live.
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

/** Live *_ENABLED tokens plus the bounded control census; comments excluded, strings kept. */
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
    for (const name of SCOPED_CONTROL_NAMES) {
      if (hasLiveFlagReference(code, name, true)) found.add(name);
    }
  }
  return found;
}

function hasLiveFlagReference(code: string, name: string, allowEnvNameConstant: boolean): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Some readers centralize the env-key string in a `<NAME>_ENV` constant. Count that identifier
  // for env flags only; env entries still require a live reader_marker, so a leftover key constant
  // alone fails as READER-DRIFT.
  const suffix = allowEnvNameConstant ? '(?:_ENV)?' : '';
  return new RegExp(`(?<![A-Z0-9_])${escaped}${suffix}(?![A-Z0-9_])`).test(code);
}

// ── reconciliation ─────────────────────────────────────────────────────────────────────────────

export type FlagReconciliation = {
  /** flag names found in code but not in the ledger. */
  unregistered: string[];
  /** ledger entries whose declared `file` no longer contains the flag name (registry ↔ code drift). */
  stale: { name: string; file: string; problem: 'file-missing' | 'name-missing' }[];
  /** Runtime entries whose declared file no longer contains their reader marker. */
  readerDrift: { name: string; file: string; marker: string }[];
  ledgerProblems: LedgerProblem[];
  /** true iff no unregistered, stale, reader drift, or ledger problems. */
  ok: boolean;
};

/**
 * Reconcile live flag tokens against the ledger. STALE is per-entry: the declared file must exist
 * and still contain the name as a live token. Env/config entries must also contain their exact
 * reader marker, which catches regressions to ad-hoc parsing. Pure.
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
    if (!hasLiveFlagReference(code, name, entry.kind !== 'const')) {
      stale.push({ name, file, problem: 'name-missing' });
      continue;
    }

    if (entry.kind === 'env' || entry.kind === 'config') {
      const marker = entry.reader_marker;
      // The JSON ledger is untrusted at load time; validateLedgerEntry reports malformed shapes
      // above, but the runtime guard keeps the reader check safe.
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
 * Group env flags by literal-parsing convention so inconsistent enabled-literals show up in the
 * report. Polarity is a separate ledger property, not another grammar. Const flags have no runtime
 * literal and are excluded. Pure.
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
  const controls = Object.values(ledger).filter((e) => e.kind === 'config').length;

  if (isJson) {
    console.log(JSON.stringify({ found: [...found].sort(), recon, variance }, null, 2));
  } else {
    console.log('audit:flags — 全仓 flag 双轨清点对账 (红线审查 wave F / A5)\n');
    console.log(
      `  ledger: ${Object.keys(ledger).length} flags (env×${envFlags}, const×${constFlags}, config×${controls}); code found: ${found.size} flag-name tokens.\n`,
    );

    if (recon.unregistered.length === 0) {
      console.log('  UNREGISTERED (in code, not in ledger):  (none)');
    } else {
      console.log(`  UNREGISTERED (in code, not in ledger):  ${recon.unregistered.length}`);
      for (const n of recon.unregistered)
        console.log(
          `    - ${n}: add to audit-flags-ledger.json with its value grammar, reader marker, file and notes.`,
        );
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
      console.log('  READER-DRIFT (runtime control no longer contains its reader marker):  (none)');
    } else {
      console.log(
        `  READER-DRIFT (runtime control no longer contains its reader marker):  ${recon.readerDrift.length}`,
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
      `\n  ${variance.length} distinct env-flag literal conventions across the repo. Compare differences against the declared reader semantics; intentionally exact-literal controls retain their own grammar. This audit remains OBSERVABILITY ONLY and never changes runtime behavior.`,
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
