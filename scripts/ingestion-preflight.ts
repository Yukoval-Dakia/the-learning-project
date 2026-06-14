/**
 * 30-second pre-flight for REAL ingestion (Strategy D / Slice A).
 *
 * Verifies the worker-env credentials the real upload → OCR → VLM → blob path
 * needs, so you can confirm Tencent OCR + xiaomi/mimo VLM + Cloudflare R2 are
 * provisioned BEFORE uploading a real worksheet through the manual-review
 * pipeline. Canonical var docs live in `.env.example`; this only checks them.
 *
 * Scope: presence + obvious-format only (fast, free, no external calls), with
 * one OPTIONAL non-mutating live check (`--live-r2` = R2 HeadBucket). For the
 * live VLM round-trip use the existing `pnpm preflight:vision`.
 *
 * Usage:
 *   pnpm preflight:ingestion              # presence/format checklist
 *   pnpm preflight:ingestion -- --live-r2 # + non-mutating R2 HeadBucket probe
 *
 * Exit codes:
 *   0 — all REQUIRED vars present (warnings allowed); R2 probe (if run) passed
 *   1 — --live-r2 probe failed (creds present but R2 unreachable/wrong)
 *   2 — one or more REQUIRED vars missing or still a placeholder
 *
 * See: docs/deploy/real-ingestion-provisioning.md (the end-to-end runbook).
 */
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from 'dotenv';

config({ path: '.env', override: false });

type Severity = 'required' | 'recommended' | 'optional';

interface Check {
  group: string;
  name: string;
  severity: Severity;
  /** Resolved value (or default). null/empty ⇒ unset. */
  value: string | undefined;
  /** Default applied when unset (shown, not a failure). */
  defaultNote?: string;
  /** Extra validity gate beyond non-empty (e.g. placeholder detection). */
  invalidReason?: string;
}

const env = process.env;
const liveR2 = process.argv.includes('--live-r2');

// OCR engine decides whether ZHIPU_API_KEY is load-bearing for extraction.
// Default (unset) === 'glm': GLM-OCR uses ZHIPU_API_KEY and a missing key FAILS
// every extraction permanently → REQUIRED. Only the 'tencent' rollback path
// (YUK-253, phase-deferred) leaves ZHIPU_API_KEY needed by Mem0 alone, where it
// degrades gracefully → recommended.
const ocrEngine = (env.EXTRACT_OCR_ENGINE ?? 'glm').trim().toLowerCase();
const glmOcrActive = ocrEngine !== 'tencent';

// `<...>` markers come straight from .env.example placeholders; a value that
// still contains one was copied but never substituted → treat as misconfigured.
const hasPlaceholder = (v: string | undefined): boolean => !!v && /<[^>]+>/.test(v);

const checks: Check[] = [
  // OCR (Tencent) — deterministic structured extraction (ADR-0002).
  {
    group: 'OCR (Tencent)',
    name: 'TENCENT_SECRET_ID',
    severity: 'required',
    value: env.TENCENT_SECRET_ID,
  },
  {
    group: 'OCR (Tencent)',
    name: 'TENCENT_SECRET_KEY',
    severity: 'required',
    value: env.TENCENT_SECRET_KEY,
  },
  {
    group: 'OCR (Tencent)',
    name: 'TENCENT_OCR_REGION',
    severity: 'optional',
    value: env.TENCENT_OCR_REGION,
    defaultNote: 'ap-shanghai',
  },
  // VLM (xiaomi/mimo) — rescue extraction + all AI tasks (tagging/judge).
  {
    group: 'VLM (xiaomi/mimo)',
    name: 'XIAOMI_API_KEY',
    severity: 'required',
    value: env.XIAOMI_API_KEY,
  },
  {
    group: 'VLM (xiaomi/mimo)',
    name: 'MIMO_VISION_BASE_URL',
    severity: 'optional',
    value: env.MIMO_VISION_BASE_URL,
    defaultNote: 'https://api.xiaomimimo.com/anthropic',
  },
  {
    group: 'VLM (xiaomi/mimo)',
    name: 'MIMO_VISION_MODEL',
    severity: 'optional',
    value: env.MIMO_VISION_MODEL,
    defaultNote: 'mimo-v2.5',
  },
  // Blob (Cloudflare R2) — figure crops + original uploads.
  {
    group: 'Blob (Cloudflare R2)',
    name: 'R2_ENDPOINT',
    severity: 'required',
    value: env.R2_ENDPOINT,
    invalidReason: hasPlaceholder(env.R2_ENDPOINT)
      ? 'still a placeholder (<account-id> not substituted)'
      : undefined,
  },
  {
    group: 'Blob (Cloudflare R2)',
    name: 'R2_ACCESS_KEY_ID',
    severity: 'required',
    value: env.R2_ACCESS_KEY_ID,
  },
  {
    group: 'Blob (Cloudflare R2)',
    name: 'R2_SECRET_ACCESS_KEY',
    severity: 'required',
    value: env.R2_SECRET_ACCESS_KEY,
  },
  { group: 'Blob (Cloudflare R2)', name: 'R2_BUCKET', severity: 'required', value: env.R2_BUCKET },
  // Core — API auth + persistence.
  { group: 'Core', name: 'DATABASE_URL', severity: 'required', value: env.DATABASE_URL },
  { group: 'Core', name: 'INTERNAL_TOKEN', severity: 'required', value: env.INTERNAL_TOKEN },
  // Memory (Mem0) + GLM-OCR — ZHIPU_API_KEY is dual-use: Mem0 LLM (GLM 5.2,
  // degrades gracefully) AND GLM-OCR extraction (default engine, FAILS hard if
  // unset). Severity is engine-aware: required under glm (default), recommended
  // only on the tencent rollback. DASHSCOPE_API_KEY drives the Mem0 embedder
  // (阿里百炼) and stays recommended (brief still generates from events).
  {
    group: glmOcrActive ? 'Memory (Mem0) + GLM-OCR' : 'Memory (Mem0)',
    name: 'ZHIPU_API_KEY',
    severity: glmOcrActive ? 'required' : 'recommended',
    value: env.ZHIPU_API_KEY,
    defaultNote: glmOcrActive
      ? 'GLM-OCR (default engine) FAILS every extraction if unset; also Mem0 LLM'
      : 'Mem0 LLM (GLM 5.2) degraded if unset; ingest → review → import still works',
  },
  {
    group: 'Memory (Mem0)',
    name: 'DASHSCOPE_API_KEY',
    severity: 'recommended',
    value: env.DASHSCOPE_API_KEY,
    defaultNote: 'Mem0 embedder (百炼 v4) degraded if unset; ingest → review → import still works',
  },
];

