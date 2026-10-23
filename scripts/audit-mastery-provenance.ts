/**
 * audit:mastery-provenance — 借用 provenance 消费纪律审计
 *
 * `getMasteryProjection` mixes observed and inferred entries. Consumers that read `.mastery` /
 * `.theta_hat` without checking provenance / isObserved / evidence_count would treat a borrowed,
 * never-observed KC as measured once the borrow flags flip. This audit finds those call sites.
 *
 * Criterion: strip comments and string/template content, then flag a file that reads a projection
 * field without a code-shaped provenance guard and is not allowlisted. A missing tracked file also
 * fails --strict: the tracked list is a hand-maintained contract, so renames must be re-grounded.
 *
 * The check is file-scope, not AST-scope: an unrelated same-named DTO field can look guarded. That
 * limitation is why --strict must stay paired with human review before it becomes a hard gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = join(__dirname, 'audit-mastery-provenance-allowlist.json');

// Direct getMasteryProjection callers plus the named transitive consumer that receives a
// caller-parsed projection. state.ts is the producer, not a consumer. Add new projection-field
// consumers here or they stay outside the reverse-check.
export const TRACKED_CONSUMERS: readonly string[] = [
  'src/capabilities/agency/jobs/research_meeting_nightly.ts',
  'src/capabilities/practice/server/mastery-progress-signal.ts',
  'src/capabilities/knowledge/server/node-page.ts',
  'src/capabilities/knowledge/server/frontier-read.ts',
  'src/kernel/read-models/knowledge-graph.ts',
  'src/capabilities/practice/api/placement-profile.ts',
  'src/capabilities/knowledge/server/tools/knowledge-readers.ts',
  'src/capabilities/practice/server/question-detail.ts',
  // transitive consumer (spec §1.1): receives a caller-parsed projection.
  'src/capabilities/agency/server/conjecture/evidence.ts',
] as const;

// Both field-read and guard scans run on source with comments and string/template content removed,
// so a `.mastery` in a docstring or a quoted `evidence_count` is not mistaken for code. Template
// interpolations stay, so `${proj.mastery}` still counts. Regex literals are not stripped, so a
// pattern like /\.mastery\b/ could false-positive; no tracked consumer has one today.
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

// `.mastery` (word boundary excludes .mastery_lo / .mastery_hi / .mastery_state) and `.theta_hat`
// (word boundary excludes .theta_hat_raw / .theta_hat_json).
const FIELD_READ_RE = /\.mastery\b|\.theta_hat\b/;

// Guards must be code-shaped: a member read or an isObserved call/import. A bare identifier or an
// object-literal key (`evidence_count:`) is not a read of the discriminant.
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
 * Scan one file on the comment/string-stripped source. Pure. A same-named field on an unrelated
 * DTO can read as guarded; see the file header limitation.
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
  // loadAllowlist() casts parsed JSON, so a hand-edited entry can still be null or non-object.
  // Report that as an invalid entry instead of crashing on the first property read.
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
 * Core audit. A field-reading, unguarded, non-allowlisted consumer is FLAGGED. `readFile` and
 * `allowlist` are injected so tests can run without disk access. Pure.
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

  // Reverse check: an allowlist entry whose file is no longer tracked is dead configuration.
  // Surface it through redundantAllowlist so --strict fails instead of accumulating silently.
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
    // Valid JSON can still have a non-object root; that would crash Object.hasOwn. Treat it as
    // corrupt: diagnose to stderr and degrade to {}, so previously allowlisted files FLAG.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(
        `[audit:mastery-provenance] allowlist at ${ALLOWLIST_PATH} has a non-object root (${Array.isArray(parsed) ? 'array' : typeof parsed}); treating as empty — previously-allowlisted consumers will FLAG`,
      );
      return {};
    }
    return parsed as Allowlist;
  } catch (err) {
    // Degrading to {} makes every allowlisted consumer FLAG. Emit the cause so the CI failure
    // is attributable.
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

// CLI-gate: only run when invoked directly, so importing the pure functions has no side effects.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
