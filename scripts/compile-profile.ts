// Load `.env` (DATABASE_URL + provider keys) before any module that reads env at
// import time — only the dynamically-imported `@/db/client` (--critic path) needs
// it, but loading here is a harmless pure side-effect for the bare/--json/--write
// paths (it only populates process.env; it does NOT import the db client). Repo
// convention: scripts load `.env`, NOT `.env.local` (see seed-synthetic.ts).
import './load-env';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { type ProfileImpactReport, SubjectProfileDraftSchema } from '@/core/schema/profile-studio';
import {
  type SubjectProfile,
  defaultSubjectProfile,
  getDefaultSubjectRegistry,
} from '@/subjects/profile';
import { serializeProfileToTs } from '@/subjects/serialize';

// U7 (YUK-203) — draft-JSON → validateProfile → diff CLI compile script.
//
// Operates on an UNSUBMITTED draft (distinct from `audit:profile`, which audits
// already-committed profiles). The bare path (no flags) is pure TS, no IO beyond
// reading the draft file: parse → validate → field-level diff → ProfileImpactReport.
//
// Flags:
//   --json    emit the ProfileImpactReport as JSON (else a human report)
//   --write   serialize the validated profile → write src/subjects/<id>/profile.ts,
//             ONLY after validateProfile passes (RL7 — the gate is not bypassable)
//   --critic  additionally run ProfileCriticTask (proposal-only; RL6) — needs db+env
//
// env fence (R9): only --critic / --write touch external resources. --critic calls
// the runner (needs DATABASE_URL + provider env); --write touches the filesystem.

const TOP_LEVEL_KEYS: (keyof SubjectProfile)[] = [
  'id',
  'version',
  'displayName',
  'languageStyle',
  'questionKinds',
  'judgePolicy',
  'exampleSources',
  'noteTemplate',
  'grounding',
  'promptFragments',
  'causeCategories',
  'renderConfig',
  'schedulingHints',
  'judgeCapabilities',
];

// Field-level diff locked to TOP-LEVEL keys (Cross-统合 G1): each entry is a
// top-level SubjectProfile key name; a changed array reports as the single key,
// never a per-element sub-diff (deeper diffing is DEFERRED to the taxonomy board).
function diffProfiles(
  current: SubjectProfile | undefined,
  next: SubjectProfile,
): ProfileImpactReport['diff'] {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  if (!current) {
    // A brand-new subject id: every key is "added" relative to no prior profile.
    return { changed: [], added: [...TOP_LEVEL_KEYS], removed: [] };
  }
  for (const key of TOP_LEVEL_KEYS) {
    const inCurrent = key in current && current[key] !== undefined;
    const inNext = key in next && next[key] !== undefined;
    if (inNext && !inCurrent) {
      added.push(key);
    } else if (!inNext && inCurrent) {
      removed.push(key);
    } else if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
      changed.push(key);
    }
  }
  return { changed, added, removed };
}

// Q7 — suggest (never apply) a bump. Heuristic: structural changes to the
// taxonomy / capabilities / routes are higher-impact than copy edits.
function suggestBump(diff: ProfileImpactReport['diff']): string | undefined {
  const touched = new Set([...diff.changed, ...diff.added, ...diff.removed]);
  if (touched.size === 0) {
    return undefined;
  }
  const highImpact = ['causeCategories', 'judgeCapabilities', 'judgePolicy', 'schedulingHints'];
  const isHigh = highImpact.some((key) => touched.has(key));
  return isHigh
    ? 'high-impact change (taxonomy/capabilities/routes) → suggest a minor or major version bump'
    : 'low-impact change → suggest a patch version bump';
}

export interface CompileProfileResult {
  report: ProfileImpactReport;
  /** The validated profile (only present when the draft parsed as a full profile). */
  profile?: SubjectProfile;
}

// Pure compile core: draft JSON object → ProfileImpactReport (no IO). Reused by the
// test harness; the CLI wraps it with file/stdin read + flag handling.
export function compileProfile(rawDraft: unknown): CompileProfileResult {
  const registry = getDefaultSubjectRegistry();
  const draftParsed = SubjectProfileDraftSchema.safeParse(rawDraft);
  if (!draftParsed.success) {
    const subjectId =
      typeof (rawDraft as { id?: unknown })?.id === 'string'
        ? (rawDraft as { id: string }).id
        : '<unknown>';
    return {
      report: {
        subject_id: subjectId,
        valid: false,
        errors: draftParsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        ),
        warnings: [],
        diff: { changed: [], added: [], removed: [] },
      },
    };
  }

  const draft = draftParsed.data;
  const current = registry.get(draft.id);
  // validateProfile requires a full SubjectProfile (version required non-empty).
  // A draft that omits version fails here with a version error — the author must
  // hand-fill version before publish (Q7); the report surfaces that.
  const validation = validateProfile(draft as SubjectProfile, getDefaultRegistry());
  const diff = diffProfiles(current, draft as SubjectProfile);
  const report: ProfileImpactReport = {
    subject_id: draft.id,
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    diff,
    suggested_bump: suggestBump(diff),
  };
  return { report, profile: validation.valid ? (draft as SubjectProfile) : undefined };
}

