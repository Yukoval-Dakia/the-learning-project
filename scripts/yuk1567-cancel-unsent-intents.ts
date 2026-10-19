// Lead-only ops entry for the GENERIC never-sent paid-intent cancel (YUK-1567).
// No automatic caller; no tests, no Docker, no provider calls — this script
// only reads/writes the deployment DB through @/db/client.
//
//   plan  <m.json> --out <plan.json>
//       READ-ONLY. Evaluates every manifest target inside one repeatable-read
//       snapshot and freezes a write-once plan artifact with per-target
//       eligibility + observed state. Nothing is mutated.
//   apply <m.json> --out <receipt.json> --plan <plan.json>
//          --plan-sha256 sha256:<hex>
//       Executes ONLY the targets authorized by a FROZEN plan artifact: the
//       plan file's raw bytes must hash to the independently recorded
//       --plan-sha256, and the plan must have been produced for THIS exact
//       manifest (request fields, watch triples, target identity/fence set —
//       all compared item-for-item). An appended, replaced, dropped, or
//       reshaped target set refuses before any database connection; the
//       request_id alone never authorizes an execution scope.
//       Per authorized target: one SERIALIZABLE transaction — family
//       advisory lock → already-cancelled strict replay (returns the stored
//       receipt, writes nothing) or, for a fresh pending row, eligibility
//       re-proof under the snapshot → cancelPaidEffectUnsentIntent (event +
//       pending→cancelled CAS, atomic). A serialization conflict fails the
//       target closed — fix the cause and re-plan; the script never retries
//       or bypasses gates, and never re-freezes a plan on its own.
//
// The manifest is the frozen approval. Every target names the COMPLETE
// 5-part paid-effect identity plus the literal never-sent fence token 0 —
// the tool never fishes for paid rows by group, actor, time, or state, and
// never touches a row outside the listed identities. The agreed CAS is
// identity + fence 0 + the never-sent predicate, NOT a row-digest
// comparison: full_row_md5 values recorded before the 0124 columns existed
// are pre-migration observations and are never used as a compare token.
//
// The generic store takes no family knowledge; THIS ops entry is
// admission-scoped: every target must be family 'question_admission_run' and
// `watch` must equal — item for item — the admission enqueue pipeline's real
// subscription declaration (action + subscriber_id + subscriber_version)
// read from the practice capability manifest at runtime. A missing, empty,
// or unrelated watch entry refuses before any query.
//
// Env: DATABASE_URL must equal YUK1567_DATABASE_URL (explicit approval of the
// exact deployment DB — mirrors the reopen CLI's TEST guard).
//
// usage:
//   tsx scripts/yuk1567-cancel-unsent-intents.ts plan <m.json> --out <plan.json>
//   tsx scripts/yuk1567-cancel-unsent-intents.ts apply <m.json> --out <receipt.json>
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { practiceCapability } from '@/capabilities/practice/manifest';
import type { PaidEffectIdentity } from '@/core/migration/paid-effect-protocol';
import { lockPaidEffectControlFamily } from '@/db/paid-effect-control';
import {
  cancelPaidEffectUnsentIntent,
  evaluatePaidEffectCancelEligibility,
  readPaidEffect,
} from '@/db/paid-effect-store';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const watchEntrySchema = z.object({
  action: z.string().min(1),
  subscriber_id: z.string().min(1),
  subscriber_version: z.number().int().positive(),
});

/**
 * The frozen approval manifest. `request_id` is the operation's idempotency
 * anchor; `watch` must equal the admission enqueue pipeline's declared
 * (action, subscriber_id, subscriber_version) set — verified item-by-item
 * against the live practice capability manifest, never trusted as-written;
 * `targets` is the FULL batch scope: apply iterates exactly this list, one
 * transaction each, never anything else. `expected_fence` is the literal 0:
 * a non-zero fence means a claim already touched the row.
 */
const cancelManifestSchema = z.object({
  version: z.literal(1),
  request_id: z.string().min(1),
  operator: z.string().min(1),
  reason: z.string().min(1),
  basis: z.string().min(1),
  watch: z.array(watchEntrySchema).nonempty(),
  targets: z
    .array(
      z.object({
        family: z.string().min(1),
        entity_id: z.string().min(1),
        entity_revision: z.string().min(1),
        unit: z.string().min(1),
        input_digest: digest,
        expected_fence: z.literal(0),
      }),
    )
    .nonempty(),
});
type CancelManifest = z.infer<typeof cancelManifestSchema>;
type CancelTarget = CancelManifest['targets'][number];
type WatchEntry = CancelManifest['watch'][number];

