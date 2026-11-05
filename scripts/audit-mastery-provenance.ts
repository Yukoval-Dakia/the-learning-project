/**
 * audit:mastery-provenance — 借用 provenance 消费纪律审计
 *
 * `getMasteryProjection` mixes observed and inferred entries. Consumers that read `.mastery` /
 * `.theta_hat` without checking provenance / isObserved / evidence_count would treat a borrowed,
 * never-observed KC as measured once the borrow flags flip. This audit finds those call sites.
 *
 * Criterion: strip comments and string/template content, then flag a file that reads a projection
 * field without a code-shaped provenance guard and was not already unguarded on the comparison
 * base — the base is the exemption, there is no allowlist. A missing tracked file also fails
 * --strict: the tracked list is a hand-maintained contract, so renames must be re-grounded.
 *
 * The check is file-scope, not AST-scope: an unrelated same-named DTO field can look guarded. That
 * limitation is why --strict must stay paired with human review before it becomes a hard gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBlobs, resolveAuditBaseSha, worktreeRenameMap } from './lib/git-base-scan';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Direct getMasteryProjection callers plus the named transitive consumer that receives a
// caller-parsed projection. state.ts is the producer, not a consumer. Add new projection-field
// consumers here or they stay outside the reverse-check.
export const TRACKED_CONSUMERS: readonly string[] = [
  'src/capabilities/agency/jobs/research_meeting_nightly.ts',
  'src/capabilities/practice/grading/server/mastery-progress-signal.ts',
  'src/capabilities/knowledge/server/node-page.ts',
  'src/capabilities/knowledge/server/frontier-read.ts',
  'src/kernel/read-models/learnable-frontier.ts',
  'src/kernel/read-models/knowledge-graph.ts',
  'src/capabilities/practice/placement/api/placement-profile.ts',
  'src/capabilities/knowledge/server/tools/knowledge-readers.ts',
  'src/capabilities/practice/question-bank/server/question-detail.ts',
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

// ── audit ─────────────────────────────────────────────────────────────────

export type ConsumerVerdict = {
  file: string;
  status: 'missing' | 'guarded' | 'no-field-read' | 'grandfathered' | 'flagged';
};

/** Fixed-width console tag per verdict status (lookup map — nested ternaries are banned). */
const STATUS_TAGS: Record<ConsumerVerdict['status'], string> = {
  flagged: 'FLAGGED',
  grandfathered: 'base   ',
  guarded: 'guarded',
  'no-field-read': 'no-read',
  missing: 'MISSING',
};

export type ProvenanceAuditResult = {
  verdicts: ConsumerVerdict[];
  /** unguarded field-reading consumers that were NOT unguarded at base. */
  flagged: string[];
  /** tracked consumers whose file no longer exists (stale tracked list → drift). */
  missing: string[];
  /**
   * true iff no flagged consumers and no MISSING tracked files. A MISSING tracked file fails the
   * audit — the tracked list is a hand-maintained contract, so a renamed/deleted consumer must be
   * re-grounded, not silently skipped (C2).
   */
  ok: boolean;
};

/**
 * Core audit. A field-reading, unguarded consumer is FLAGGED unless the same file was already
 * unguarded at the comparison base (`baseUnguarded` — file paths are already rename-mapped).
 * `readFile` is injected so tests can run without disk access. Pure.
 */
export function computeProvenanceAudit(
  tracked: readonly string[],
  readFile: (relPath: string) => string | null,
  baseUnguarded: ReadonlySet<string>,
): ProvenanceAuditResult {
  const verdicts: ConsumerVerdict[] = [];
  const flagged: string[] = [];
  const missing: string[] = [];

  for (const file of tracked) {
    const src = readFile(file);
    if (src === null) {
      verdicts.push({ file, status: 'missing' });
      missing.push(file);
      continue;
    }
    const scan = scanFile(src);
    if (!scan.readsField) {
      verdicts.push({ file, status: 'no-field-read' });
      continue;
    }
    if (scan.guarded) {
      verdicts.push({ file, status: 'guarded' });
      continue;
    }
    // unguarded field read
    if (baseUnguarded.has(file)) {
      verdicts.push({ file, status: 'grandfathered' });
    } else {
      verdicts.push({ file, status: 'flagged' });
      flagged.push(file);
    }
  }

  return { verdicts, flagged, missing, ok: flagged.length === 0 && missing.length === 0 };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch {
    return null;
  }
}

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Tracked consumers that already read a projection field unguarded at the comparison base.
 * A tracked file renamed on the head side keeps its base status at the new path; a file
 * absent at base is a new consumer and cannot be grandfathered.
 */
function unguardedAtRef(sha: string, tracked: readonly string[]): Set<string> {
  const inverse = new Map([...worktreeRenameMap(REPO_ROOT, sha, ['src'])].map(([b, h]) => [h, b]));
  const basePathFor = new Map(tracked.map((file) => [file, inverse.get(file) ?? file]));
  const blobs = readBlobs(REPO_ROOT, sha, [...basePathFor.values()]);
  const unguarded = new Set<string>();
  for (const [headPath, basePath] of basePathFor) {
    const text = blobs.get(basePath);
    if (text === undefined) continue;
    const scan = scanFile(text);
    if (scan.readsField && !scan.guarded) unguarded.add(headPath);
  }
  return unguarded;
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');
  const requested = baseFlag() || process.env.CAPABILITY_BASE_SHA;
  const base = process.env.TEST_POLICY_BASE || resolveAuditBaseSha(REPO_ROOT, requested);
  const result = computeProvenanceAudit(
    TRACKED_CONSUMERS,
    readFileOrNull,
    unguardedAtRef(base, TRACKED_CONSUMERS),
  );

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('audit:mastery-provenance — 借用 provenance 消费纪律审计 (YUK-559 / S2)\n');
    for (const v of result.verdicts) {
      console.log(`  [${STATUS_TAGS[v.status]}] ${v.file}`);
    }
    console.log('');
    if (result.flagged.length === 0) {
      console.log('  FLAGGED (unguarded field read, new since base):  (none)');
    } else {
      console.log(`  FLAGGED (unguarded field read, new since base):  ${result.flagged.length}`);
      for (const f of result.flagged) {
        console.log(
          `    - ${f}: reads .mastery/.theta_hat without provenance/isObserved/evidence_count. Gate borrow-aware behaviour on provenance (isObserved) or evidence_count.`,
        );
      }
    }
    if (result.missing.length > 0) {
      console.log(
        `\n  MISSING (tracked consumer file not found — re-ground the tracked list):  ${result.missing.length}`,
      );
      for (const f of result.missing) console.log(`    - ${f}`);
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
