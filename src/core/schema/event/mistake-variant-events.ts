import { z } from 'zod';
import { MistakeVariantRowSnapshot } from './genesis';

// ====================================================================
// mistake_variant action events — YUK-471 Wave 2 (mistake_variant fold)
// ====================================================================
//
// mistake_variant is a WEAK event-sourced entity (design §0). Its lifecycle status transitions
// (accept → active, verify fail → broken, dismiss/retract → dismissed) ARE already event-logged
// (a `rate` accept/dismiss, an `experimental:variant_verify`, a `correct` retract), so the fold
// reconstructs those from the caused_by chain. The ONE field the event chain cannot reproduce is
// `cause_category`: variant_gen computes it at INSERT time via effectiveCauseForFailureAttempt()
// and it is NOT carried by ANY downstream event (the FOLD-BLIND field, design §2 + critic A4).
//
// ── A4 CORRECTION (critic A4 — overrides design §2⑥) ─────────────────────────────────────────
// The design doc said "creation 即写 experimental:genesis" to carry cause_category. That is WRONG.
// `experimental:genesis` is BACKFILL-ONLY (a one-time seed of pre-W2 rows; actor_kind='system';
// genesis.ts header pins it as the pre-W1/W2 backfill seed). Using it on the RUNTIME creation hot
// path would write a genesis event for every newly-created variant, corrupting the invariant
// "genesis ⇒ pre-W2 row" that future audits/cascades may rely on (same病根 as Wave 3 A3).
//
// CORRECT design: runtime variant creation writes a DEDICATED `experimental:mistake_variant_create`
// event carrying the full initial MistakeVariantRowSnapshot (incl. the fold-blind cause_category +
// proposal_event_id). The reducer treats EITHER `experimental:genesis` (backfill, pre-W2 rows) OR
// `experimental:mistake_variant_create` (runtime, post-W2 rows) as the row's BASE/init event —
// both carry the complete initial snapshot. genesis stays purely a backfill writer; the create
// event is the runtime-creation writer. This keeps cause_category fold-reproducible WITHOUT abusing
// genesis semantics.
//
// Reserved experimental action (RESERVED_EXPERIMENTAL_ACTIONS in ./experimental.ts): a malformed
// create payload is rejected at the parseEvent barrier (the fold trusts this base event as ground
// truth for cause_category — a loose generic fallback could silently corrupt the projection).
//
// Dedicated FILE (not known.ts) to minimise merge conflict with the in-flight retract lane (PR
// #592) touching known.ts, mirroring goal-events.ts.

// ── experimental:mistake_variant_create ──────────────────────────────────────────────────────
//
// The runtime creation BASE event for a mistake_variant row (written same-tx as the variant_gen
// INSERT). payload.row is the FULL initial MistakeVariantRowSnapshot — id / parent_question_id /
// proposal_event_id / status='draft' / failure_reasons=[] / the fold-blind cause_category /
// timestamps. subject_kind='mistake_variant', subject_id = the row id (== mv.id, createId()
// pre-generated). The reducer seeds the row from payload.row VERBATIM (same as it seeds from a
// genesis), then applies the caused_by chain (accept / verify / dismiss / retract).
//
// `.strict()` on the envelope is NOT applied (it carries the standard optional base fields); the
// .strict() that matters is on MistakeVariantRowSnapshot (genesis.ts) so a wrong/sibling row shape
// is rejected. subject_id === payload.row.id is enforced by the superRefine below (mirrors genesis).
export const MistakeVariantCreateExperimental = z
  .object({
    actor_kind: z.enum(['user', 'agent', 'system']),
    actor_ref: z.string().min(1),
    action: z.literal('experimental:mistake_variant_create'),
    subject_kind: z.literal('mistake_variant'),
    subject_id: z.string().min(1), // = mistake_variant.id (== payload.row.id)
    outcome: z.literal('success').nullable().optional(),
    payload: z.object({
      // FULL initial snapshot (incl. the fold-blind cause_category + proposal_event_id). The
      // reducer reads it VERBATIM as the row's base state — same shape genesis carries.
      row: MistakeVariantRowSnapshot,
    }),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // subject_id must name the same row the snapshot reproduces (mirrors GenesisExperimental's
    // subject_id === row.id coherence check, so a create base seeds the row by its OWN id).
    if (data.subject_id !== data.payload.row.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'subject_id must equal payload.row.id (the create base seeds the row by its own id)',
        path: ['subject_id'],
      });
    }
  });
export type MistakeVariantCreateExperimentalT = z.infer<typeof MistakeVariantCreateExperimental>;