/** The only paid-effect family this ops entry currently supports. */
const SUPPORTED_FAMILY = 'question_admission_run';
const ADMISSION_ENQUEUE_SUBSCRIBER = 'practice.question-admission-enqueue';

/**
 * The required watch set for an admission-family cancel, sourced from the
 * REAL practice subscription declaration — the (action, subscriber_id,
 * subscriber_version) triples under which publish events can still mint
 * admission jobs. If the declaration moves (e.g. a version bump), previously
 * frozen manifests stop matching and must be re-approved.
 */
function requiredAdmissionWatch(): WatchEntry[] {
  const decl = (practiceCapability.subscriptions?.handlers ?? []).find(
    (h) => h.id === ADMISSION_ENQUEUE_SUBSCRIBER,
  );
  if (!decl) {
    throw new Error(
      `practice manifest no longer declares ${ADMISSION_ENQUEUE_SUBSCRIBER}; refusing to prove drainage`,
    );
  }
  return decl.actions.map((action) => ({
    action,
    subscriber_id: decl.id,
    subscriber_version: decl.version,
  }));
}

const sha256 = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const sha256Bytes = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * The plan artifact this script's `plan` mode writes — and the ONLY scope
 * `apply` may execute. The plan file's raw bytes are pinned by an
 * independently recorded digest (`--plan-sha256`); the plan must bind THIS
 * exact manifest (request fields + watch + full target identity/fence set).
 */
const planArtifactSchema = z.object({
  version: z.literal(1),
  planned_at: z.string().min(1),
  manifest_sha256: digest,
  request: z.object({
    request_id: z.string().min(1),
    operator: z.string().min(1),
    reason: z.string().min(1),
    basis: z.string().min(1),
  }),
  watch: z.array(watchEntrySchema).nonempty(),
  eligible: z.boolean(),
  targets: z
    .array(
      z.object({
        identity: z.object({
          family: z.string().min(1),
          entityId: z.string().min(1),
          entityRevision: z.string().min(1),
          unit: z.string().min(1),
          inputDigest: digest,
        }),
        expected_fence: z.literal(0),
        eligible: z.boolean(),
      }),
    )
    .nonempty(),
});
type PlanArtifact = z.infer<typeof planArtifactSchema>;

function requireDeploymentDb(): void {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.YUK1567_DATABASE_URL) {
    throw new Error('Explicitly set YUK1567_DATABASE_URL to the approved deployment DATABASE_URL');
  }
}

function identityOf(target: CancelTarget): PaidEffectIdentity {
  return {
    family: target.family,
    entityId: target.entity_id,
    entityRevision: target.entity_revision,
    unit: target.unit,
    inputDigest: target.input_digest,
  };
}

function assertApprovedScope(manifest: CancelManifest): void {
  const seen = new Set<string>();
  for (const target of manifest.targets) {
    if (target.family !== SUPPORTED_FAMILY) {
      throw new Error(
        `unsupported paid-effect family '${target.family}': this ops entry only ` +
          `cancels ${SUPPORTED_FAMILY} intents; other families need their own approved lane`,
      );
    }
    const key = [
      target.family,
      target.entity_id,
      target.entity_revision,
      target.unit,
      target.input_digest,
    ].join('|');
    if (seen.has(key)) throw new Error(`manifest contains duplicate target identity: ${key}`);
    seen.add(key);
  }
  // The declared watch set is what can still mint work for the entity; the
  // frozen manifest must match it item-for-item (action + subscriber +
  // version) — an omitted, empty, or unrelated entry would silently skip the
  // undelivered-event proof.
  const required = requiredAdmissionWatch();
  const toKey = (w: WatchEntry) => `${w.action}|${w.subscriber_id}|${w.subscriber_version}`;
  const requiredKeys = new Set(required.map(toKey));
  const manifestKeys = new Set(manifest.watch.map(toKey));
  for (const w of required) {
    if (!manifestKeys.has(toKey(w))) {
      throw new Error(
        `manifest watch is missing the declared pipeline ${toKey(w)}; ` +
          'an unproven enqueue path cannot be skipped',
      );
    }
  }
  for (const w of manifest.watch) {
    if (!requiredKeys.has(toKey(w))) {
      throw new Error(
        `manifest watch entry ${toKey(w)} is not a declared admission enqueue ` +
          'pipeline (or names a stale subscriber_version); refuse to attest it',
      );
    }
  }
}

