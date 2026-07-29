#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultLoadEvidenceImages } from '@/capabilities/agency/jobs/research_meeting_nightly';
import type { ConjectureEvidenceImageSource } from '@/capabilities/agency/server/conjecture/evidence';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { source_asset } from '@/db/schema';
import { induceConjecture } from '@/server/agency/conjecture/induce';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { restoreFromArchive } from '@/server/export/archive';
import {
  GROUNDING_GATE_DEFAULT_CLUSTERS,
  GROUNDING_GATE_MAX_CLUSTERS,
  GROUNDING_GATE_MIN_CLUSTERS,
  GroundingBlindPacketSchema,
  GroundingBlindScoreSchema,
  GroundingCanaryPacketSchema,
  buildGroundingReviewArtifacts,
  createGroundingCanaryTemplate,
  scoreGroundingBlindPacket,
  scoreGroundingCanaryPacket,
  selectGroundingCandidates,
} from '@/server/grounding-gate/artifacts';
import {
  GROUNDING_GATE_WINDOW_DAYS,
  type GroundingGateCandidateReport,
  collectGroundingGateCandidates,
} from '@/server/grounding-gate/candidates';
import { validateShadowProviderEnv } from '@/server/grounding-gate/preflight';
import type { R2Client } from '@/server/r2';
import { resolveSubjectProfile } from '@/subjects/profile';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { config as loadDotenv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { unzipSync } from 'fflate';
import postgres from 'postgres';
import { z } from 'zod';

const BackupManifestSchema = z.object({
  schema_version: z.string().min(1),
  exported_at: z.number().int().nonnegative(),
  include_assets: z.boolean(),
  row_counts: z.record(z.string(), z.number().int().nonnegative()),
});

type BackupManifest = z.infer<typeof BackupManifestSchema>;
type Command = 'inspect' | 'shadow' | 'score-blind' | 'init-canary' | 'score-canary';

interface ParsedArgs {
  command: Command;
  options: Map<string, string>;
}

class MemoryR2 implements R2Client {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(body));
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.objects.get(key);
    return value ? new Uint8Array(value) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function usage(): string {
  return `YUK-814 grounding gate (real data only)

Commands:
  pnpm grounding:gate inspect --backup <loom-backup.zip> [--out <dir>] [--sample-size 8]
  pnpm grounding:gate shadow --backup <loom-backup.zip> [--out <dir>] [--sample-size 8] [--env-file <path>]
  pnpm grounding:gate score-blind --review <blind/review.json> [--out <score.json>]
  pnpm grounding:gate init-canary --blind-score <score.json> [--out <canary-review.json>]
  pnpm grounding:gate score-canary --review <canary-review.json> [--out <canary-score.json>]

Safety:
  - inspect/shadow restore only into an automatically removed pgvector Testcontainer.
  - shadow writes AI provenance only inside that disposable DB; it never writes product proposals/events.
  - raw backups and generated packets belong under .tmp/yuk-814 and must never be committed.
  - synthetic fixtures validate this harness only and never satisfy the real gate.`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  const commands: Command[] = ['inspect', 'shadow', 'score-blind', 'init-canary', 'score-canary'];
  if (!commands.includes(rawCommand as Command)) {
    throw new Error(`missing or invalid command\n\n${usage()}`);
  }
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`invalid option near "${key ?? ''}"\n\n${usage()}`);
    }
    if (options.has(key)) throw new Error(`duplicate option ${key}`);
    options.set(key, value);
  }
  return { command: rawCommand as Command, options };
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

function parseSampleSize(options: Map<string, string>): number {
  const raw = options.get('--sample-size');
  if (raw === undefined) return GROUNDING_GATE_DEFAULT_CLUSTERS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < GROUNDING_GATE_MIN_CLUSTERS ||
    value > GROUNDING_GATE_MAX_CLUSTERS
  ) {
    throw new Error(
      `--sample-size must be an integer in [${GROUNDING_GATE_MIN_CLUSTERS}, ${GROUNDING_GATE_MAX_CLUSTERS}]`,
    );
  }
  return value;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function inspectBackup(bytes: Uint8Array): BackupManifest {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('backup is not a valid ZIP');
  }
  const manifestBytes = entries['manifest.json'];
  const dataBytes = entries['data.json'];
  if (!manifestBytes || !dataBytes) {
    throw new Error('backup ZIP must contain manifest.json and data.json');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  return BackupManifestSchema.parse(manifest);
}

