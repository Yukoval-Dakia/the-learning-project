// Conjecture → misconception PROMOTION writer.
//
// When the owner ACCEPTS a conjecture (agrees with its direction), this dark, flag-gated
// hop mints a first-class `misconception` node + a `caused_by` misconception_edge (misc →
// the KC it corrupts). The reconcile ring is the pure decision/audit layer, built dark and
// NOT wired here.
//
// SOFT-TRACK: a minted misconception is `source: 'soft'` — an AI prior the owner agreed
// with, NOT a confirmed weakness; only the probe one-shot mints a hard-confirmed weakness.
// The node / its edge feed θ̂ / p(L) / FSRS / difficulty / mastery NOTHING (the `.strict()`
// Zod on the insert schemas machine-checks this — no diagnostic column can ride on the row).
//
// IMPERATIVE write (no event/fold): misconception has no projection, so this is a direct
// upsert; provenance lives in the row (evidence event-ptr array + seen + source).

import { createHash } from 'node:crypto';

import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { getConfigFlag } from '@/core/config/store';
import { MisconceptionInsert } from '@/core/schema/misconception';
import type { Tx } from '@/db/client';
import { misconception, misconception_edge } from '@/db/schema';
import {
  archiveMisconceptionEdge,
  createMisconceptionEdge,
} from '@/kernel/records/misconception-edges';

/**
 * Recurrence threshold the accept must meet to promote.
 *
 * ⚠️ At k=2 this gate is REDUNDANT with the induction floor: every conjecture already has
 * recurrence_count ≥ CONJECTURE_RECURRENCE_FLOOR (=2), so the real gate is the flag
 * (MISCONCEPTION_PROMOTE_ENABLED) + the human accept. The constant only bites at k > 2;
 * do NOT read it as a live runtime gate at k=2.
 */
export const K_PROMOTE = 2;

/**
 * Neutral salience weight when an accepted conjecture carries no usable `confidence`
 * (legacy proposal, or one coercing to NaN). 0.5 = "agree with the DIRECTION, no calibrated
 * salience" — minting at mid-confidence avoids a ZodError that would roll back the owner's
 * whole accept transaction with a 500. Flag-OFF is unaffected (the hop never runs).
 */
export const DEFAULT_MISCONCEPTION_WEIGHT = 0.5;

/**
 * Normalize a raw confidence into the [0,1] band: finite values are clamped, NaN / ±Infinity
 * fall back to DEFAULT_MISCONCEPTION_WEIGHT. Both the node weight and its edge weight consume
 * the result, so neither can feed NaN/out-of-range into the `.strict()` parse barrier.
 */
