/**
 * One-off handover driver for still-pending `image_candidate` proposals.
 *
 * A still-pending image_candidate has no producer and no live accept path.
 * plan exports the candidate URL list as the handover receipt
 * for the supply agent (备题员); apply writes one `rate`/`rollback` event per
 * pending proposal so the inbox classifies it as stale.
 *
 * Lock order inside apply's per-proposal transaction: proposal_decision first
 * (the shared decision lock every lifecycle path takes first), then
 * image_candidate_accept (a rolling deploy's old worker can still hold the
 * claim lock). No live path inverts this order: the generic
 * dismiss/retract paths never take image_candidate_accept.
 *
 *   plan   — read-only. Lists every pending image_candidate proposal (id,
 *            created_at, candidate URLs + title, live-claim state), writes the
 *            handover receipt JSON to --out and prints its sha256.
 *   apply  — per-proposal transaction: locks → re-check no rate event and no
 *            live accept claim → write rate/rollback with user_note 已交备题员.
 *            A decided or live-claimed proposal is skipped, never overwritten.
 *            Idempotent: a second apply writes nothing.
 *
 * usage:
 *   tsx scripts/yuk1664-image-candidate-handover.ts plan  --target <postgres-url> --out <dir>
 *   tsx scripts/yuk1664-image-candidate-handover.ts apply --target <postgres-url> --out <dir> --stop <path> --confirm-write
 *
 * --target is required for both commands (never falls back to DATABASE_URL);
 * apply additionally requires --confirm-write and a --stop file path whose
 * existence aborts the run.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import * as schema from '@/db/schema';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { lockImageCandidateAccept } from '@/kernel/locks/image-candidate-accept-lock';
import { acquireProposalDecisionLock } from '@/kernel/proposals/applier-helpers';

const ACCEPT_STARTED_ACTION = 'experimental:image_candidate_accept_started';
const ACCEPT_FAILED_ACTION = 'experimental:image_candidate_accept_failed';
// Same claim staleness window the retired accept path used: a started marker
// newer than any clearing failure but older than this no longer blocks.
const ACCEPT_STALE_MS = 10 * 60 * 1000;
const ROLLBACK_REASON = '已交备题员';

const usage =
  'usage:\n' +
  '  tsx scripts/yuk1664-image-candidate-handover.ts plan  --target <postgres-url> --out <dir>\n' +
  '  tsx scripts/yuk1664-image-candidate-handover.ts apply --target <postgres-url> --out <dir> --stop <path> --confirm-write';

type Cli =
  | { command: 'plan'; target: string; outDir: string }
  | { command: 'apply'; target: string; outDir: string; stopPath: string; confirmWrite: boolean };

function parseArgs(argv: string[]): Cli {
  const [command, ...rest] = argv;
  if (command !== 'plan' && command !== 'apply') {
    throw new Error(`missing or unknown command\n${usage}`);
  }
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected arg '${arg}'\n${usage}`);
    if (arg === '--confirm-write') {
      booleans.add('confirm-write');
      continue;
    }
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
  const target = flags.get('target');
  const outDir = flags.get('out');
  if (!target || target.trim().length === 0) {
    throw new Error(`--target is required (never falls back to DATABASE_URL)\n${usage}`);
  }
  if (!outDir) throw new Error(`--out is required for receipts\n${usage}`);
  if (command === 'plan') return { command, target, outDir };
  const stopPath = flags.get('stop');
  if (!stopPath) throw new Error(`apply requires --stop <path>\n${usage}`);
  return { command, target, outDir, stopPath, confirmWrite: booleans.has('confirm-write') };
}

/** contract-epoch 同款 target gate：非空、可解析、host+db 齐备。 */
function requireTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--target is not a parseable URL: ${JSON.stringify(raw)}`);
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname || url.pathname === '/') {
    throw new Error(
      `--target must be a postgres URL with host and database: ${JSON.stringify(raw)}`,
    );
  }
  return url;
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function writeReceipt(outDir: string, name: string, value: unknown): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(outDir, name), text);
  return sha256Hex(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every http(s) URL anywhere inside the ai_proposal payload — the handover list. */
function collectUrls(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectUrls(entry, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectUrls(entry, into);
  }
}

interface PendingProposalRow {
  id: string;
  created_at: Date;
  aiProposal: Record<string, unknown>;
}

/**
 * image_candidate proposals with no rate decision yet. "Any rate row" is the
 * strictest live interpretation (the retired accept's claim check treated any
 * rate as decided), so pending here means zero chained rate events.
 */
async function listPendingImageCandidates(db: Db): Promise<PendingProposalRow[]> {
  const rows = await db
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:proposal'),
        sql`coalesce(${event.payload}->'ai_proposal'->>'kind', ${event.payload}->>'kind') = 'image_candidate'`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} AS rate_row
          WHERE rate_row.action = 'rate' AND rate_row.caused_by_event_id = ${event.id}
        )`,
      ),
    )
    .orderBy(event.created_at, event.id);
  return rows.map((row: { id: string; created_at: Date; payload: unknown }) => {
    const payload = asRecord(row.payload);
    const aiProposal = asRecord(payload.ai_proposal ?? payload);
    return { id: row.id, created_at: row.created_at, aiProposal };
  });
}