const isSet = (v: string | undefined): boolean => !!v && v.trim().length > 0;

type Status = 'ok' | 'default' | 'warn' | 'fail';

function statusOf(c: Check): Status {
  if (c.invalidReason) return 'fail';
  if (isSet(c.value)) return 'ok';
  // unset:
  if (c.severity === 'required') return 'fail';
  if (c.severity === 'recommended') return 'warn';
  return 'default'; // optional → falls back to a documented default
}

const SYMBOL: Record<Status, string> = { ok: '✓', default: '·', warn: '⚠', fail: '✗' };

function describe(c: Check, s: Status): string {
  if (s === 'ok') return 'set';
  if (s === 'fail') return c.invalidReason ?? 'MISSING (required)';
  if (s === 'warn') return `unset — ${c.defaultNote ?? 'recommended'}`;
  return `default: ${c.defaultNote ?? '(built-in)'}`; // 'default'
}

console.log('[ingestion-preflight] worker-env creds for real ingestion (OCR + VLM + R2)\n');

const failures: string[] = [];
const warnings: string[] = [];
let currentGroup = '';
const pad = Math.max(...checks.map((c) => c.name.length));

for (const c of checks) {
  if (c.group !== currentGroup) {
    currentGroup = c.group;
    console.log(`  ${currentGroup}`);
  }
  const s = statusOf(c);
  console.log(`    ${SYMBOL[s]} ${c.name.padEnd(pad)}  ${describe(c, s)}`);
  if (s === 'fail') failures.push(c.name);
  if (s === 'warn') warnings.push(c.name);
}

async function liveR2Probe(): Promise<{ ok: boolean; detail: string }> {
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return { ok: false, detail: 'R2 vars incomplete — cannot probe' };
  }
  // Mirror src/server/r2.ts getR2() client construction exactly.
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  try {
    // HeadBucket is read-only: validates endpoint + creds + bucket existence
    // + access without writing or listing any objects.
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { ok: true, detail: `HeadBucket ${bucket} ok` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    client.destroy();
  }
}

async function main(): Promise<void> {
  let liveFailed = false;

  if (liveR2) {
    console.log('\n  Live R2 probe (--live-r2, non-mutating HeadBucket)');
    if (
      failures.includes('R2_ENDPOINT') ||
      ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].some((n) => failures.includes(n))
    ) {
      console.log('    · skipped — R2 vars missing/misconfigured above');
    } else {
      const r = await liveR2Probe();
      console.log(`    ${r.ok ? SYMBOL.ok : SYMBOL.fail} ${r.detail}`);
      liveFailed = !r.ok;
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.log(
      `Result: FAIL — ${failures.length} required var(s) missing/misconfigured: ${failures.join(', ')}`,
    );
    console.log(
      'Next: set them in the worker .env (see docs/deploy/real-ingestion-provisioning.md), then re-run.',
    );
    process.exit(2);
  }
  if (liveFailed) {
    console.log(
      'Result: FAIL — R2 creds present but the live HeadBucket probe failed (see error above).',
    );
    console.log(
      'Next: verify R2_ENDPOINT / keys / bucket name match your Cloudflare R2 token + bucket.',
    );
    process.exit(1);
  }
  const warnNote =
    warnings.length > 0 ? ` (${warnings.length} recommended unset: ${warnings.join(', ')})` : '';
  console.log(`Result: PASS — all required ingestion creds present${warnNote}.`);
  const r2Hint = liveR2 ? '' : ', `pnpm preflight:ingestion -- --live-r2` (R2 connectivity)';
  console.log(`Live checks: \`pnpm preflight:vision\` (VLM round-trip)${r2Hint}.`);
  console.log('Then ingest your first worksheet — see docs/deploy/real-ingestion-provisioning.md.');
  process.exit(0);
}

main().catch((err) => {
  console.error('ingestion-preflight crashed:', err);
  process.exit(2);
});