function ensureDockerHost(): void {
  if (process.env.DOCKER_HOST) return;
  const orbstack = join(homedir(), '.orbstack/run/docker.sock');
  if (existsSync(orbstack)) {
    process.env.DOCKER_HOST = `unix://${orbstack}`;
    return;
  }
  const dockerDesktop = join(homedir(), '.docker/run/docker.sock');
  if (existsSync(dockerDesktop)) process.env.DOCKER_HOST = `unix://${dockerDesktop}`;
}

function currentRevision(): string {
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (status.status !== 0) throw new Error('cannot inspect current git worktree status');
  if (status.stdout.trim().length > 0) {
    throw new Error(
      'grounding gate requires a clean git worktree so code_revision identifies the executed code',
    );
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error('cannot resolve current git revision');
  return result.stdout.trim();
}

async function withRestoredBackup<T>(
  backupBytes: Uint8Array,
  run: (context: { db: Db; r2: R2Client }) => Promise<T>,
): Promise<T> {
  ensureDockerHost();
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  let client: ReturnType<typeof postgres> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try {
          if (client) await client.end({ timeout: 5 });
        } finally {
          await container.stop();
        }
      })();
    }
    return cleanupPromise;
  };
  let terminatingSignal: NodeJS.Signals | null = null;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (terminatingSignal) return;
    terminatingSignal = signal;
    void cleanup()
      .catch(() => {})
      .finally(() => {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        process.kill(process.pid, signal);
      });
  };
  const onSigint = (): void => handleSignal('SIGINT');
  const onSigterm = (): void => handleSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const databaseUrl = container.getConnectionUri();
    const migration = spawnSync('pnpm', ['db:migrate'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    if (migration.status !== 0) {
      throw new Error(`migration failed in disposable database (exit ${migration.status})`);
    }
    client = postgres(databaseUrl, { max: 4, onnotice: () => {} });
    const db = drizzle(client, { schema }) as unknown as Db;
    const r2 = new MemoryR2();
    const restored = await restoreFromArchive({ db, r2, bytes: backupBytes });
    if (restored.status !== 200) {
      throw new Error(`backup restore rejected: ${JSON.stringify(restored.body)}`);
    }
    return await run({ db, r2 });
  } finally {
    try {
      await cleanup();
    } finally {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
}

function archiveImageFetch(r2: R2Client) {
  return async (
    assetIds: string[],
    db: Db,
  ): Promise<Array<{ data: string; mediaType: string }>> => {
    const output: Array<{ data: string; mediaType: string }> = [];
    for (const id of assetIds) {
      const [row] = await db
        .select({ storage_key: source_asset.storage_key, mime_type: source_asset.mime_type })
        .from(source_asset)
        .where(eq(source_asset.id, id));
      if (!row) continue;
      const bytes = await r2.get(row.storage_key);
      if (!bytes) continue;
      output.push({
        data: Buffer.from(bytes).toString('base64'),
        mediaType: row.mime_type,
      });
    }
    return output;
  };
}

async function collectFromBackup(
  backupBytes: Uint8Array,
  now: Date,
  run: (context: {
    db: Db;
    report: GroundingGateCandidateReport;
  }) => Promise<void>,
): Promise<void> {
  await withRestoredBackup(backupBytes, async ({ db, r2 }) => {
    const report = await collectGroundingGateCandidates(db, {
      now,
      loadEvidenceImages: (database, refs) =>
        defaultLoadEvidenceImages(database, refs, archiveImageFetch(r2)),
    });
    await run({ db, report });
  });
}

function defaultOutputDir(backupPath: string, backupHash: string): string {
  const backupLabel = basename(backupPath)
    .replace(/\.zip$/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  return resolve('.tmp/yuk-814', `${backupLabel}-${backupHash.slice(0, 12)}`);
}

function eligibilityArtifact(input: {
  report: GroundingGateCandidateReport;
  backupHash: string;
  backupManifest: BackupManifest;
  codeRevision: string;
  sampleSize: number;
}) {
  return {
    schema_version: 1,
    gate: 'YUK-814',
    source_backup_sha256: input.backupHash,
    source_exported_at: new Date(input.backupManifest.exported_at * 1000).toISOString(),
    source_include_assets: input.backupManifest.include_assets,
    code_revision: input.codeRevision,
    window: {
      from: input.report.since.toISOString(),
      to: input.report.now.toISOString(),
      days: GROUNDING_GATE_WINDOW_DAYS,
    },
    requested_sample_size: input.sampleSize,
    ready_for_shadow: input.report.eligible_count >= input.sampleSize,
    counts: {
      recent_real_failures: input.report.recent_failure_count,
      synthetic_failures_excluded: input.report.synthetic_failure_count,
      raw_cells: input.report.raw_cell_count,
      lifecycle_eligible_cells: input.report.lifecycle_eligible_count,
      reproducible_cells: input.report.reproducible_cell_count,
      image_ready_eligible_cells: input.report.eligible_count,
      pending_conjectures: input.report.pending_conjecture_count,
    },
    exclusions: input.report.exclusions,
    warning:
      input.backupManifest.include_assets ||
      input.report.exclusions.every((item) => item.reason !== 'evidence_image_unavailable')
        ? null
        : 'This text-only backup excluded image-bearing clusters. Re-export with include_assets=1 if those clusters are needed.',
    gate_passed: false,
    note: 'Eligibility is preparation evidence only. It is not a shadow/blind/canary result.',
  };
}

async function runInspect(options: Map<string, string>): Promise<number> {
  const codeRevision = currentRevision();
  const backupPath = resolve(requiredOption(options, '--backup'));
  const backupBytes = new Uint8Array(await readFile(backupPath));
  const backupHash = sha256(backupBytes);
  const manifest = inspectBackup(backupBytes);
  const sampleSize = parseSampleSize(options);
  const outDir = resolve(options.get('--out') ?? defaultOutputDir(backupPath, backupHash));
  const now = new Date(manifest.exported_at * 1000);
  await collectFromBackup(backupBytes, now, async ({ report }) => {
    const artifact = eligibilityArtifact({
      report,
      backupHash,
      backupManifest: manifest,
      codeRevision,
      sampleSize,
    });
    await writeJson(join(outDir, 'private', 'eligibility.json'), artifact);
    console.log(JSON.stringify(artifact, null, 2));
  });
  return 0;
}

function mediaExtension(mediaType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const extension = extensions[mediaType];
  if (!extension) throw new Error(`unsupported prepared image MIME ${mediaType}`);
  return extension;
}

async function writeCandidateImages(
  outDir: string,
  clusterId: string,
  candidate: GroundingGateCandidateReport['candidates'][number],
): Promise<Map<string, Array<{ file: string; source: ConjectureEvidenceImageSource }>>> {
  const byAttemptId = new Map<
    string,
    Array<{ file: string; source: ConjectureEvidenceImageSource }>
  >();
  if (candidate.evidence_images.length > 0) {
    await mkdir(join(outDir, 'blind', 'images'), { recursive: true });
  }
  for (let index = 0; index < candidate.evidence_images.length; index += 1) {
    const image = candidate.evidence_images[index];
    const name = `${clusterId}-image-${String(index + 1).padStart(2, '0')}.${mediaExtension(image.mediaType)}`;
    const relativePath = join('images', name);
    await writeFile(join(outDir, 'blind', relativePath), Buffer.from(image.data, 'base64'));
    for (const occurrence of image.occurrences) {
      const images = byAttemptId.get(occurrence.attempt_event_id) ?? [];
      if (
        !images.some((entry) => entry.file === relativePath && entry.source === occurrence.source)
      ) {
        images.push({ file: relativePath, source: occurrence.source });
      }
      byAttemptId.set(occurrence.attempt_event_id, images);
    }
  }
  return byAttemptId;
}

function loadShadowEnv(options: Map<string, string>): void {
  const envFile = options.get('--env-file');
  loadDotenv({ path: envFile ? resolve(envFile) : resolve('.env'), override: false, quiet: true });
  validateShadowProviderEnv(process.env);
}

async function runShadow(options: Map<string, string>): Promise<number> {
  loadShadowEnv(options);
  const codeRevision = currentRevision();
  const backupPath = resolve(requiredOption(options, '--backup'));
  const backupBytes = new Uint8Array(await readFile(backupPath));
  const backupHash = sha256(backupBytes);
  const manifest = inspectBackup(backupBytes);
  const sampleSize = parseSampleSize(options);
  const outDir = resolve(options.get('--out') ?? defaultOutputDir(backupPath, backupHash));
  const existingFinalArtifacts = [
    join(outDir, 'blind', 'review.json'),
    join(outDir, 'private', 'lineage.json'),
  ].filter(existsSync);
  if (existingFinalArtifacts.length > 0) {
    throw new Error(
      `refusing to overwrite completed shadow artifacts: ${existingFinalArtifacts.join(', ')}; choose a fresh --out directory`,
    );
  }
  const now = new Date(manifest.exported_at * 1000);
  const gateId = `yuk-814-${backupHash.slice(0, 12)}`;
  await collectFromBackup(backupBytes, now, async ({ db, report }) => {
    const eligibility = eligibilityArtifact({
      report,
      backupHash,
      backupManifest: manifest,
      codeRevision,
      sampleSize,
    });
    await writeJson(join(outDir, 'private', 'eligibility.json'), eligibility);
    const selected = selectGroundingCandidates(report.candidates, sampleSize, backupHash);
    const runTaskFn = makeRunTaskFn(db);
    const results: Parameters<typeof buildGroundingReviewArtifacts>[0]['results'] = [];
    for (const item of selected) {
      console.log(`[grounding-gate] shadow ${item.cluster_id}/${selected.length}`);
      const induced = await induceConjecture({
        cells: [item.candidate.cell],
        evidenceImages: item.candidate.evidence_images,
        samples: 3,
        runTaskFn,
        ...(item.candidate.prior_claim_md ? { priorClaimMd: item.candidate.prior_claim_md } : {}),
        subjectProfile: resolveSubjectProfile(item.candidate.cell.subject_id),
      });
      const imagesByAttemptId = await writeCandidateImages(outDir, item.cluster_id, item.candidate);
      results.push({ selected: item, induced, imagesByAttemptId });
    }
    const finalRevision = currentRevision();
    if (finalRevision !== codeRevision) {
      throw new Error('git revision changed during the shadow run; refusing to seal artifacts');
    }
    const artifacts = buildGroundingReviewArtifacts({
      gateId,
      sourceBackupSha256: backupHash,
      generatedAt: new Date(),
      codeRevision,
      selectionSeed: backupHash,
      window: { from: report.since, to: report.now },
      eligibleCount: report.eligible_count,
      results,
    });
    await writeJson(join(outDir, 'blind', 'review.json'), artifacts.blind);
    await writeJson(join(outDir, 'private', 'lineage.json'), artifacts.privateMap);
    console.log(
      JSON.stringify(
        {
          gate_id: gateId,
          blind_review: join(outDir, 'blind', 'review.json'),
          private_lineage: join(outDir, 'private', 'lineage.json'),
          sample_count: results.length,
          gate_passed: false,
          next: 'Complete blind/review.json, then run score-blind. Do not inspect private/lineage.json before scoring.',
        },
        null,
        2,
      ),
    );
  });
  return 0;
}

function statusExitCode(status: 'pass' | 'fail' | 'incomplete'): number {
  if (status === 'pass') return 0;
  return status === 'fail' ? 1 : 2;
}

async function runScoreBlind(options: Map<string, string>): Promise<number> {
  const reviewPath = resolve(requiredOption(options, '--review'));
  const packet = GroundingBlindPacketSchema.parse(await readJson(reviewPath));
  const score = scoreGroundingBlindPacket(packet);
  const outPath = resolve(options.get('--out') ?? join(dirname(reviewPath), 'score.json'));
  await writeJson(outPath, score);
  console.log(JSON.stringify(score, null, 2));
  return statusExitCode(score.status);
}

async function runInitCanary(options: Map<string, string>): Promise<number> {
  const blindScorePath = resolve(requiredOption(options, '--blind-score'));
  const bytes = new Uint8Array(await readFile(blindScorePath));
  const score = GroundingBlindScoreSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (score.status !== 'pass' || !score.expansion_allowed) {
    throw new Error('blind gate is not PASS; canary template creation is blocked');
  }
  const template = createGroundingCanaryTemplate({
    gateId: score.gate_id,
    blindScoreSha256: sha256(bytes),
  });
  const outPath = resolve(
    options.get('--out') ?? join(dirname(blindScorePath), 'canary-review.json'),
  );
  await writeJson(outPath, template);
  console.log(JSON.stringify({ wrote: outPath, runs: template.runs.length }, null, 2));
  return 0;
}

async function runScoreCanary(options: Map<string, string>): Promise<number> {
  const reviewPath = resolve(requiredOption(options, '--review'));
  const packet = GroundingCanaryPacketSchema.parse(await readJson(reviewPath));
  const score = scoreGroundingCanaryPacket(packet);
  const outPath = resolve(options.get('--out') ?? join(dirname(reviewPath), 'canary-score.json'));
  await writeJson(outPath, score);
  console.log(JSON.stringify(score, null, 2));
  return statusExitCode(score.status);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, options } = parseArgs(argv);
  if (command === 'inspect') return runInspect(options);
  if (command === 'shadow') return runShadow(options);
  if (command === 'score-blind') return runScoreBlind(options);
  if (command === 'init-canary') return runInitCanary(options);
  return runScoreCanary(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[grounding-gate] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
