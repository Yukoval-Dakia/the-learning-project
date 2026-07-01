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

import { sql } from 'drizzle-orm';

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
 * Neutral fallback salience weight used when an accepted conjecture carries no usable
 * `confidence` (a legacy / hand-crafted proposal predating the confidence field, or one
 * whose value coerces to NaN). 0.5 = "we agree with the DIRECTION but have no calibrated
 * salience", so we mint at mid-confidence rather than letting the weight Zod throw.
 *
 * WHY this guard exists: `MisconceptionInsert.weight` is `z.number()` (rejects NaN) and the
 * misconception_edge weight is `z.number().min(0).max(1)`. A flag-ON accept of a conjecture
 * with a missing/NaN confidence would otherwise throw a ZodError that rolls back the owner's
 * WHOLE accept transaction → a 500. Fail-loud is wrong here (flag-ON, owner-initiated): clamp
 * to the valid band with this default instead. Flag-OFF is unaffected (the hop never runs).
 */
export const DEFAULT_MISCONCEPTION_WEIGHT = 0.5;

/**
 * Normalize a raw confidence into the [0,1] salience band the soft-track Zod requires:
 * finite values are clamped, NaN / ±Infinity fall back to DEFAULT_MISCONCEPTION_WEIGHT.
 * Both the misconception node weight and its caused_by edge weight consume the result, so
 * neither can ever feed a NaN/out-of-range value into the `.strict()` parse barrier.
 */
function normalizeConfidenceWeight(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_MISCONCEPTION_WEIGHT;
  return Math.max(0, Math.min(1, raw));
}

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
 * Dark-ship flag for the HARD-confirm track (source: 'soft'→'hard' upgrade). Default OFF,
 * mirrors misconceptionPromoteEnabled (read per-call so each of the three processes sees it
 * via its own env). When OFF, decideDissociation (hard-confirm.ts) is STRUCTURALLY unable to
 * return HARD_CONFIRM, so no evidence-driven hard upgrade can ever fire. This flag only makes
 * the hard track REACHABLE; a soft→hard flip additionally forces a FRESH owner confirmation at
 * the call site — it is never automatic. Nothing wires this into the live accept path yet
 * (Tier 1 ships the track dark, per design 2026-07-01-misconception-promote-mechanism.md §2).
 */
export function misconceptionHardConfirmEnabled(): boolean {
  return process.env.MISCONCEPTION_HARD_CONFIRM_ENABLED === '1';
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
  /**
   * Which track this promotion writes. 'soft' (default) = an AI prior the owner agreed with —
   * the ONLY value the live accept path passes. 'hard' = an evidence-confirmed weakness,
   * reachable only when the caller holds a decideDissociation()==='HARD_CONFIRM' verdict AND a
   * fresh owner confirmation (hard-confirm.ts, dark). The F1 conflict guard makes 'soft' NEVER
   * downgrade an existing 'hard' row.
   */
  source?: 'hard' | 'soft';
  /**
   * Explicit reactivation signal (default false). ONLY a true value clears `archived_at` on an
   * UPSERT conflict. F1 fix: a plain soft re-accept must NOT silently un-archive a node the
   * retire/reconcile ring soft-archived. Reactivation is immediate + un-gated (design §Tier1-8).
   */
  reactivate?: boolean;
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
 *   1. upsert misconception (deterministic id; status='active', source=input.source (default
 *      'soft'), seen=recurrence_count, evidence=conjecture evidence event ids). The F1 conflict
 *      guard keeps `source` monotone (never hard→soft) and preserves `archived_at` unless the
 *      caller passes reactivate:true.
 *   2. createMisconceptionEdge caused_by (misc → knowledge_id), idempotent / un-archive.
 *
 * The whole hop is serialized per misconception identity by a `misc:<id>` advisory lock (F1).
 */
export async function promoteConjectureToMisconception(
  tx: Tx,
  input: PromoteConjectureInput,
): Promise<PromoteConjectureResult> {
  const misconceptionId = misconceptionIdForConjecture(input.causeCategory, input.knowledgeId);
  const source = input.source ?? 'soft';
  const reactivate = input.reactivate ?? false;

  // F1 fix ②: serialize the WHOLE promote (node upsert + caused_by edge below) per misconception
  // identity in an INDEPENDENT advisory namespace `misc:<id>` (distinct hashtext keyspace from
  // upsertKcTypedState's `kc_typed:` and mastery_state's `fsrs:`/`mastery:` locks — no
  // collision), mirroring upsertKcTypedState. The lock is xact-scoped (released at the caller's
  // tx commit), so two concurrent accepts of the same cause×KC cannot interleave a
  // downgrade/un-archive race between the neighbor-read and the upsert.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`misc:${misconceptionId}`}))`);

  // Normalize confidence into the [0,1] salience band BEFORE the Zod hop. A legacy /
  // hand-crafted conjecture missing `confidence` arrives here as NaN (Number(undefined));
  // feeding that straight into the weight Zod throws and rolls back the owner's whole
  // accept (a 500). Clamp-with-default keeps the soft-track weight valid on a flag-ON accept.
  const weight = normalizeConfidenceWeight(input.confidence);

  // 1) Validate via the soft-track `.strict()` Zod, then UPSERT. status='active': the
  //    owner accepted the direction, so the node is live/shown; source='soft' encodes
  //    "AI prior the owner agreed with", NOT a confirmed weakness (the read model renders
  //    source, not status, as the hard/soft badge). On re-induction (a 2nd conjecture for
  //    the same cause×KC) the deterministic id upserts: refresh seen / evidence (latest
  //    salience snapshot wins); archived_at is PRESERVED unless the caller passes
  //    reactivate:true (F1 — a plain re-accept must NOT silently un-archive a retired /
  //    soft-archived node).
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
        // F1 fix ①a: `source` is MONOTONE soft→hard — NEVER downgrade a confirmed 'hard' row
        // back to 'soft'. A plain soft re-accept of a cause×KC already hard-confirmed keeps
        // 'hard'; an explicit source:'hard' upgrade of a soft row wins. Without this, once the
        // two tracks coexist a soft re-accept silently demoted a hard node (design §3, F1).
        source: sql`CASE WHEN ${misconception.source} = 'hard' THEN 'hard' ELSE ${parsed.source} END`,
        seen: parsed.seen,
        evidence: parsed.evidence,
        updated_at: input.now,
        // F1 fix ①b: `archived_at` is NOT unconditionally reset. ONLY an explicit reactivation
        // clears it; a plain re-accept preserves the current archive state, so a retired /
        // soft-archived node is never silently resurrected (design §3, F1).
        ...(reactivate ? { archived_at: null } : {}),
      },
    });

  // 2) caused_by edge: misc → the KC it corrupts. Idempotent upsert (un-archive on
  //    re-promote), composes the heterogeneous topology gate inside the throat.
  const edgeId = await createMisconceptionEdge(tx, {
    from_id: misconceptionId,
    to_kind: 'knowledge',
    to_id: input.knowledgeId,
    relation_type: 'caused_by',
    weight,
    created_by: { by: 'ai' },
    proposed_by_ai: true,
    now: input.now,
  });

  return { misconceptionId, edgeId };
}