function normalizeConfidenceWeight(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_MISCONCEPTION_WEIGHT;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Dark-ship flag. Default OFF — when OFF the accept path is effect-identical to today (no
 * misconception, no edge). Read per-call so each process sees its own env.
 */
export function misconceptionPromoteEnabled(): boolean {
  // pinned key——DB 层跳过，直读 env > code-default（compose 强制项；'unset/垃圾值 → false'
  // 保守地板不变）。
  return getConfigFlag('MISCONCEPTION_PROMOTE_ENABLED');
}

/**
 * Kill switch for the HARD-confirm track (source: 'soft'→'hard' upgrade). Default OFF; when
 * OFF, decideDissociation is structurally unable to return HARD_CONFIRM, so no
 * evidence-driven hard upgrade can fire. A soft→hard flip additionally requires a FRESH owner
 * confirmation at the command call site — never automatic; the nightly accountability reader
 * passes fresh=false, so it can rank but never mutate the hard track.
 */
export function misconceptionHardConfirmEnabled(): boolean {
  // DB > env > default(false)。
  return getConfigFlag('MISCONCEPTION_HARD_CONFIRM_ENABLED');
}

/**
 * Deterministic misconception id keyed on the conjecture IDENTITY (cause_category ×
 * knowledge_id), NOT the proposal id: a later re-induction of the same cause×KC UPSERTs the
 * same misconception (bump seen / refresh evidence) instead of minting a duplicate identity.
 * Re-accept of the SAME proposal never reaches this hop (rate-event idempotency guard).
 */
export function misconceptionIdForConjecture(causeCategory: string, knowledgeId: string): string {
  const key = `${causeCategory}::${knowledgeId}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `misc_${hash}`;
}

export interface ArchiveSoftMisconceptionResult {
  misconceptionId: string;
  archived: boolean;
}

/**
 * Archive an existing soft misconception for this cause×KC identity after the owner edits a
 * later conjecture: the edit disputes the cell's soft description, so leaving that prior live
 * is unsafe. A hard-confirmed row is never touched (probe evidence outranks a wording edit).
 * Node and its live edges archive together under the same per-identity lock, preserving
 * provenance and keeping the operation reversible.
 */
export async function archiveSoftMisconceptionForConjecture(
  tx: Tx,
  causeCategory: string,
  knowledgeId: string,
  now: Date,
): Promise<ArchiveSoftMisconceptionResult> {
  const misconceptionId = misconceptionIdForConjecture(causeCategory, knowledgeId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`misc:${misconceptionId}`}))`);

  const nodes = await tx
    .select({ source: misconception.source, archivedAt: misconception.archived_at })
    .from(misconception)
    .where(eq(misconception.id, misconceptionId))
    .limit(1);
  const node = nodes[0];
  if (node?.source !== 'soft') return { misconceptionId, archived: false };

  if (node.archivedAt === null) {
    await tx
      .update(misconception)
      .set({ archived_at: now, updated_at: now })
      .where(eq(misconception.id, misconceptionId));
  }

  const liveEdges = await tx
    .select({ id: misconception_edge.id })
    .from(misconception_edge)
    .where(
      and(
        or(
          and(
            eq(misconception_edge.from_kind, 'misconception'),
            eq(misconception_edge.from_id, misconceptionId),
          ),
          and(
            eq(misconception_edge.to_kind, 'misconception'),
            eq(misconception_edge.to_id, misconceptionId),
          ),
        ),
        isNull(misconception_edge.archived_at),
      ),
    );
  for (const edge of liveEdges) await archiveMisconceptionEdge(tx, edge.id, now);

  return { misconceptionId, archived: node.archivedAt === null };
}

export interface PromoteConjectureInput {
  /** The conjecture's stable id (= the proposal event id). */
  conjectureId: string;
  /** The KC the misconception corrupts (caused_by target). */
  knowledgeId: string;
  /**
   * The conjecture claim — becomes the misconception title. Must be same-source as
   * `evidenceEventIds`: the live accept path only reaches here on a PLAIN accept (an edit
   * skips promotion entirely), so the title is always the claim those pointers support.
   */
  claimMd: string;
  causeCategory: string;
  /** Internal confidence (0-1) — the salience weight, never rendered as a number. */
  confidence: number;
  /** Recurrence count that drove promotion — the `seen` salience count (NOT mastery). */
  recurrenceCount: number;
  /** Provenance event-ptr array (the conjecture's evidence event ids). */
  evidenceEventIds: string[];
  /** Caller-supplied write instant (house convention — no defaultNow). */
  now: Date;
  /**
   * Which track this promotion writes. 'soft' (default) = an AI prior the owner agreed with —
   * the ONLY value the live accept path passes. 'hard' requires a decideDissociation()
   * 'HARD_CONFIRM' verdict AND a fresh owner confirmation; the nightly accountability caller
   * always passes fresh=false. The conflict guard makes 'soft' never downgrade a 'hard' row.
   */
  source?: 'hard' | 'soft';
  /**
   * Explicit reactivation (default false). ONLY true clears `archived_at` on an UPSERT
   * conflict: a plain soft re-accept must NOT un-archive a node the retire/reconcile ring
   * soft-archived.
   */
  reactivate?: boolean;
}

export interface PromoteConjectureResult {
  misconceptionId: string;
  edgeId: string;
}