function formatReport(report: ProfileImpactReport): string {
  const lines = [
    `Profile compile — ${report.subject_id}`,
    `valid: ${report.valid}`,
    `diff: changed=[${report.diff.changed.join(', ')}] added=[${report.diff.added.join(
      ', ',
    )}] removed=[${report.diff.removed.join(', ')}]`,
  ];
  if (report.errors.length > 0) {
    lines.push('errors:');
    for (const error of report.errors) lines.push(`  - ${error}`);
  }
  if (report.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  if (report.suggested_bump) {
    lines.push(`suggested version bump: ${report.suggested_bump}`);
  }
  return lines.join('\n');
}

// Scoped env fence (R9, mirrors seed-synthetic.ts): only the --critic path needs
// DATABASE_URL + provider env (it calls the runner). Refuse a non-loopback host
// unless explicit opt-in, so a misfire never hits a real DB.
function assertCriticEnv(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL ?? '';
  if (url.length === 0) {
    throw new Error(
      'compile-profile --critic refused: DATABASE_URL must be set (the Critic runs through the AI runner, which writes the ai-run trace).',
    );
  }
  if (env.PROFILE_CRITIC_OK === '1') {
    return; // explicit opt-in bypasses the loopback check (e.g. CI against a sandbox DB)
  }
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLoopback) {
    throw new Error(
      `compile-profile --critic refused: DATABASE_URL host must be loopback (localhost / 127.0.0.1) unless PROFILE_CRITIC_OK=1. Got: ${url}.`,
    );
  }
}

// --critic invocation (RL6 proposal-only): runs ProfileCriticTask through the
// runner with real db (preserves the ai-run trace — evidence-first) and emits the
// review to stdout. ctx.subjectProfile = defaultSubjectProfile (provider/trace
// context only; the draft under review travels in the input — Cross-统合 G3). The
// runner write is dynamically imported so the bare/--json/--write paths never load
// the db client.
async function runCritic(draft: SubjectProfile, asJson: boolean): Promise<void> {
  assertCriticEnv();
  const { runAgentTask } = await import('@/server/ai/runner');
  const { db } = await import('@/db/client');
  const result = await runAgentTask(
    'ProfileCriticTask',
    { draft },
    { db, allowedTools: [], subjectProfile: defaultSubjectProfile },
  );
  // Proposal-only: the review text is written to stdout/JSON, never to the DB
  // domain rows and never back to profile.ts (RL6). The only DB writes are the
  // runner's own ai-run-log trace rows.
  if (asJson) {
    console.log(JSON.stringify({ review: result.text, task_run_id: result.task_run_id }, null, 2));
  } else {
    console.log('--- ProfileCriticTask review (proposal-only) ---');
    console.log(result.text);
  }
}

function readDraftSource(pathArg: string | undefined): string {
  if (pathArg) {
    return readFileSync(resolve(pathArg), 'utf-8');
  }
  return readFileSync(0, 'utf-8'); // stdin
}

function profilePathForId(id: string): string {
  return resolve(process.cwd(), 'src', 'subjects', id, 'profile.ts');
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const asJson = args.includes('--json');
  const doWrite = args.includes('--write');
  const doCritic = args.includes('--critic');
  const pathArg = args.find((arg) => !arg.startsWith('--'));

  let raw: unknown;
  try {
    raw = JSON.parse(readDraftSource(pathArg));
  } catch (error) {
    console.error(`compile-profile: failed to read/parse draft: ${(error as Error).message}`);
    return 1;
  }

  const { report, profile } = compileProfile(raw);
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));

  // RL7 — --write is gated on validateProfile passing. Refuse to write an invalid
  // (or unparseable-as-full) profile. The gate is not bypassable.
  if (doWrite) {
    if (!report.valid || !profile) {
      console.error('compile-profile --write refused: profile failed validateProfile (RL7).');
      return 1;
    }
    const target = profilePathForId(profile.id);
    writeFileSync(target, serializeProfileToTs(profile));
    console.log(`wrote ${target}`);
  }

  if (doCritic) {
    if (!profile) {
      console.error('compile-profile --critic refused: draft did not parse as a full profile.');
      return 1;
    }
    await runCritic(profile, asJson);
  }

  return report.valid ? 0 : 1;
}

export async function main(): Promise<void> {
  process.exitCode = await runCli();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
