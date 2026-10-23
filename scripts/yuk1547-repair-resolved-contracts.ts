/**
 * YUK-1547 — free repair driver for applied-but-mispublished admissions.
 *
 * The P0 defect: question_admission_run applied an admitted verdict by
 * publishing the frozen BASE input contract, dropping the paid receipt's
 * `resolved` contract (typed keys + deterministic executors). The affected
 * groups sit 'admitted' on a still human_review revision and the serving gate
 * refuses them. This driver republishes the receipt's resolved contract — free
 * (no provider calls, no pg-boss jobs, no paid_effect writes): the paid row
 * stays applied on the old revision; the NEW revision's published_by +
 * question_admission_verification row carry the payment→version binding.
 *
 * The manifest names each repairable admission EXACTLY — group + expected
 * current revision/digest/generation + paid (unit, input_digest, fence). Only
 * successful APPLIED admitted receipts qualify: no current-bound applied
 * evidence → the group simply stays out of the manifest; an entry whose paid
 * row is missing/unknown/mismatched is blocked, never guessed.
 *
 *   plan   — write-free (default posture). Each entry is evaluated inside a
 *            normal transaction that briefly takes the family advisory lock +
 *            FOR UPDATE row locks (NOT a Postgres READ ONLY transaction —
 *            locks cannot run there), then commits with zero writes. Prints
 *            disposition plus the REAL serving-gate count
 *            (readAutomaticallyServableQuestionIds — the same part binding
 *            real issuance uses, never an admitted count).
 *   apply  — per-entry transaction: evaluate → publish resolved via the
 *            central publisher → project the root row. Requires --reason
 *            (operator justification, recorded in the repair provenance on
 *            published_by) and --out (per-entry repair receipts + summary).
 *            Idempotent: a current revision already carrying this receipt's
 *            FULL binding (family/entity/unit/input_digest/receipt_digest/
 *            resolved+published digests, canonical seal of the stored layers)
 *            reports already_repaired and mints nothing.
 *
 * usage:
 *   tsx scripts/yuk1547-repair-resolved-contracts.ts plan  --manifest m.json [--out dir]
 *   tsx scripts/yuk1547-repair-resolved-contracts.ts apply --manifest m.json --out dir --reason "…"
 *
 * Env: DATABASE_URL. The script never calls providers, never enqueues, and
 * never mutates paid_effect — write scope is exactly publishQuestionGroup's
 * seam (question_revision / question_group_lifecycle / event /
 * question_admission_verification) plus the root question projection.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RepairOutcome } from '@/capabilities/practice/server/admission/resolved-repair';
import type { Db } from '@/db/client';

const usage =
  'usage: tsx scripts/yuk1547-repair-resolved-contracts.ts <plan|apply> ' +
  '--manifest <path> [--out <dir>] [--reason "<operator reason>"]';

const manifestSchema = z
  .object({
    version: z.literal(1),
    generated_at: z.string().optional(),
    source: z.string().optional(),
    entries: z.array(z.unknown()).nonempty(),
  })
  .passthrough();

interface Cli {
  command: 'plan' | 'apply';
  manifestPath: string;
  outDir?: string;
  reason?: string;
}

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
      if (value == null || value.startsWith('--'))
        throw new Error(`flag '${arg}' needs a value\n${usage}`);
      flags.set(arg.slice(2), value);
      i += 1;
    }
  }
  const manifestPath = flags.get('manifest');
  if (!manifestPath) throw new Error(`--manifest is required\n${usage}`);
  const cli: Cli = {
    command,
    manifestPath,
    ...(flags.get('out') != null ? { outDir: flags.get('out') } : {}),
    ...(flags.get('reason') != null ? { reason: flags.get('reason') } : {}),
  };
  if (command === 'apply' && (!cli.reason || cli.reason.trim().length === 0)) {
    throw new Error(`apply requires --reason "<operator justification>"\n${usage}`);
  }
  if (command === 'apply' && !cli.outDir) {
    throw new Error(`apply requires --out <dir> for repair receipts\n${usage}`);
  }
  return cli;
}

async function loadEntries(manifestPath: string) {
  const { RepairManifestEntry } = await import(
    '@/capabilities/practice/server/admission/resolved-repair'
  );
  const raw = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const entries = raw.entries.map((entry) => RepairManifestEntry.parse(entry));
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.group_id}|${entry.paid.input_digest}`;
    if (seen.has(key)) throw new Error(`manifest duplicates ${key}`);
    seen.add(key);
  }
  return { manifest: raw, entries };
}

/** Real serving gate — same part binding issuance uses; no side effects. */
async function servableCount(db: Db, groupIds: string[]) {
  const { readAutomaticallyServableQuestionIds } = await import(
    '@/kernel/records/assessment-issuance'
  );
  return readAutomaticallyServableQuestionIds(db, groupIds);
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const { entries } = await loadEntries(cli.manifestPath);
  const [{ db }, repair] = await Promise.all([
    import('@/db/client'),
    import('@/capabilities/practice/server/admission/resolved-repair'),
  ]);
  const groupIds = entries.map((entry) => entry.group_id);
  try {
    if (cli.command === 'plan') {
      const outcomes: Record<string, unknown>[] = [];
      let ready = 0;
      let already = 0;
      let blocked = 0;
      for (const entry of entries) {
        const evaluation = await db.transaction((tx) => repair.evaluateResolvedRepair(tx, entry));
        if (evaluation.kind === 'ready') {
          ready += 1;
          outcomes.push({
            group_id: entry.group_id,
            status: 'ready',
            target_revision_digest: evaluation.targetRevisionDigest,
            resolved_contract_digest: evaluation.resolvedContractDigest,
            presentation_source: evaluation.presentationSource,
            retained_unknown_rows: evaluation.ready.retainedUnknownRows,
          });
        } else if (evaluation.kind === 'already_repaired') {
          already += 1;
          outcomes.push({
            group_id: entry.group_id,
            status: 'already_repaired',
            revision_id: evaluation.revisionId,
            revision_digest: evaluation.revisionDigest,
          });
        } else {
          blocked += 1;
          outcomes.push({
            group_id: entry.group_id,
            status: 'blocked',
            reason: evaluation.reason,
          });
        }
      }
      const servable = await servableCount(db, groupIds);
      const summary = {
        mode: 'plan',
        checked_at: new Date().toISOString(),
        entries: entries.length,
        ready,
        already_repaired: already,
        blocked,
        /** Real issuance gate on CURRENT state — admitted flag is not evidence. */
        currently_servable: servable.size,
        currently_servable_ids: [...servable],
        note: 'ready/already_repaired project to admitted; actual servable-after count is only measured on a copy by apply.',
      };
      console.log(JSON.stringify({ summary, outcomes }, null, 2));
      if (cli.outDir) {
        await mkdir(cli.outDir, { recursive: true });
        await writeFile(
          join(cli.outDir, 'plan.json'),
          `${JSON.stringify({ summary, outcomes }, null, 2)}\n`,
        );
      }
      process.exitCode = blocked > 0 ? 1 : 0;
      return;
    }

    // ---- apply ----
    if (cli.outDir) await mkdir(cli.outDir, { recursive: true });
    const servableBefore = await servableCount(db, groupIds);
    const outcomes: (Record<string, unknown> & { group_id: string })[] = [];
    let repaired = 0;
    let already = 0;
    let failed = 0;
    for (const entry of entries) {
      let outcome: RepairOutcome;
      try {
        outcome = await db.transaction((tx) =>
          repair.applyResolvedRepair(tx, entry, {
            operatorReason: cli.reason ?? '',
            now: new Date(),
            readAssetBytes: async (storageKey) => {
              const { getR2 } = await import('@/server/r2');
              return getR2().get(storageKey);
            },
          }),
        );
      } catch (error) {
        outcome = {
          status: 'blocked',
          group_id: entry.group_id,
          reason: `apply_threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (outcome.status === 'repaired') repaired += 1;
      else if (outcome.status === 'already_repaired') already += 1;
      else failed += 1;
      outcomes.push({ ...outcome, checked_at: new Date().toISOString() });
      console.log(JSON.stringify(outcome));
      if (cli.outDir) {
        await writeFile(
          join(cli.outDir, `${entry.group_id}.receipt.json`),
          `${JSON.stringify(outcome, null, 2)}\n`,
        );
      }
    }
    const servableAfter = await servableCount(db, groupIds);
    const summary = {
      mode: 'apply',
      ran_at: new Date().toISOString(),
      operator_reason: cli.reason,
      entries: entries.length,
      repaired,
      already_repaired: already,
      failed,
      servable_before: servableBefore.size,
      servable_after: servableAfter.size,
      servable_after_ids: [...servableAfter],
      note: 'servable_* come from readAutomaticallyServableQuestionIds (real issuance gate); admission-state counts alone are not serving evidence.',
    };
    console.log(JSON.stringify({ summary }, null, 2));
    if (cli.outDir) {
      await mkdir(cli.outDir, { recursive: true });
      await writeFile(
        join(cli.outDir, 'summary.json'),
        `${JSON.stringify({ summary, outcomes }, null, 2)}\n`,
      );
    }
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await db.$client.end().catch(() => {});
  }
}

// dotenv must load before @/db/client is touched (it throws on a missing
// DATABASE_URL at module init); all DB-touching imports above are dynamic.
await import('./load-env');
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