/**
 * Mint (or upsert) a misconception + its caused_by edge from an accepted conjecture. Runs
 * INSIDE the caller's accept transaction (rate event + this hop are atomic, so a crash never
 * strands a misconception-less accept that the idempotency guard then skips forever).
 *
 *   1. Upsert the misconception (deterministic id; status='active', source=input.source,
 *      seen=recurrence_count, evidence=conjecture evidence event ids). `source` is monotone
 *      (never hard→soft) and `archived_at` is preserved unless reactivate:true.
 *   2. Create the idempotent caused_by edge (misc → knowledge_id), un-archiving ONLY on the
 *      same reactivate:true signal (node and edge tombstones stay aligned).
 *
 * Serialized per misconception identity by a `misc:<id>` advisory lock.
 */
export async function promoteConjectureToMisconception(
  tx: Tx,
  input: PromoteConjectureInput,
): Promise<PromoteConjectureResult> {
  const misconceptionId = misconceptionIdForConjecture(input.causeCategory, input.knowledgeId);
  const source = input.source ?? 'soft';
  const reactivate = input.reactivate ?? false;

  // Serialize the whole promote (node upsert + caused_by edge) per misconception identity in
  // an INDEPENDENT advisory namespace `misc:<id>` (distinct from `kc_typed:` / `fsrs:` /
  // `mastery:` — no collision). xact-scoped, so two concurrent accepts of the same cause×KC
  // cannot interleave a downgrade/un-archive race between the neighbor-read and the upsert.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`misc:${misconceptionId}`}))`);

  // Normalize confidence BEFORE the Zod hop: a legacy conjecture missing `confidence` arrives
  // as NaN, which would throw and roll back the owner's whole accept.
  const weight = normalizeConfidenceWeight(input.confidence);

  // 1) Validate via the `.strict()` Zod, then UPSERT. status='active': the owner accepted the
  //    direction, so the node is live. source='soft' encodes "AI prior the owner agreed with",
  //    NOT a confirmed weakness (the read model renders source, not status, as the badge).
  const parsed = MisconceptionInsert.parse({
    id: misconceptionId,
    title: input.claimMd,
    reasoning: null,
    weight,
    status: 'active',
    source,
    seen: input.recurrenceCount,
    evidence: input.evidenceEventIds,
    created_by: { by: 'ai' },
    proposed_by_ai: true,
    created_at: input.now,
    updated_at: input.now,
    archived_at: null,
  });

  await tx
    .insert(misconception)
    .values({
      id: parsed.id,
      title: parsed.title,
      reasoning: parsed.reasoning ?? null,
      weight: parsed.weight,
      status: parsed.status,
      source: parsed.source,
      seen: parsed.seen,
      evidence: parsed.evidence,
      created_by: parsed.created_by,
      proposed_by_ai: parsed.proposed_by_ai,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      archived_at: null,
    })
    .onConflictDoUpdate({
      target: misconception.id,
      set: {
        title: parsed.title,
        reasoning: parsed.reasoning ?? null,
        weight: parsed.weight,
        status: parsed.status,
        // `source` is MONOTONE soft→hard — a confirmed 'hard' row never downgrades on a
        // plain re-accept; a soft→hard upgrade still applies.
        source: sql`CASE WHEN ${misconception.source} = 'hard' THEN 'hard' ELSE ${parsed.source} END`,
        seen: parsed.seen,
        evidence: parsed.evidence,
        updated_at: input.now,
        // `archived_at` is NOT unconditionally reset: only an explicit reactivation clears it,
        // so a retired / soft-archived node is never silently resurrected.
        ...(reactivate ? { archived_at: null } : {}),
      },
    });

  // 2) caused_by edge: misc → the KC it corrupts. Idempotent upsert through the throat;
  //    archived_at is cleared ONLY on the same reactivate signal (node/edge semantics aligned).
  const edgeId = await createMisconceptionEdge(tx, {
    from_id: misconceptionId,
    to_kind: 'knowledge',
    to_id: input.knowledgeId,
    relation_type: 'caused_by',
    weight,
    created_by: { by: 'ai' },
    proposed_by_ai: true,
    now: input.now,
    reactivate,
  });

  return { misconceptionId, edgeId };
}
