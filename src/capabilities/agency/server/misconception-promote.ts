// YUK-531 (A5 S4 / ADR-0036 RT1) — conjecture → misconception PROMOTION writer.
//
// When the owner ACCEPTS a conjecture (agrees with its direction), this dark,
// flag-gated hop mints a first-class `misconception` node + a `caused_by`
// misconception_edge (misc → the KC it corrupts). That is the only thing PR-3 wires
// into the live accept path; the reconcile ring (misconception-reconcile*.ts) is the
// pure decision/audit layer, built dark and NOT wired here.
//
// SOFT-TRACK ND-5 RED LINE: a minted misconception is `source: 'soft'` — an AI prior
// the owner agreed with, NOT a confirmed weakness. accept = "agree with the
// DIRECTION", and only the probe one-shot (a later task) mints a hard-confirmed
// weakness. The misconception / its edge feed θ̂ / p(L) / FSRS / difficulty / mastery
// NOTHING (the `.strict()` Zod on MisconceptionInsert / MisconceptionEdgeInsert
// machine-checks this — no diagnostic column can ride on the row).
//
// IMPERATIVE write (no event/fold): misconception has no fold/projection, so this is
// a direct upsert (like mastery_state / kc_typed_state), provenance lives in the row
// (evidence event-ptr array + seen + source) — NO known.ts extension, NO new event
// subject_kind.

import { createHash } from 'node:crypto';

import { createMisconceptionEdge } from '@/capabilities/knowledge/server/misconception-edges';
import { MisconceptionInsert } from '@/core/schema/misconception';
import type { Tx } from '@/db/client';
import { misconception } from '@/db/schema';

/**
 * The recurrence threshold the accept must meet to promote.
 *
 * ⚠️ At k=2 this gate is REDUNDANT with the induction floor: conjectures are only
 * induced when a cause×KC recurs across ≥ CONJECTURE_RECURRENCE_FLOOR (=2) distinct
 * failures (src/server/conjectures/evidence.ts), so every existing conjecture already
 * has recurrence_count ≥ 2 and this re-check is always true — it gates nothing. The
 * REAL gate is the flag (MISCONCEPTION_PROMOTE_ENABLED) + the human accept. This const
 * is a PLACEHOLDER for future flag-flip tuning (it only bites at k > 2); do NOT read it
 * as a live runtime gate at k=2.
 */
export const K_PROMOTE = 2;

/**
 * Dark-ship flag. Default OFF — when OFF the accept path is effect-identical to today
 * (no misconception, no edge). env-getter (read per-call) so tests can parameterize
 * OFF/ON and the three processes (API / worker / Vite) each see it via their own env;
 * mirrors the sot-flag.ts projectionIsWriter pattern (NOT the const-boolean
 * MISCONCEPTION_RECURRENCE_ENABLED, which cannot be runtime-mocked).
 */
export function misconceptionPromoteEnabled(): boolean {
  return process.env.MISCONCEPTION_PROMOTE_ENABLED === '1';
}

/**
 * Deterministic misconception id keyed on the conjecture IDENTITY (cause_category ×
 * knowledge_id), NOT the proposal id. So a later re-induction of the SAME cause×KC (a
 * fresh proposal, after the first one is no longer pending) UPSERTs the SAME
 * misconception (bump seen / refresh evidence) instead of minting a duplicate identity.
 * (Re-accept of the SAME proposal never reaches this hop — the rate-event idempotency
 * guard in conjecture-accept.ts short-circuits it.)
 */
export function misconceptionIdForConjecture(causeCategory: string, knowledgeId: string): string {
  const key = `${causeCategory}::${knowledgeId}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `misc_${hash}`;
}

export interface PromoteConjectureInput {
  /** The conjecture's stable id (= the proposal event id). */
  conjectureId: string;
  /** The KC the misconception corrupts (caused_by target). */
  knowledgeId: string;
  /** The conjecture claim — becomes the misconception title (the belief text). */
  claimMd: string;
  causeCategory: string;
  /** Internal confidence (0-1) — becomes the salience weight, never rendered as a number. */
  confidence: number;
  /** Recurrence count that drove promotion — the `seen` salience count (NOT mastery). */
  recurrenceCount: number;
  /** Provenance event-ptr array (the conjecture's evidence event ids). */
  evidenceEventIds: string[];
  /** Caller-supplied write instant (house convention — no defaultNow). */
  now: Date;
}

export interface PromoteConjectureResult {
  misconceptionId: string;
  edgeId: string;
}

/**
 * Mint (or upsert) a misconception + its caused_by edge from an accepted conjecture.
 * Runs INSIDE the caller's accept transaction (rate event + this hop are atomic, so a
 * crash never strands a misconception-less accept that the idempotency guard then
 * permanently skips).
 *
 *   1. upsert misconception (deterministic id; status='active' soft node, source='soft',
 *      seen=recurrence_count, evidence=conjecture evidence event ids),
 *   2. createMisconceptionEdge caused_by (misc → knowledge_id), idempotent / un-archive.
 */
export async function promoteConjectureToMisconception(
  tx: Tx,
  input: PromoteConjectureInput,
): Promise<PromoteConjectureResult> {
  const misconceptionId = misconceptionIdForConjecture(input.causeCategory, input.knowledgeId);

  // 1) Validate via the soft-track `.strict()` Zod, then UPSERT. status='active': the
  //    owner accepted the direction, so the node is live/shown; source='soft' encodes
  //    "AI prior the owner agreed with", NOT a confirmed weakness (the read model renders
  //    source, not status, as the hard/soft badge). On re-induction (a 2nd conjecture for
  //    the same cause×KC) the deterministic id upserts: refresh seen / evidence (latest
  //    salience snapshot wins), un-archive.
  const parsed = MisconceptionInsert.parse({
    id: misconceptionId,
    title: input.claimMd,
    reasoning: null,
    weight: input.confidence,
    status: 'active',
    source: 'soft',
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
        source: parsed.source,
        seen: parsed.seen,
        evidence: parsed.evidence,
        updated_at: input.now,
        archived_at: null,
      },
    });

  // 2) caused_by edge: misc → the KC it corrupts. Idempotent upsert (un-archive on
  //    re-promote), composes the heterogeneous topology gate inside the throat.
  const edgeId = await createMisconceptionEdge(tx, {
    from_id: misconceptionId,
    to_kind: 'knowledge',
    to_id: input.knowledgeId,
    relation_type: 'caused_by',
    weight: input.confidence,
    created_by: { by: 'ai' },
    proposed_by_ai: true,
    now: input.now,
  });

  return { misconceptionId, edgeId };
}