interface ClaimState {
  live: boolean;
  latest_started_at: Date | null;
  latest_failed_at: Date | null;
}

async function latestMarker(db: Db | Tx, action: string, proposalId: string): Promise<Date | null> {
  const row = (
    await db
      .select({ created_at: event.created_at })
      .from(event)
      .where(and(eq(event.action, action), eq(event.caused_by_event_id, proposalId)))
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(1)
  )[0];
  return row?.created_at ?? null;
}

async function readClaimState(db: Db | Tx, proposalId: string, now: Date): Promise<ClaimState> {
  const [startedAt, failedAt] = await Promise.all([
    latestMarker(db, ACCEPT_STARTED_ACTION, proposalId),
    latestMarker(db, ACCEPT_FAILED_ACTION, proposalId),
  ]);
  const live =
    startedAt !== null &&
    (failedAt === null || failedAt.getTime() < startedAt.getTime()) &&
    now.getTime() - startedAt.getTime() <= ACCEPT_STALE_MS;
  return { live, latest_started_at: startedAt, latest_failed_at: failedAt };
}

async function hasRateEvent(db: Db | Tx, proposalId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)))
      .limit(1)
  )[0];
  return row !== undefined;
}

function proposalEntry(row: PendingProposalRow, claim: ClaimState) {
  const change = asRecord(row.aiProposal.proposed_change);
  const urls = new Set<string>();
  collectUrls(row.aiProposal, urls);
  return {
    id: row.id,
    created_at: row.created_at.toISOString(),
    source_url: typeof change.source_url === 'string' ? change.source_url : null,
    source_title: typeof change.source_title === 'string' ? change.source_title : null,
    requested_kind: typeof change.requested_kind === 'string' ? change.requested_kind : null,
    urls: [...urls].sort(),
    live_claim: claim.live,
    latest_accept_started_at: claim.latest_started_at?.toISOString() ?? null,
    latest_accept_failed_at: claim.latest_failed_at?.toISOString() ?? null,
  };
}

type ApplyOutcome =
  | { proposal_id: string; status: 'rolled_back'; rate_event_id: string }
  | { proposal_id: string; status: 'skipped_rated' | 'skipped_live_claim' }
  | { proposal_id: string; status: 'error'; error: string };

