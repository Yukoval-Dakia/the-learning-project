// Lead-only ops entry for the GENERIC never-sent paid-intent cancel (YUK-1567).
// No automatic caller; no tests, no Docker, no provider calls — this script
// only reads/writes the deployment DB through @/db/client.
//
//   plan  <m.json> --out <plan.json>
//       READ-ONLY. Evaluates every manifest target inside one repeatable-read
//       snapshot and freezes a write-once plan artifact with per-target
//       eligibility + observed state. Nothing is mutated.
//   apply <m.json> --out <receipt.json>
//       Executes ONLY the frozen manifest targets — one transaction per
//       target: family advisory lock → re-verify eligibility under locks →
//       cancelPaidEffectUnsentIntent (cancellation event + pending→cancelled
//       CAS commit or roll back together). Per-target outcomes are recorded
//       verbatim; a replayed request id reuses the stored receipt, a
//       different request id on an already-cancelled row fails closed.
//
// The manifest is the frozen approval. Every target names the COMPLETE
// 5-part paid-effect identity plus the fence CAS token — the tool never
// fishes for paid rows by group, actor, time, or state, and never touches a
// row outside the listed identities. The agreed CAS is identity + fence +
// the never-sent predicate, NOT a row-digest comparison: full_row_md5 values
// recorded before the 0124 columns existed are pre-migration observations
// and are never used as a compare token.
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
import type { PaidEffectIdentity } from '@/core/migration/paid-effect-protocol';
import { lockPaidEffectControlFamily } from '@/db/paid-effect-control';
import {
  cancelPaidEffectUnsentIntent,
  evaluatePaidEffectCancelEligibility,
} from '@/db/paid-effect-store';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * The frozen approval manifest. `request_id` is the operation's idempotency
 * anchor; `watch` declares the (action, subscriber) pairs whose undelivered
 * events could still mint work for the entity — empty means the operator
 * asserts no enqueue pipeline exists for this family. `targets` is the FULL
 * batch scope: apply iterates exactly this list, one transaction each, never
 * anything else.
 */
const cancelManifestSchema = z.object({
  version: z.literal(1),
  request_id: z.string().min(1),
  operator: z.string().min(1),
  reason: z.string().min(1),
  basis: z.string().min(1),
  watch: z
    .array(
      z.object({
        action: z.string().min(1),
        subscriber_id: z.string().min(1),
      }),
    )
    .default([]),
  targets: z
    .array(
      z.object({
        family: z.string().min(1),
        entity_id: z.string().min(1),
        entity_revision: z.string().min(1),
        unit: z.string().min(1),
        input_digest: digest,
        expected_fence: z.number().int().nonnegative(),
      }),
    )
    .nonempty(),
});
type CancelManifest = z.infer<typeof cancelManifestSchema>;
type CancelTarget = CancelManifest['targets'][number];

const sha256 = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

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

function assertUniqueTargets(manifest: CancelManifest): void {
  const seen = new Set<string>();
  for (const target of manifest.targets) {
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

async function plan(manifestPath: string, outPath: string) {
  requireDeploymentDb();
  const manifest = cancelManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  assertUniqueTargets(manifest);
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
            watch: manifest.watch.map((w) => ({
              action: w.action,
              subscriberId: w.subscriber_id,
            })),
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

async function apply(manifestPath: string, outPath: string) {
  requireDeploymentDb();
  const manifest = cancelManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  assertUniqueTargets(manifest);
  const { db } = await import('@/db/client');
  const results: Record<string, unknown>[] = [];
  let allSettled = true;
  try {
    for (const target of manifest.targets) {
      const identity = identityOf(target);
      try {
        const outcome = await db.transaction(async (tx) => {
          // The family advisory is held for the whole transaction: every
          // claim, void, or competing cancel for this family serializes
          // behind it, so the eligibility re-check below cannot be raced past
          // before commit.
          await lockPaidEffectControlFamily(tx, identity.family);
          const eligibility = await evaluatePaidEffectCancelEligibility(tx, identity, {
            expectedFence: target.expected_fence,
            watch: manifest.watch.map((w) => ({
              action: w.action,
              subscriberId: w.subscriber_id,
            })),
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
        results.push({
          identity,
          expected_fence: target.expected_fence,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const artifact = {
      version: 1,
      applied_at: new Date().toISOString(),
      manifest_sha256: sha256(manifest),
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
            'apply <m.json> --out <receipt.json> cancels exactly the listed identities ' +
            '(one transaction each: family advisory → eligibility re-check → event + CAS). ' +
            'Requires DATABASE_URL === YUK1567_DATABASE_URL. Never enqueues, never calls a provider, no Docker.',
        ),
      )
    : mode === 'plan' && positional && flags.out
      ? plan(positional, flags.out)
      : mode === 'apply' && positional && flags.out
        ? apply(positional, flags.out)
        : Promise.reject(new Error('Use --help; positional manifest and --out are required'));
run.catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
