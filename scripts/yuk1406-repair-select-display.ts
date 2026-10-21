/**
 * Guarded one-off ops CLI for the approved select-label display repairs (bare \frac/\dfrac/\sqrt
 * inside select item labels).
 *
 * It clones each group's current frozen revision, changes only the approved items[].label_md
 * values, reseals via publishedContractSeal, and mints the new revision through the canonical
 * publisher in one short transaction. The revision is published withheld/unverified_rules: no old
 * evidence carries over, no verification row is appended, nothing is paid or enqueued here.
 *
 * Deliberately not edit_question (which remints item ids), not publishQuestionGroupFromRow (which
 * would rebuild the scoring layer), not a generic JSON patch (the surface is fixed in
 * APPROVED_REPAIR_SET and the manifest must deep-equal it), and not a global budget gate: STOP only
 * gates this CLI's next publish and cannot recall a committed publish or queued admission job.
 *
 * apply publishes one group per invocation. It takes an operation-scoped advisory lock and
 * re-checks the STOP file inside the transaction, so concurrent applies serialize. Idempotency
 * lives in the minted revision's published_by: the same request id returns the committed identity,
 * while a different group or manifest content is rejected as a conflict.
 */

import './load-env';

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { practiceCapability } from '@/capabilities/practice/manifest';
import {
  ADMISSION_FAMILY,
  lockAdmissionGroup,
} from '@/capabilities/practice/server/admission/enqueue';
import type {
  ExecutionPlanT,
  PresentationT,
  QuestionGroupStructureT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { event, question_revision } from '@/db/schema';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import {
  publishedContractSeal,
  publishedSealAccepts,
} from '@/kernel/records/assessment-normalization';
import { ASSESSMENT_PUBLISH_ACTION, publishQuestionGroup } from '@/server/questions/publisher';

// ─── Approved operation surface (frozen; extending means a new approval) ─────
//
// Sources: stage1-yuk1406-stock-math-census-20261019/{plan.md,
// first-batch-proposed-display-diff.json, stock-snapshot.json} and the pinned
// canonical-execution-contract-d41.md. `before` values are the CURRENT stored
// items[].label_md verbatim (they still carry the pre-#1827 option-letter
// prefix); `after` values are the approved preview.newSelectLabelBody
// (body-only contract). Untouched items keep their stored labels byte-for-byte,
// prefixes included — no opportunistic cleanup.

const OPERATION = 'yuk1406_select_display_label_repair' as const;
const ACTOR_REF = 'ops:yuk1406-repair-select-display' as const;
const MAX_APPROVED_PATCHES = 3;

// Subscriber identity is bound to the PRODUCTION declaration, not a guess: the
// guard's delivery anti-join must use the same (subscriber_id,
// subscriber_version, actions) the live dispatcher drains, so a manifest
// version bump automatically re-keys this guard instead of silently scanning a
// stale version's deliveries.
const admissionEnqueueDecl = practiceCapability.subscriptions?.handlers.find(
  (handler) => handler.id === 'practice.question-admission-enqueue',
);
if (admissionEnqueueDecl == null) {
  throw new Error(
    'practice.question-admission-enqueue is missing from the practice capability manifest',
  );
}
const ADMISSION_ENQUEUE_SUBSCRIBER = admissionEnqueueDecl.id;
const ADMISSION_ENQUEUE_VERSION = admissionEnqueueDecl.version;
const ADMISSION_ENQUEUE_ACTIONS = admissionEnqueueDecl.actions;

const RepairPatch = z
  .object({
    slot_id: z.string().min(1),
    item_id: z.string().min(1),
    /** Index into the slot's items array — anchors the patch to the approved order. */
    order: z.number().int().min(0),
    /** Stored items[].label_md at apply time — verbatim, must match exactly. */
    before: z.string(),
    /** Approved preview.newSelectLabelBody — verbatim. */
    after: z.string().min(1),
  })
  .strict();
type RepairPatchT = z.infer<typeof RepairPatch>;

const RepairGroup = z
  .object({
    group_id: z.string().min(1),
    source: z.string().min(1),
    question_version: z.number().int().min(0),
    current_revision_id: z.string().min(1),
    current_integrity_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    admission_generation: z.number().int().min(0),
    admission_state: z.literal('admitted'),
    select_slot: z
      .object({
        slot_id: z.string().min(1),
        part_id: z.string().min(1),
        /** Full approved item_id order for the slot — identity guard. */
        expected_item_ids: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    patches: z.array(RepairPatch).min(1),
  })
  .strict();
type RepairGroupT = z.infer<typeof RepairGroup>;

const RepairManifest = z
  .object({
    version: z.literal(1),
    approval: z
      .object({
        plan_doc: z.string().min(1),
        diff_file: z.string().min(1),
        /** sha256 of the frozen first-batch-proposed-display-diff.json. */
        diff_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        contract_doc: z.string().min(1),
        /** Approved paid ceiling for the whole LIGHT batch (USD). */
        budget_cap_usd: z.number().positive(),
      })
      .strict(),
    groups: z.array(RepairGroup).min(1).max(2),
  })
  .strict();
type RepairManifestT = z.infer<typeof RepairManifest>;

const APPROVED_REPAIR_SET: RepairManifestT = {
  version: 1,
  approval: {
    plan_doc: 'plan.md',
    diff_file: 'first-batch-proposed-display-diff.json',
    diff_sha256: 'sha256:22d50ce78aac5838b9c64f933f4c870a8bd2e513d7377674e5aab2bf7686d311',
    contract_doc: 'canonical-execution-contract-d41.md',
    budget_cap_usd: 0.05,
  },
  groups: [
    {
      group_id: 'cooygx01cb5iz5uqmln990lo',
      source: 'quiz_gen',
      question_version: 1,
      current_revision_id: 'r1vwwtbnei558aumi4zldej0',
      current_integrity_digest:
        'sha256:39683eefa87864cebd38e55e661bc0d01f95a30884c8db224d913c0c77ae39ad',
      admission_generation: 4,
      admission_state: 'admitted',
      select_slot: {
        slot_id: 'cooygx01cb5iz5uqmln990lo::r',
        part_id: 'cooygx01cb5iz5uqmln990lo',
        expected_item_ids: [
          'opt_49a64717d5d4',
          'opt_418abde75db9',
          'opt_fdc7c7d5cbb9',
          'opt_521d4d7a30fe',
        ],
      },
      patches: [
        {
          slot_id: 'cooygx01cb5iz5uqmln990lo::r',
          item_id: 'opt_fdc7c7d5cbb9',
          order: 2,
          before: 'C. [\\frac{5-\\sqrt{17}}{2},\\frac{5+\\sqrt{17}}{2}]',
          after: '$[\\frac{5-\\sqrt{17}}{2},\\frac{5+\\sqrt{17}}{2}]$',
        },
        {
          slot_id: 'cooygx01cb5iz5uqmln990lo::r',
          item_id: 'opt_521d4d7a30fe',
          order: 3,
          before: 'D. [1,\\frac{5+\\sqrt{17}}{2}]',
          after: '$[1,\\frac{5+\\sqrt{17}}{2}]$',
        },
      ],
    },
    {
      group_id: 'ubm6yaiw98qdnpddjrjbnc78',
      source: 'web_sourced',
      question_version: 2,
      current_revision_id: 'b3od34uhqb5mw9rt7hdwj3ex',
      current_integrity_digest:
        'sha256:b57b535ab31945b204d003d0fdb080e4c4763e973f7e4f1055068606db8af2e0',
      admission_generation: 5,
      admission_state: 'admitted',
      select_slot: {
        slot_id: 'ubm6yaiw98qdnpddjrjbnc78::r',
        part_id: 'ubm6yaiw98qdnpddjrjbnc78',
        expected_item_ids: [
          'opt_1c2543dd1b4c',
          'opt_d4fdf0da62c9',
          'opt_0b589fec432e',
          'opt_1938a416479d',
        ],
      },
      patches: [
        {
          slot_id: 'ubm6yaiw98qdnpddjrjbnc78::r',
          item_id: 'opt_d4fdf0da62c9',
          order: 1,
          before: 'B. y=\\dfrac{2}{x}',
          after: '$y=\\dfrac{2}{x}$',
        },
      ],
    },
  ],
};

// ─── Deterministic JSON (deep-equal guards) ──────────────────────────────────

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

function sha256Hex(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Manifest must equal the frozen approval (order-insensitive per group/patch). */
function assertManifestMatchesApproval(manifest: RepairManifestT): void {
  const drift: string[] = [];
  if (stableJson(manifest.approval) !== stableJson(APPROVED_REPAIR_SET.approval)) {
    drift.push('approval block differs from the frozen approval');
  }
  const totalPatches = manifest.groups.reduce((sum, group) => sum + group.patches.length, 0);
  if (manifest.groups.length > APPROVED_REPAIR_SET.groups.length) {
    drift.push(`more than ${APPROVED_REPAIR_SET.groups.length} groups in manifest`);
  }
  if (totalPatches > MAX_APPROVED_PATCHES) {
    drift.push(`more than ${MAX_APPROVED_PATCHES} patches in manifest (${totalPatches})`);
  }
  const approvedById = new Map(APPROVED_REPAIR_SET.groups.map((g) => [g.group_id, g]));
  const seen = new Set<string>();
  const patchKey = (patch: RepairPatchT) => `${patch.slot_id}#${patch.item_id}`;
  const sortedPatches = (patches: RepairPatchT[]) =>
    [...patches].sort((a, b) =>
      patchKey(a) < patchKey(b) ? -1 : patchKey(a) > patchKey(b) ? 1 : 0,
    );
  for (const group of manifest.groups) {
    if (seen.has(group.group_id)) {
      drift.push(`duplicate group '${group.group_id}'`);
      continue;
    }
    seen.add(group.group_id);
    const approved = approvedById.get(group.group_id);
    if (approved == null) {
      drift.push(`group '${group.group_id}' is outside the approved set`);
      continue;
    }
    const patchIds = new Set<string>();
    for (const patch of group.patches) {
      const key = patchKey(patch);
      if (patchIds.has(key)) drift.push(`duplicate patch ${key} in '${group.group_id}'`);
      patchIds.add(key);
      if (patch.slot_id !== group.select_slot.slot_id) {
        drift.push(
          `patch slot '${patch.slot_id}' != declared select_slot '${group.select_slot.slot_id}'`,
        );
      }
      if (group.select_slot.expected_item_ids[patch.order] !== patch.item_id) {
        drift.push(
          `patch '${patch.item_id}' order ${patch.order} != expected_item_ids[${patch.order}]`,
        );
      }
    }
    const normalizedIncoming = { ...group, patches: sortedPatches(group.patches) };
    const normalizedApproved = { ...approved, patches: sortedPatches(approved.patches) };
    if (stableJson(normalizedIncoming) !== stableJson(normalizedApproved)) {
      drift.push(`group '${group.group_id}' content differs from the frozen approval`);
    }
  }
  for (const approved of APPROVED_REPAIR_SET.groups) {
    if (!seen.has(approved.group_id)) {
      drift.push(`approved group '${approved.group_id}' is missing from the manifest`);
    }
  }
  if (drift.length > 0) {
    throw new Error(`manifest rejected:\n - ${drift.join('\n - ')}`);
  }
}

// ─── CLI args ────────────────────────────────────────────────────────────────

const usage =
  'usage: tsx scripts/yuk1406-repair-select-display.ts plan --manifest <file> [--out <dir>] [--request-id <id>]\n' +
  '       tsx scripts/yuk1406-repair-select-display.ts apply --manifest <file> --group <id> ' +
  '--operator <name> --reason "<why>" --request-id <id> --out <dir> --stop <path>';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

type Cli =
  | {
      command: 'plan';
      manifestPath: string;
      outDir?: string;
      requestId?: string;
    }
  | {
      command: 'apply';
      manifestPath: string;
      groupId: string;
      operator: string;
      reason: string;
      requestId: string;
      outDir: string;
      stopPath: string;
    };

function parseArgs(argv: string[]): Cli {
  const [command, ...rest] = argv;
  if (command !== 'plan' && command !== 'apply') {
    throw new Error(`missing or unknown command\n${usage}`);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected arg '${arg}'\n${usage}`);
    const eqAt = arg.indexOf('=');
    if (eqAt > 0) {
      flags.set(arg.slice(2, eqAt), arg.slice(eqAt + 1));
    } else {
      const value = rest[i + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error(`flag '${arg}' needs a value\n${usage}`);
      }
      flags.set(arg.slice(2), value);
      i += 1;
    }
  }
  const manifestPath = flags.get('manifest');
  if (!manifestPath) throw new Error(`--manifest is required\n${usage}`);
  const requestId = flags.get('request-id');
  if (requestId != null && !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`--request-id must match ${REQUEST_ID_PATTERN}\n${usage}`);
  }
  if (command === 'plan') {
    const cli: Cli = { command, manifestPath };
    if (flags.get('out') != null) cli.outDir = flags.get('out');
    if (requestId != null) cli.requestId = requestId;
    return cli;
  }
  const missing: string[] = [];
  const groupId = flags.get('group');
  const operator = flags.get('operator');
  const reason = flags.get('reason');
  const outDir = flags.get('out');
  const stopPath = flags.get('stop');
  if (groupId == null) missing.push('--group');
  if (operator == null || operator.trim().length === 0) missing.push('--operator');
  if (reason == null || reason.trim().length === 0) missing.push('--reason');
  if (requestId == null) missing.push('--request-id');
  if (outDir == null) missing.push('--out');
  if (stopPath == null) missing.push('--stop');
  if (missing.length > 0) {
    throw new Error(`apply requires ${missing.join(', ')}\n${usage}`);
  }
  return {
    command,
    manifestPath,
    groupId: groupId as string,
    operator: operator as string,
    reason: reason as string,
    requestId: requestId as string,
    outDir: outDir as string,
    stopPath: stopPath as string,
  };
}

async function loadManifest(path: string): Promise<{ manifest: RepairManifestT; sha: string }> {
  const rawText = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `manifest '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = RepairManifest.parse(parsed);
  assertManifestMatchesApproval(manifest);
  return { manifest, sha: sha256Hex(rawText) };
}

/** ENOENT = no STOP present; an existing file or any other error fails closed. */
async function assertNoStop(stopPath: string): Promise<void> {
  try {
    await access(stopPath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(
      `STOP file check failed (fail closed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(`STOP file present at '${stopPath}' — refusing to apply`);
}

/** Prove the receipt directory is writable BEFORE the transaction starts. */
async function assertOutdirWritable(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const probe = join(outDir, `.yuk1406-probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, 'probe\n', 'utf8');
    await unlink(probe);
  } catch (error) {
    throw new Error(
      `out dir '${outDir}' is not writable for receipts: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── Unsettled admission-work guard ──────────────────────────────────────────
//
// Reuses the same probes the serving projection and enqueue lane rely on:
// pgboss.job in-flight scan, unsettled event_subscription_delivery rows,
// publish events still owed a delivery, and non-terminal paid_effect claims on
// the admission family. Global scope is deliberate — the approved window
// covers only these two groups, so concurrent paid work would break the
// one-at-a-time cost settlement. Manifest-scoped extras: a dead_letter
// admission delivery or an 'unknown' paid claim on an approved group means
// THIS window's settlement already failed — the next apply must stop (old
// unknown rows elsewhere are untouched history and never block).
//
// Two correctness properties (PR1832 R1):
//  - All business probes run as ONE statement, hence one snapshot: a delivery
//    settling to 'succeeded' while its handler commits a job cannot slip
//    between sequential reads. The to_regclass probe is schema existence only
//    — pgboss.job is absent on some ephemeral DBs — never business data.
//  - The undispatched-event arm mirrors the production dispatcher's discovery
//    exactly (event.action in the subscriber's declared actions, anti-join on
//    subscriber_id + subscriber_version). No age bound: pre-bootstrap history
//    is covered by explicit 'bootstrap_skipped' rows, so ANY event still owed
//    a delivery — however old — means dispatch is behind and blocks apply.

interface GuardFinding {
  kind:
    | 'inflight_admission_job'
    | 'unsettled_admission_delivery'
    | 'undispatched_publish_event'
    | 'open_paid_effect'
    | 'manifest_dead_letter_delivery'
    | 'manifest_unknown_paid_effect';
  detail: string;
}

async function collectUnsettledAdmissionWork(
  db: Db | Tx,
  manifestGroupIds: readonly string[],
): Promise<GuardFinding[]> {
  const groupList = sql.join(
    manifestGroupIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const actionList = sql.join(
    ADMISSION_ENQUEUE_ACTIONS.map((action) => sql`${action}`),
    sql`, `,
  );

  const regclass = await db.execute<{ reg: string | null }>(
    sql`select to_regclass('pgboss.job') as reg`,
  );
  const jobsArm =
    regclass[0]?.reg != null
      ? sql`
    select 'inflight_admission_job'::text as kind,
           j.id::text || ' ' || j.name || ' state=' || j.state ||
             ' group=' || coalesce(j.data->>'question_id', '?') as detail
    from pgboss.job j
    where j.name = ${ADMISSION_FAMILY}
      and j.state in ('created','retry','active')
    union all
  `
      : sql``;
  const manifestScope =
    manifestGroupIds.length > 0
      ? sql`
    union all
    select 'manifest_dead_letter_delivery',
           d.source_event_id || ' group=' || coalesce(e.subject_id, '?')
    from event_subscription_delivery d
    inner join event e on e.id = d.source_event_id
    where d.subscriber_id = ${ADMISSION_ENQUEUE_SUBSCRIBER}
      and d.subscriber_version = ${ADMISSION_ENQUEUE_VERSION}
      and d.status = 'dead_letter'
      and e.subject_id in (${groupList})
    union all
    select 'manifest_unknown_paid_effect',
           p.entity_id || ' unit=' || p.unit
    from paid_effect p
    where p.family = ${ADMISSION_FAMILY}
      and p.state = 'unknown'
      and p.entity_id in (${groupList})
  `
      : sql``;

  const rows = await db.execute<{ kind: string; detail: string }>(sql`
    ${jobsArm}
    select 'unsettled_admission_delivery'::text as kind,
           d.source_event_id || ' status=' || d.status ||
             ' group=' || coalesce(e.subject_id, '?') as detail
    from event_subscription_delivery d
    inner join event e on e.id = d.source_event_id
    where d.subscriber_id = ${ADMISSION_ENQUEUE_SUBSCRIBER}
      and d.subscriber_version = ${ADMISSION_ENQUEUE_VERSION}
      and d.status in ('pending','claimed','retry_wait')
    union all
    select 'undispatched_publish_event',
           e.id || ' group=' || coalesce(e.subject_id, '?') ||
             ' admission=' || coalesce(e.payload->>'admission', '?')
    from event e
    where e.action in (${actionList})
      and not exists (
        select 1
        from event_subscription_delivery d
        where d.subscriber_id = ${ADMISSION_ENQUEUE_SUBSCRIBER}
          and d.subscriber_version = ${ADMISSION_ENQUEUE_VERSION}
          and d.source_event_id = e.id
      )
    union all
    select 'open_paid_effect',
           p.entity_id || ' unit=' || p.unit || ' state=' || p.state
    from paid_effect p
    where p.family = ${ADMISSION_FAMILY}
      and p.state in ('pending','sending','receipt_ready')
    ${manifestScope}
  `);
  return rows.map((row) => ({
    kind: row.kind as GuardFinding['kind'],
    detail: row.detail,
  }));
}

// ─── Per-group evaluation (shared by plan and apply; runs under the lock) ────

interface FrozenContract {
  structure: QuestionGroupStructureT;
  response_spec: ResponseSpecT;
  scoring_basis: ScoringBasisT;
  execution_plan: ExecutionPlanT;
  presentation?: PresentationT;
}

type Evaluation =
  | {
      kind: 'already_applied';
      revision_id: string;
      integrity_digest: string;
      revision_ordinal: number;
      event_id: string;
      admission_generation: number;
      published_at: string;
    }
  | {
      kind: 'ready';
      patchedContract: FrozenContract & { integrity_digest: string };
      availability: 'general_pool' | 'container_only';
      admissionGeneration: number;
      currentDigest: string;
    }
  | { kind: 'blocked'; reasons: string[] };

interface StoredRepairBinding {
  operation?: unknown;
  request_id?: unknown;
  manifest_sha256?: unknown;
  group_id?: unknown;
  supersedes?: {
    revision_id?: unknown;
    integrity_digest?: unknown;
    admission_generation?: unknown;
    question_version?: unknown;
  };
  patches?: unknown;
  new_integrity_digest?: unknown;
  new_admission_generation?: unknown;
}

function bindingMatches(
  binding: StoredRepairBinding,
  args: { groupId: string; manifestSha: string; manifest: RepairGroupT },
): boolean {
  if (binding.operation !== OPERATION) return false;
  if (binding.group_id !== args.groupId) return false;
  if (binding.manifest_sha256 !== args.manifestSha) return false;
  const supersedes = binding.supersedes ?? {};
  if (
    supersedes.revision_id !== args.manifest.current_revision_id ||
    supersedes.integrity_digest !== args.manifest.current_integrity_digest ||
    supersedes.admission_generation !== args.manifest.admission_generation ||
    supersedes.question_version !== args.manifest.question_version
  ) {
    return false;
  }
  const patchKey = (patch: { slot_id: string; item_id: string }) =>
    `${patch.slot_id}#${patch.item_id}`;
  const byKey = <T extends { slot_id: string; item_id: string }>(list: T[]) =>
    [...list].sort((a, b) => (patchKey(a) < patchKey(b) ? -1 : patchKey(a) > patchKey(b) ? 1 : 0));
  const patchProjection = byKey(
    args.manifest.patches.map((patch) => ({
      slot_id: patch.slot_id,
      item_id: patch.item_id,
      order: patch.order,
      before: patch.before,
      after: patch.after,
    })),
  );
  const storedPatches = Array.isArray(binding.patches)
    ? byKey(binding.patches as { slot_id: string; item_id: string }[])
    : binding.patches;
  return stableJson(storedPatches) === stableJson(patchProjection);
}

/**
 * Recover the ORIGINAL publish event for a committed repair revision by its
 * complete identity — never "the latest event on this revision". A later
 * dimension_update event (e.g. the admission lane re-pending the same digest)
 * carries the same revision_id, so revision alone is ambiguous. Full binding:
 * this CLI's actor, outcome='success', payload revision_id + integrity_digest
 * + supersedes_revision_id + admission_generation + revision_ordinal +
 * admission='withheld', and NO dimension_update / verification keys. Exactly
 * one row must match — zero or many fails closed rather than guessing.
 */
async function recoverOriginalPublishEvent(
  tx: Tx,
  args: {
    groupId: string;
    revisionId: string;
    revisionOrdinal: number;
    integrityDigest: string;
    supersedesRevisionId: string;
    admissionGeneration: number;
  },
): Promise<{ eventId: string } | { error: string }> {
  const rows = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, ASSESSMENT_PUBLISH_ACTION),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, args.groupId),
        eq(event.outcome, 'success'),
        eq(event.actor_ref, ACTOR_REF),
        sql`${event.payload}->>'group_id' = ${args.groupId}`,
        sql`${event.payload}->>'revision_id' = ${args.revisionId}`,
        sql`${event.payload}->>'revision_ordinal' = ${String(args.revisionOrdinal)}`,
        sql`${event.payload}->>'integrity_digest' = ${args.integrityDigest}`,
        sql`${event.payload}->>'supersedes_revision_id' = ${args.supersedesRevisionId}`,
        sql`${event.payload}->>'admission' = 'withheld'`,
        sql`${event.payload}->>'admission_generation' = ${String(args.admissionGeneration)}`,
        sql`${event.payload}->>'dimension_update' is null`,
        sql`${event.payload}->>'verification' is null`,
      ),
    )
    .orderBy(event.id)
    .limit(2);
  if (rows.length === 1) return { eventId: rows[0].id };
  return {
    error:
      rows.length === 0
        ? `original publish event for revision '${args.revisionId}' not found under the full identity binding — fail closed (no event_id will be fabricated)`
        : `multiple publish events match the full identity binding for revision '${args.revisionId}' — ambiguous, fail closed`,
  };
}

async function evaluateGroup(
  tx: Tx,
  args: {
    group: RepairGroupT;
    manifestSha: string;
    requestId?: string;
  },
): Promise<Evaluation> {
  const { group: entry } = args;
  const reasons: string[] = [];

  // Publisher lock order: group root question FOR UPDATE → lifecycle FOR UPDATE.
  const { root, lifecycle } = await lockAdmissionGroup(tx, entry.group_id);

  if (root == null) {
    return { kind: 'blocked', reasons: [`root question '${entry.group_id}' not found`] };
  }
  if (root.parent_question_id != null) {
    reasons.push(`root '${entry.group_id}' is a part (parent ${root.parent_question_id})`);
  }
  if (root.source !== entry.source) {
    reasons.push(`root source '${root.source}' != manifest '${entry.source}'`);
  }
  if (root.version !== entry.question_version) {
    reasons.push(`question.version ${root.version} != frozen ${entry.question_version}`);
  }

  // Idempotency in DB truth: a committed revision carrying this request_id is
  // the operation's durable binding. Same request + same input replays the
  // original identity; the same request bound to anything else rejects.
  if (args.requestId != null) {
    const priorRows = await tx
      .select({
        revision_id: question_revision.revision_id,
        group_id: question_revision.group_id,
        revision_ordinal: question_revision.revision_ordinal,
        integrity_digest: question_revision.integrity_digest,
        published_by: question_revision.published_by,
        published_at: question_revision.published_at,
      })
      .from(question_revision)
      .where(sql`${question_revision.published_by}->>'request_id' = ${args.requestId}`);
    const crossGroup = priorRows.find((row) => row.group_id !== entry.group_id);
    if (crossGroup != null) {
      reasons.push(
        `request_id '${args.requestId}' is already bound to group '${crossGroup.group_id}' revision '${crossGroup.revision_id}' — same request with different input is rejected`,
      );
    }
    const prior = priorRows.find((row) => row.group_id === entry.group_id);
    if (prior != null) {
      const binding = (prior.published_by ?? {}) as StoredRepairBinding;
      if (
        bindingMatches(binding, {
          groupId: entry.group_id,
          manifestSha: args.manifestSha,
          manifest: entry,
        })
      ) {
        const storedGeneration =
          typeof binding.new_admission_generation === 'number'
            ? binding.new_admission_generation
            : typeof binding.supersedes?.admission_generation === 'number'
              ? binding.supersedes.admission_generation + 1
              : -1;
        if (storedGeneration < 0) {
          reasons.push(
            `stored binding for revision '${prior.revision_id}' lacks new_admission_generation — cannot re-bind the original publish event; fail closed`,
          );
        } else {
          const recovered = await recoverOriginalPublishEvent(tx, {
            groupId: entry.group_id,
            revisionId: prior.revision_id,
            revisionOrdinal: prior.revision_ordinal,
            integrityDigest: prior.integrity_digest,
            supersedesRevisionId: entry.current_revision_id,
            admissionGeneration: storedGeneration,
          });
          if ('error' in recovered) {
            reasons.push(recovered.error);
          } else {
            return {
              kind: 'already_applied',
              revision_id: prior.revision_id,
              integrity_digest: prior.integrity_digest,
              revision_ordinal: prior.revision_ordinal,
              event_id: recovered.eventId,
              admission_generation: storedGeneration,
              published_at: prior.published_at.toISOString(),
            };
          }
        }
      } else {
        reasons.push(
          `request_id '${args.requestId}' already published revision '${prior.revision_id}' for '${entry.group_id}' but the stored binding does not match this manifest input — refusing to re-apply`,
        );
      }
    }
  }

  if (lifecycle == null) {
    reasons.push(`group '${entry.group_id}' has no lifecycle row`);
  } else {
    if (lifecycle.current_revision_id !== entry.current_revision_id) {
      reasons.push(
        `current revision '${lifecycle.current_revision_id ?? 'null'}' != frozen '${entry.current_revision_id}'`,
      );
    }
    if (lifecycle.scoring_admission_generation !== entry.admission_generation) {
      reasons.push(
        `admission generation ${lifecycle.scoring_admission_generation} != frozen ${entry.admission_generation}`,
      );
    }
    if (lifecycle.scoring_admission_state !== entry.admission_state) {
      reasons.push(
        `admission state '${lifecycle.scoring_admission_state}' != frozen '${entry.admission_state}'`,
      );
    }
    if (lifecycle.withdrawn) reasons.push('group is withdrawn');
    if (lifecycle.suspended) {
      reasons.push(`group is suspended (${lifecycle.suspension_reason ?? 'unknown'})`);
    }
  }

  // Load the REAL current revision — never the frozen census copy. The old
  // snapshot lacks the scoring layer by design; the DB row has all four
  // contract layers + presentation and they must parse and reseal.
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(
      and(
        eq(question_revision.revision_id, entry.current_revision_id),
        eq(question_revision.group_id, entry.group_id),
      ),
    )
    .limit(1);
  if (revision == null) {
    reasons.push(
      `revision '${entry.current_revision_id}' of group '${entry.group_id}' not found (or bound to another group)`,
    );
    return { kind: 'blocked', reasons };
  }
  if (revision.integrity_digest !== entry.current_integrity_digest) {
    reasons.push(
      `stored digest '${revision.integrity_digest}' != frozen '${entry.current_integrity_digest}'`,
    );
  }
  if (revision.presentation == null) {
    reasons.push('current revision has no presentation layer');
  }

  let seal: ReturnType<typeof publishedContractSeal>;
  try {
    seal = publishedContractSeal({
      structure: revision.structure,
      response_spec: revision.response_spec,
      scoring_basis: revision.scoring_basis,
      execution_plan: revision.execution_plan,
      ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
    });
  } catch (error) {
    reasons.push(
      `stored contract layers fail schema parse: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'blocked', reasons };
  }
  if (!publishedSealAccepts(seal, revision.integrity_digest)) {
    reasons.push(
      `stored layers do not reseal to stored digest '${revision.integrity_digest}' — refusing to build on an unverifiable revision`,
    );
  }
  if (seal.parsed.structure.group_id !== entry.group_id) {
    reasons.push(`structure.group_id '${seal.parsed.structure.group_id}' != '${entry.group_id}'`);
  }

  // Slot/item identity + order + exact 'before' labels.
  const slot = seal.parsed.response_spec.slots.find(
    (candidate) => candidate.slot_id === entry.select_slot.slot_id,
  );
  if (slot == null) {
    reasons.push(`slot '${entry.select_slot.slot_id}' not found in current response_spec`);
    return { kind: 'blocked', reasons };
  }
  if (slot.kind !== 'select') {
    reasons.push(`slot '${slot.slot_id}' kind '${slot.kind}' is not 'select'`);
    return { kind: 'blocked', reasons };
  }
  if (slot.part_id !== entry.select_slot.part_id) {
    reasons.push(`slot part_id '${slot.part_id}' != frozen '${entry.select_slot.part_id}'`);
  }
  const actualItemIds = slot.items.map((item) => item.item_id);
  if (stableJson(actualItemIds) !== stableJson(entry.select_slot.expected_item_ids)) {
    reasons.push(
      `slot items ${stableJson(actualItemIds)} != frozen order ${stableJson(entry.select_slot.expected_item_ids)}`,
    );
  }
  for (const patch of entry.patches) {
    const item = slot.items[patch.order];
    if (item == null || item.item_id !== patch.item_id) {
      reasons.push(`item '${patch.item_id}' not at order ${patch.order} in '${patch.slot_id}'`);
      continue;
    }
    if ((item.label_md ?? null) !== patch.before) {
      reasons.push(
        `item '${patch.item_id}' label_md ${JSON.stringify(item.label_md ?? null)} != frozen before ${JSON.stringify(patch.before)}`,
      );
    }
  }
  if (reasons.length > 0) return { kind: 'blocked', reasons };

  // Clone the parsed contract; only the approved label_md values change.
  const patched = structuredClone(seal.parsed);
  const patchedSlot = patched.response_spec.slots.find(
    (candidate) => candidate.slot_id === entry.select_slot.slot_id,
  );
  if (patchedSlot == null || patchedSlot.kind !== 'select') {
    return { kind: 'blocked', reasons: ['patched contract lost the target select slot'] };
  }
  for (const patch of entry.patches) {
    const item = patchedSlot.items[patch.order];
    if (item == null || item.item_id !== patch.item_id || item.label_md !== patch.before) {
      return {
        kind: 'blocked',
        reasons: [`patched slot diverged before applying '${patch.item_id}'`],
      };
    }
    item.label_md = patch.after;
  }

  // Prove nothing else moved: reverting the patches must restore the parsed
  // contract exactly (canonical-object comparison, not byte order).
  const reverted = structuredClone(patched);
  const revertedSlot = reverted.response_spec.slots.find(
    (candidate) => candidate.slot_id === entry.select_slot.slot_id,
  );
  if (revertedSlot == null || revertedSlot.kind !== 'select') {
    return { kind: 'blocked', reasons: ['revert check lost the target select slot'] };
  }
  for (const patch of entry.patches) {
    revertedSlot.items[patch.order].label_md = patch.before;
  }
  if (stableJson(reverted) !== stableJson(seal.parsed)) {
    return {
      kind: 'blocked',
      reasons: ['patch application touched more than the approved label_md fields'],
    };
  }

  const patchedContract: FrozenContract = {
    structure: patched.structure,
    response_spec: patched.response_spec,
    scoring_basis: patched.scoring_basis,
    execution_plan: patched.execution_plan,
    ...(patched.presentation != null ? { presentation: patched.presentation } : {}),
  };
  const newSeal = publishedContractSeal(patchedContract);
  if (newSeal.canonical === revision.integrity_digest) {
    return {
      kind: 'blocked',
      reasons: ['patched contract seals to the SAME digest — the approved change is empty'],
    };
  }

  return {
    kind: 'ready',
    patchedContract: { ...patchedContract, integrity_digest: newSeal.canonical },
    availability: lifecycle?.availability ?? 'general_pool',
    admissionGeneration: lifecycle?.scoring_admission_generation ?? 0,
    currentDigest: revision.integrity_digest,
  };
}

// ─── apply ───────────────────────────────────────────────────────────────────

interface ApplyReceipt {
  status: 'published' | 'already_applied' | 'blocked';
  group_id: string;
  request_id: string;
  operator: string;
  manifest_sha256: string;
  checked_at: string;
  publication?: {
    event_id: string;
    revision_id: string;
    revision_ordinal: number;
    integrity_digest: string;
    admission_generation: number;
    supersedes_revision_id: string;
    supersedes_integrity_digest: string;
    supersedes_admission_generation: number;
    availability: 'general_pool' | 'container_only';
    admission: { state: 'withheld'; reason: 'unverified_rules' };
    patches: RepairPatchT[];
  };
  already_applied?: {
    revision_id: string;
    integrity_digest: string;
    revision_ordinal: number;
    event_id: string;
    admission_generation: number;
    published_at: string;
  };
  blocked_reasons?: string[];
  guard_findings?: GuardFinding[];
  servable_before?: boolean;
  followups?: string[];
}

async function applyGroup(
  db: Db,
  args: {
    cli: Extract<Cli, { command: 'apply' }>;
    manifest: RepairManifestT;
    manifestSha: string;
    entry: RepairGroupT;
    manifestGroupIds: string[];
  },
): Promise<{ receipt: ApplyReceipt; committed: boolean }> {
  const { cli, manifestSha, entry } = args;
  const servableBefore = await readAutomaticallyServableQuestionIds(db, [entry.group_id]);
  const receipt: ApplyReceipt = {
    status: 'blocked',
    group_id: entry.group_id,
    request_id: cli.requestId,
    operator: cli.operator,
    manifest_sha256: manifestSha,
    checked_at: new Date().toISOString(),
    servable_before: servableBefore.has(entry.group_id),
  };

  let txResult:
    | {
        outcome: 'published';
        result: {
          event_id: string;
          revision_id: string;
          revision_ordinal: number;
          revision_digest: string;
          admission_generation: number;
        };
        currentDigest: string;
        supersedesGeneration: number;
        availability: 'general_pool' | 'container_only';
      }
    | { outcome: 'already_applied'; evaluation: Extract<Evaluation, { kind: 'already_applied' }> }
    | { outcome: 'blocked'; reasons: string[]; guardFindings?: GuardFinding[] };
  try {
    txResult = await db.transaction(async (tx) => {
      // Operation-scoped transaction advisory lock FIRST — before the request
      // binding read and the unsettled-work guard. It covers BOTH approved
      // groups for the whole transaction, so two concurrent applies cannot
      // both read "no binding / no in-flight work" and double-publish (the
      // question_revision table has no request_id unique constraint). Held to
      // commit/rollback. No other writer ever waits on this key, so it cannot
      // join the root→lifecycle lock graph — it only serializes this CLI.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${OPERATION}, 0))`);
      const evaluation = await evaluateGroup(tx, {
        group: entry,
        manifestSha,
        requestId: cli.requestId,
      });
      if (evaluation.kind === 'already_applied') {
        return { outcome: 'already_applied' as const, evaluation };
      }
      if (evaluation.kind === 'blocked') {
        return { outcome: 'blocked' as const, reasons: evaluation.reasons };
      }
      const guardFindings = await collectUnsettledAdmissionWork(tx, args.manifestGroupIds);
      if (guardFindings.length > 0) {
        return { outcome: 'blocked' as const, reasons: [], guardFindings };
      }
      // Re-check STOP inside the transaction — a stop that landed between the
      // outer check and this point still prevents the publish.
      await assertNoStop(cli.stopPath);

      const result = await publishQuestionGroup(tx, {
        group_id: entry.group_id,
        contract: evaluation.patchedContract,
        expectedCurrentRevision: entry.current_revision_id,
        expectedAdmissionGeneration: entry.admission_generation,
        availability: evaluation.availability,
        admission: { state: 'withheld', reason: 'unverified_rules' },
        actorRef: ACTOR_REF,
        publishedBy: {
          by: 'user',
          task_kind: OPERATION,
          operation: OPERATION,
          request_id: cli.requestId,
          operator: cli.operator,
          reason: cli.reason,
          manifest_sha256: manifestSha,
          group_id: entry.group_id,
          supersedes: {
            revision_id: entry.current_revision_id,
            integrity_digest: entry.current_integrity_digest,
            admission_generation: entry.admission_generation,
            question_version: entry.question_version,
          },
          patches: entry.patches.map((patch) => ({
            slot_id: patch.slot_id,
            item_id: patch.item_id,
            order: patch.order,
            before: patch.before,
            after: patch.after,
          })),
          new_integrity_digest: evaluation.patchedContract.integrity_digest,
          new_admission_generation: entry.admission_generation + 1,
          approval: {
            diff_sha256: args.manifest.approval.diff_sha256,
            budget_cap_usd: args.manifest.approval.budget_cap_usd,
          },
        },
        now: new Date(),
      });
      if (result.status !== 'published') {
        throw new Error(
          `publishQuestionGroup returned '${result.status}' for '${entry.group_id}' — expected 'published'; rolling back (detail: ${stableJson(result)})`,
        );
      }
      return {
        outcome: 'published' as const,
        result,
        currentDigest: evaluation.currentDigest,
        supersedesGeneration: evaluation.admissionGeneration,
        availability: evaluation.availability,
      };
    });
  } catch (error) {
    // A throw anywhere inside the transaction rolls the whole thing back —
    // the inner publisher savepoint is already unwound by the time it reaches
    // here. Nothing committed; the receipt reports the failure honestly.
    receipt.blocked_reasons = [
      `apply_threw: ${error instanceof Error ? error.message : String(error)}`,
    ];
    return { receipt, committed: false };
  }

  if (txResult.outcome === 'already_applied') {
    const applied = txResult.evaluation;
    receipt.status = 'already_applied';
    receipt.already_applied = {
      revision_id: applied.revision_id,
      integrity_digest: applied.integrity_digest,
      revision_ordinal: applied.revision_ordinal,
      event_id: applied.event_id,
      admission_generation: applied.admission_generation,
      published_at: applied.published_at,
    };
    receipt.followups = [
      'This request_id already committed — returning the stored identity; nothing was republished.',
      'If admission has since advanced, that newer decision belongs to the admission lane, not to this receipt.',
    ];
    return { receipt, committed: false };
  }
  if (txResult.outcome === 'blocked') {
    if (txResult.guardFindings != null) {
      receipt.guard_findings = txResult.guardFindings;
      receipt.blocked_reasons = [
        'unsettled admission work outside this window — refusing to publish',
        ...txResult.guardFindings.map((finding) => `${finding.kind}: ${finding.detail}`),
      ];
    } else {
      receipt.blocked_reasons = txResult.reasons;
    }
    return { receipt, committed: false };
  }

  const { result } = txResult;
  receipt.status = 'published';
  receipt.publication = {
    event_id: result.event_id,
    revision_id: result.revision_id,
    revision_ordinal: result.revision_ordinal,
    integrity_digest: result.revision_digest,
    admission_generation: result.admission_generation,
    supersedes_revision_id: entry.current_revision_id,
    supersedes_integrity_digest: txResult.currentDigest,
    supersedes_admission_generation: txResult.supersedesGeneration,
    availability: txResult.availability,
    admission: { state: 'withheld', reason: 'unverified_rules' },
    patches: entry.patches,
  };
  receipt.followups = [
    `The withheld publish event ${result.event_id} naturally enters ${ADMISSION_ENQUEUE_SUBSCRIBER} → ${ADMISSION_FAMILY} (paid A/B + applicable crosscheck on the NEW digest; old 'passed' evidence does not carry).`,
    'The group is withheld → NOT servable until a fresh admission verdict admits the new revision.',
    'question row (prompt/choices_md/version) unchanged by design — the admission job projects it only on a successful admit.',
    `Total approved ceiling for the batch: $${args.manifest.approval.budget_cap_usd} — settle this group and verify real cost before applying the next.`,
  ];
  return { receipt, committed: true };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const cli = parseArgs(process.argv.slice(2));
  // STOP is checked before ANY other apply work (manifest, outdir, DB) — ENOENT
  // means no stop; an existing file or any other access error fails closed.
  if (cli.command === 'apply') await assertNoStop(cli.stopPath);
  const { manifest, sha: manifestSha } = await loadManifest(cli.manifestPath);
  const { db } = await import('@/db/client');
  const manifestGroupIds = manifest.groups.map((group) => group.group_id);
  try {
    if (cli.command === 'plan') {
      const outcomes: Record<string, unknown>[] = [];
      let ready = 0;
      let already = 0;
      let blocked = 0;
      for (const entry of manifest.groups) {
        const evaluation = await db.transaction((tx) =>
          evaluateGroup(tx, { group: entry, manifestSha, requestId: cli.requestId }),
        );
        if (evaluation.kind === 'ready') {
          ready += 1;
          outcomes.push({
            group_id: entry.group_id,
            status: 'ready',
            new_integrity_digest: evaluation.patchedContract.integrity_digest,
            availability: evaluation.availability,
          });
        } else if (evaluation.kind === 'already_applied') {
          already += 1;
          outcomes.push({
            group_id: entry.group_id,
            status: 'already_applied',
            revision_id: evaluation.revision_id,
            integrity_digest: evaluation.integrity_digest,
            event_id: evaluation.event_id,
            admission_generation: evaluation.admission_generation,
            published_at: evaluation.published_at,
          });
        } else {
          blocked += 1;
          outcomes.push({
            group_id: entry.group_id,
            status: 'blocked',
            reasons: evaluation.reasons,
          });
        }
      }
      const guardFindings = await collectUnsettledAdmissionWork(db, manifestGroupIds);
      const servable = await readAutomaticallyServableQuestionIds(db, manifestGroupIds);
      const summary = {
        mode: 'plan',
        checked_at: new Date().toISOString(),
        manifest_sha256: manifestSha,
        groups: manifest.groups.length,
        ready,
        already_applied: already,
        blocked,
        currently_servable: [...servable],
        guard_findings: guardFindings,
        note: 'plan performs zero business writes; evaluation ran inside short transactions under the publisher lock order and committed nothing.',
      };
      console.log(JSON.stringify({ summary, outcomes }, null, 2));
      if (cli.outDir) {
        await mkdir(cli.outDir, { recursive: true });
        await writeFile(
          join(cli.outDir, 'plan.json'),
          `${JSON.stringify({ summary, outcomes }, null, 2)}\n`,
        );
      }
      return blocked > 0 ? 1 : 0;
    }

    // ---- apply ----
    const entry = manifest.groups.find((group) => group.group_id === cli.groupId);
    if (entry == null) {
      throw new Error(
        `--group '${cli.groupId}' is not in the manifest (${manifestGroupIds.join(', ')})`,
      );
    }
    await assertOutdirWritable(cli.outDir);

    const { receipt, committed } = await applyGroup(db, {
      cli,
      manifest,
      manifestSha,
      entry,
      manifestGroupIds,
    });

    console.log(JSON.stringify(receipt, null, 2));
    // The transaction result is final BEFORE the receipt file is written. A
    // receipt-write failure must never be misreported as an uncommitted
    // publish — the DB binding (published_by.request_id) is the recoverable
    // truth; re-running apply with the same --request-id replays it.
    try {
      await writeFile(
        join(cli.outDir, `${entry.group_id}.receipt.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    } catch (error) {
      console.error(
        `receipt write FAILED for '${entry.group_id}': ${error instanceof Error ? error.message : String(error)}\n` +
          `transaction_committed=${committed} — if true, the publish IS committed in DB; recover it with the same --request-id (do NOT mint a new one).`,
      );
      return 2;
    }
    return receipt.status === 'published' || receipt.status === 'already_applied' ? 0 : 1;
  } finally {
    await db.$client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