async function applyOne(
  db: Db,
  proposalId: string,
  stopPath: string,
  now: Date,
): Promise<ApplyOutcome> {
  try {
    return await db.transaction(async (tx) => {
      // Re-check STOP inside the transaction — a stop that landed between the
      // pre-check and this tx still blocks this proposal's write.
      await assertNoStop(stopPath);
      await acquireProposalDecisionLock(tx, proposalId);
      await lockImageCandidateAccept(tx, proposalId);
      if (await hasRateEvent(tx, proposalId)) {
        return { proposal_id: proposalId, status: 'skipped_rated' as const };
      }
      const claim = await readClaimState(tx, proposalId, now);
      if (claim.live) {
        return { proposal_id: proposalId, status: 'skipped_live_claim' as const };
      }
      const rateEventId = newId();
      await writeEvent(tx, {
        id: rateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: { rating: 'rollback', user_note: ROLLBACK_REASON },
        caused_by_event_id: proposalId,
        created_at: now,
      });
      return {
        proposal_id: proposalId,
        status: 'rolled_back' as const,
        rate_event_id: rateEventId,
      };
    });
  } catch (error) {
    return {
      proposal_id: proposalId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const target = requireTarget(cli.target);
  if (cli.command === 'apply') {
    if (!cli.confirmWrite) {
      throw new Error(`apply writes rate events — pass --confirm-write\n${usage}`);
    }
    // STOP is checked before ANY other apply work — ENOENT means no stop; an
    // existing file or any other access error fails closed.
    await assertNoStop(cli.stopPath);
  }
  const client = postgres(cli.target, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Db;
  try {
    const now = new Date();
    const pending = await listPendingImageCandidates(db);
    const totalRows = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:proposal'),
          sql`coalesce(${event.payload}->'ai_proposal'->>'kind', ${event.payload}->>'kind') = 'image_candidate'`,
        ),
      );
    const entries = [];
    const handoverUrls = new Set<string>();
    for (const row of pending) {
      const claim = await readClaimState(db, row.id, now);
      const entry = proposalEntry(row, claim);
      for (const url of entry.urls) handoverUrls.add(url);
      entries.push(entry);
    }

    if (cli.command === 'plan') {
      const receipt = {
        mode: 'plan' as const,
        generated_at: now.toISOString(),
        target: `${target.host}${target.pathname}`,
        kind: 'image_candidate',
        total_count: totalRows.length,
        pending_count: entries.length,
        handover_urls: [...handoverUrls].sort(),
        proposals: entries,
      };
      const sha = await writeReceipt(cli.outDir, 'plan-receipt.json', receipt);
      console.log(JSON.stringify({ ...receipt, receipt_sha256: sha }, null, 2));
      console.log(`[handover] plan receipt sha256=${sha}`);
      return;
    }

    // ---- apply ----
    const outcomes: ApplyOutcome[] = [];
    let rolledBack = 0;
    let skippedRated = 0;
    let skippedLiveClaim = 0;
    let errors = 0;
    for (const row of pending) {
      const outcome = await applyOne(db, row.id, cli.stopPath, now);
      outcomes.push(outcome);
      if (outcome.status === 'rolled_back') rolledBack += 1;
      else if (outcome.status === 'skipped_rated') skippedRated += 1;
      else if (outcome.status === 'skipped_live_claim') skippedLiveClaim += 1;
      else errors += 1;
      console.log(JSON.stringify(outcome));
    }
    const summary = {
      mode: 'apply' as const,
      ran_at: now.toISOString(),
      target: `${target.host}${target.pathname}`,
      kind: 'image_candidate',
      total_count: totalRows.length,
      pending_before: entries.length,
      rolled_back: rolledBack,
      skipped_rated: skippedRated,
      skipped_live_claim: skippedLiveClaim,
      errors,
      handover_urls: [...handoverUrls].sort(),
      outcomes,
    };
    const sha = await writeReceipt(cli.outDir, 'apply-receipt.json', summary);
    const { outcomes: _outcomes, ...summaryLine } = summary;
    console.log(JSON.stringify({ ...summaryLine, receipt_sha256: sha }, null, 2));
    console.log(`[handover] apply receipt sha256=${sha}`);
    process.exitCode = errors > 0 ? 1 : 0;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