/**
 * `apply` may only ever execute the scope a FROZEN plan authorized. The
 * approved plan digest is pinned OUTSIDE this invocation — recorded in the
 * frozen ops record / approved command line — so this function takes it as a
 * parameter and never derives an expected value from the file itself. Every
 * check below runs BEFORE the database client is even imported: a plan that
 * fails any of them leaves nothing to clean up.
 *
 * Verified, in order (no fallback, no re-freeze, no partial acceptance):
 *   1. the plan file's RAW BYTES hash to `expectedPlanSha256`;
 *   2. the file parses and matches the plan artifact schema;
 *   3. `manifest_sha256` equals the digest of the manifest parsed for THIS
 *      run — a plan issued for a different manifest never authorizes it;
 *   4. request_id/operator/reason/basis match the manifest verbatim;
 *   5. the watch triple set matches item-for-item;
 *   6. the (identity, expected_fence) multiset matches exactly — same count,
 *      same members; an appended, replaced, or dropped target refuses;
 *   7. every plan target recorded `eligible: true` — an eligible-looking
 *      manifest with an ineligible plan still refuses.
 */
async function verifyFrozenPlan(
  planPath: string,
  expectedPlanSha256: string,
  manifest: CancelManifest,
): Promise<{ plan: PlanArtifact; planSha256: string }> {
  if (!digest.safeParse(expectedPlanSha256).success) {
    throw new Error(
      `--plan-sha256 '${expectedPlanSha256}' is not a sha256: digest; ` +
        'copy the approved plan hash from the frozen ops record',
    );
  }
  const planBytes = await readFile(planPath);
  const actualPlanSha256 = sha256Bytes(planBytes);
  if (actualPlanSha256 !== expectedPlanSha256) {
    throw new Error(
      `plan file hash ${actualPlanSha256} != approved ${expectedPlanSha256}; ` +
        'the plan artifact was altered or the wrong file was passed — refusing to apply',
    );
  }
  let parsed: PlanArtifact;
  try {
    parsed = planArtifactSchema.parse(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    throw new Error(
      `frozen plan ${planPath} is unreadable or off-schema: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (parsed.manifest_sha256 !== sha256(manifest)) {
    throw new Error(
      `plan was issued for manifest ${parsed.manifest_sha256}, ` +
        `not this manifest ${sha256(manifest)} — refusing to apply a foreign plan`,
    );
  }
  const req = parsed.request;
  if (
    req.request_id !== manifest.request_id ||
    req.operator !== manifest.operator ||
    req.reason !== manifest.reason ||
    req.basis !== manifest.basis
  ) {
    throw new Error('frozen plan request fields diverge from the manifest — refusing to apply');
  }
  const watchKey = (w: WatchEntry) => `${w.action}|${w.subscriber_id}|${w.subscriber_version}`;
  if (parsed.watch.length !== manifest.watch.length) {
    throw new Error(
      `frozen plan declares ${parsed.watch.length} watch entries, ` +
        `manifest declares ${manifest.watch.length} — scope mismatch`,
    );
  }
  const manifestWatch = new Set(manifest.watch.map(watchKey));
  for (const w of parsed.watch) {
    if (!manifestWatch.has(watchKey(w))) {
      throw new Error(`frozen plan watch ${watchKey(w)} is not in the manifest — scope mismatch`);
    }
  }
  const targetKey = (t: {
    family: string;
    entity_id: string;
    entity_revision: string;
    unit: string;
    input_digest: string;
    expected_fence: number;
  }) =>
    `${t.family}|${t.entity_id}|${t.entity_revision}|${t.unit}|${t.input_digest}|${t.expected_fence}`;
  const planKeys = parsed.targets.map((t) =>
    targetKey({
      family: t.identity.family,
      entity_id: t.identity.entityId,
      entity_revision: t.identity.entityRevision,
      unit: t.identity.unit,
      input_digest: t.identity.inputDigest,
      expected_fence: t.expected_fence,
    }),
  );
  if (planKeys.length !== manifest.targets.length) {
    throw new Error(
      `frozen plan authorizes ${planKeys.length} targets, ` +
        `manifest lists ${manifest.targets.length} — appended or dropped targets refuse`,
    );
  }
  const counts = new Map<string, number>();
  for (const k of planKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const t of manifest.targets) {
    const k = targetKey(t);
    const n = counts.get(k) ?? 0;
    if (n === 0) {
      throw new Error(`manifest target ${k} is not authorized by the frozen plan`);
    }
    counts.set(k, n - 1);
  }
  if (!parsed.eligible || parsed.targets.some((t) => !t.eligible)) {
    throw new Error(
      'frozen plan records ineligible targets — re-plan and re-approve before applying',
    );
  }
  return { plan: parsed, planSha256: actualPlanSha256 };
}

async function writeOnce(path: string, artifact: unknown): Promise<void> {
  // Frozen artifacts are write-once evidence — never overwrite an earlier one.
  const file = await open(path, 'wx');
  try {
    await file.writeFile(JSON.stringify(artifact, null, 2));
  } finally {
    await file.close();
  }
}

function toEvalWatch(watch: readonly WatchEntry[]) {
  return watch.map((w) => ({
    action: w.action,
    subscriberId: w.subscriber_id,
    subscriberVersion: w.subscriber_version,
  }));
}

async function plan(manifestPath: string, outPath: string) {
  requireDeploymentDb();
  const manifest = cancelManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  assertApprovedScope(manifest);
  const { db } = await import('@/db/client');
  try {
    const targets = await db.transaction(async (tx) => {
      // One repeatable-read snapshot for the whole batch — the plan freezes
      // what a single consistent DB state showed, never a moving mix.
      await tx.execute(sql`set transaction isolation level repeatable read, read only`);
      const evaluated: {
        target: CancelTarget;
        identity: PaidEffectIdentity;
        eval: Awaited<ReturnType<typeof evaluatePaidEffectCancelEligibility>>;
      }[] = [];
      for (const target of manifest.targets) {
        const identity = identityOf(target);
        evaluated.push({
          target,
          identity,
          eval: await evaluatePaidEffectCancelEligibility(tx, identity, {
            expectedFence: target.expected_fence,
            watch: toEvalWatch(manifest.watch),
          }),
        });
      }
      return evaluated;
    });
    const eligible = targets.every((t) => t.eval.eligible);
    const artifact = {
      version: 1,
      planned_at: new Date().toISOString(),
      manifest_sha256: sha256(manifest),
      request: {
        request_id: manifest.request_id,
        operator: manifest.operator,
        reason: manifest.reason,
        basis: manifest.basis,
      },
      watch: manifest.watch,
      eligible,
      targets: targets.map(({ identity, target, eval: e }) => ({
        identity,
        expected_fence: target.expected_fence,
        eligible: e.eligible,
        failures: e.failures,
        observed: e.observed,
      })),
    };
    await writeOnce(outPath, artifact);
    console.log(
      eligible ? `plan OK — wrote ${outPath}` : `plan has ineligible targets — wrote ${outPath}`,
    );
    if (!eligible) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

async function apply(manifestPath: string, planPath: string, planSha256: string, outPath: string) {
  requireDeploymentDb();
  const manifest = cancelManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  assertApprovedScope(manifest);
  // The frozen plan IS the execution authorization — verify it binds this
  // exact manifest and scope before the database client is even imported.
  // request_id is per-identity idempotency metadata, not a batch scope key.
  const frozen = await verifyFrozenPlan(planPath, planSha256, manifest);
  const { db } = await import('@/db/client');
  const results: Record<string, unknown>[] = [];
  let allSettled = true;
  try {
    for (const target of manifest.targets) {
      const identity = identityOf(target);
      try {
        const outcome = await db.transaction(async (tx) => {
          // SERIALIZABLE must be the first statement of the tx. Every gate —
          // row state, binding, live jobs, unsettled deliveries, undelivered
          // watch events — must read one consistent snapshot: the
          // event→delivery discovery handoff does NOT take the paid-effect
          // family advisory, so under READ COMMITTED it could commit between
          // two of these SELECTs and slip past both. Under SERIALIZABLE such
          // an interleave aborts this transaction at commit (40001); the
          // target is recorded failed and the operator re-plans. No retry
          // loop, no gate bypass — the lock order itself is unchanged.
          await tx.execute(sql`set transaction isolation level serializable`);
          await lockPaidEffectControlFamily(tx, identity.family);
          // Replay first, inside the same locked tx: a row already cancelled
          // under the EXACT same request returns its stored receipt without
          // re-proving eligibility — the committed result must be
          // recoverable even if the process died before the artifact write
          // or new queue work arrived since. A divergent replay conflicts.
          const snap = await readPaidEffect(tx, identity);
          if (snap?.state === 'cancelled') {
            return cancelPaidEffectUnsentIntent(tx, identity, {
              expectedFence: target.expected_fence,
              cancellation: {
                requestId: manifest.request_id,
                reason: manifest.reason,
                operator: manifest.operator,
                basis: manifest.basis,
              },
            });
          }
          // Fresh cancels only: the never-sent proof gates the write.
          const eligibility = await evaluatePaidEffectCancelEligibility(tx, identity, {
            expectedFence: target.expected_fence,
            watch: toEvalWatch(manifest.watch),
          });
          if (!eligibility.eligible) {
            throw new Error(`eligibility re-check failed: ${eligibility.failures.join('; ')}`);
          }
          return cancelPaidEffectUnsentIntent(tx, identity, {
            expectedFence: target.expected_fence,
            cancellation: {
              requestId: manifest.request_id,
              reason: manifest.reason,
              operator: manifest.operator,
              basis: manifest.basis,
            },
          });
        });
        results.push({ identity, expected_fence: target.expected_fence, outcome });
      } catch (error) {
        allSettled = false;
        const code = (error as { code?: string } | null)?.code;
        results.push({
          identity,
          expected_fence: target.expected_fence,
          outcome: code === '40001' ? 'serialization_conflict' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const artifact = {
      version: 1,
      applied_at: new Date().toISOString(),
      manifest_sha256: sha256(manifest),
      plan_sha256: frozen.planSha256,
      plan_manifest_sha256: frozen.plan.manifest_sha256,
      request: {
        request_id: manifest.request_id,
        operator: manifest.operator,
        reason: manifest.reason,
        basis: manifest.basis,
      },
      settled: allSettled,
      results,
    };
    await writeOnce(outPath, artifact);
    console.log(
      allSettled ? `apply OK — wrote ${outPath}` : `apply had failed targets — wrote ${outPath}`,
    );
    if (!allSettled) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

const [mode, positional, ...flagArgs] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < flagArgs.length; i += 1) {
  const arg = flagArgs[i];
  if (arg.startsWith('--')) {
    const next = flagArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else {
      flags[arg.slice(2)] = 'true';
    }
  }
}
const run =
  mode === '--help'
    ? Promise.resolve(
        console.log(
          'Lead-only ops entry for the generic never-sent paid-intent cancel (YUK-1567). ' +
            'plan <m.json> --out <plan.json> is read-only eligibility + plan freeze; ' +
            'apply <m.json> --out <receipt.json> --plan <plan.json> ' +
            '--plan-sha256 sha256:<approved plan hash> cancels exactly the identities ' +
            'the verified frozen plan authorizes (one SERIALIZABLE tx each: family ' +
            'advisory → strict replay or eligibility re-check → event + CAS). ' +
            'Admission family only; watch must match the declared enqueue subscription ' +
            'item-for-item. Requires DATABASE_URL === YUK1567_DATABASE_URL. ' +
            'Never enqueues, never calls a provider, no Docker.',
        ),
      )
    : mode === 'plan' && positional && flags.out
      ? plan(positional, flags.out)
      : mode === 'apply' && positional && flags.out && flags.plan && flags['plan-sha256']
        ? apply(positional, flags.plan, flags['plan-sha256'], flags.out)
        : Promise.reject(
            new Error(
              'Use --help; positional manifest is required. ' +
                'plan needs --out; apply needs --out, --plan <frozen plan.json>, and ' +
                '--plan-sha256 sha256:<approved plan hash from the frozen ops record>',
            ),
          );
run.catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
