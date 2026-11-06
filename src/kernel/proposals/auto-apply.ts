// Proposal auto-apply lane: the single generic executor behind strength A.
//
// Flow per proposal: the producer still writes the normal `propose` event first
// (writer stamps `payload.auto_apply` from the kind strength *at creation time*,
// which is also the non-retroactive switch: rows written before the tier flip
// carry no marker and stay pending). A scheduled sweep later accepts eligible
// rows through the same decision protocol as the inbox, with the proposing
// agent's real identity as the rate actor, then writes one generic anchor
// (`experimental:auto_apply`) that the digest read model consumes. Retraction
// stays the existing correct/retract lane; this module never undoes anything.
//
// Safety: the verdict-rate breaker is checked before every sweep and again per
// apply against its max; rows the lane cannot apply are marked
// `experimental:auto_apply_skipped` so they fall back to human review instead of
// silently disappearing. Kernel-owned so capability jobs can call it without a
// capability -> server dependency; the accept dispatcher is installed as a port
// at worker boot.

import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';

import {
  type AiProposalPayloadT,
  kindStrength,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatus, writeEvent } from '@/kernel/events';
import { findExistingRateEvent } from './applier-helpers';
import {
  type VerdictBreakerResult,
  checkAutoApplyBreaker,
  checkVerdictRateBreaker,
} from './auto-apply-breaker';
import { AUTO_APPLY_POLICY } from './auto-apply-marker';
import { proposalDisplayTitle } from './presentation';
import { proposalReasonPlainText } from './reason-text';

/** Successful auto-apply anchor (generic; the completion-era anchor stays readable). */
export const PROPOSAL_AUTOAPPLY_ACTION = 'experimental:auto_apply';
/** Returned-to-human anchor (breaker or apply failure); excludes the row from later sweeps. */
export const PROPOSAL_AUTOAPPLY_SKIPPED_ACTION = 'experimental:auto_apply_skipped';

/** Lookback for missed rows; older eligible rows fall back to human review. */
const AUTO_APPLY_LOOKBACK_MS = 7 * 24 * 3_600_000;
const AUTO_APPLY_SWEEP_LIMIT = 25;
/** Proposal-event actions that can carry an eligibility marker for strength A. */
const PROPOSAL_EVENT_ACTIONS = [
  'propose',
  'experimental:proposal',
  'experimental:propose_learning_intent',
] as const;

export interface ProposalAutoApplyAcceptInput {
  readonly proposalId: string;
  /** The proposing agent's recorded identity; never a fabricated user decision. */
  readonly actor: { readonly kind: 'agent'; readonly ref: string };
}

export type ProposalAutoApplyAcceptPort = (
  db: Db,
  input: ProposalAutoApplyAcceptInput,
) => Promise<void>;

let acceptPort: ProposalAutoApplyAcceptPort | null = null;

/** Installed once at worker boot with the canonical accept dispatcher. */
export function installProposalAutoApplyAcceptPort(port: ProposalAutoApplyAcceptPort): void {
  acceptPort = port;
}

export interface AutoApplySweepOptions {
  now?: Date;
  limit?: number;
  lookbackMs?: number;
}

export interface AutoApplySweepResult {
  readonly outcome: 'idle' | 'applied' | 'skipped' | 'unavailable';
  readonly applied: number;
  readonly skipped: number;
  readonly breaker: VerdictBreakerResult;
}

interface CandidateRow {
  readonly id: string;
  readonly actorKind: string;
  readonly actorRef: string;
  readonly payload: unknown;
}

function proposalFromPayload(payload: unknown): AiProposalPayloadT | null {
  const raw = (payload as { ai_proposal?: unknown } | null)?.ai_proposal;
  if (raw === undefined) return null;
  try {
    return parseAiProposalPayload(raw);
  } catch {
    return null;
  }
}

export function proposalAutoApplyAnchorId(proposalId: string): string {
  return `autoapply_${proposalId}`;
}

export function proposalAutoApplySkippedAnchorId(proposalId: string): string {
  return `autoapply_skip_${proposalId}`;
}

interface AnchorInput {
  readonly proposalId: string;
  readonly payload: AiProposalPayloadT;
  readonly actorRef: string;
  readonly breaker: VerdictBreakerResult;
  readonly kind: AiProposalPayloadT['kind'];
  /** Window count including this apply (breaker.applied + this sweep's applied). */
  readonly appliedCount: number;
}

async function writeAppliedAnchor(db: Db, input: AnchorInput): Promise<void> {
  const now = new Date();
  const summary = proposalReasonPlainText(input.payload.learner_summary ?? input.payload.reason_md);
  const level = checkVerdictRateBreaker({ recentCount: input.appliedCount }).status;
  await writeEvent(db, {
    id: proposalAutoApplyAnchorId(input.proposalId),
    actor_kind: 'agent',
    actor_ref: input.actorRef,
    action: PROPOSAL_AUTOAPPLY_ACTION,
    subject_kind: input.payload.target.subject_kind,
    subject_id: input.payload.target.subject_id ?? input.proposalId,
    outcome: 'success',
    payload: {
      proposal_id: input.proposalId,
      kind: input.kind,
      title: proposalDisplayTitle(input.payload),
      summary,
      level,
      applied: input.appliedCount,
      cap: input.breaker.cap,
      window: input.breaker.window,
      policy: AUTO_APPLY_POLICY,
    },
    caused_by_event_id: input.proposalId,
    // Internal status trail, not memory-worthy activity (mirrors the completion-era anchor).
    ingest_at: now,
    created_at: now,
  });
}

async function writeSkippedAnchor(
  db: Db,
  proposalId: string,
  reason: 'breaker_tripped' | 'apply_error',
  breaker: VerdictBreakerResult,
  errorMessage?: string,
): Promise<void> {
  const now = new Date();
  await writeEvent(db, {
    id: proposalAutoApplySkippedAnchorId(proposalId),
    actor_kind: 'system',
    actor_ref: 'proposal_auto_apply',
    action: PROPOSAL_AUTOAPPLY_SKIPPED_ACTION,
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: reason === 'apply_error' ? 'failure' : 'partial',
    payload: {
      proposal_id: proposalId,
      reason,
      level: breaker.level,
      applied: breaker.applied,
      cap: breaker.cap,
      window: breaker.window,
      policy: AUTO_APPLY_POLICY,
      ...(errorMessage ? { error: errorMessage.slice(0, 300) } : {}),
    },
    caused_by_event_id: proposalId,
    ingest_at: now,
    created_at: now,
  });
}

async function loadCandidates(db: Db, now: Date, limit: number, lookbackMs: number) {
  const lookbackStart = new Date(now.getTime() - lookbackMs);
  const rows = await db
    .select({
      id: event.id,
      actorKind: event.actor_kind,
      actorRef: event.actor_ref,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        inArray(event.action, [...PROPOSAL_EVENT_ACTIONS]),
        sql`${event.payload} -> 'auto_apply' ->> 'eligible' = 'true'`,
        gte(event.created_at, lookbackStart),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id))
    .limit(limit);

  if (rows.length === 0) return [] as CandidateRow[];
  const skipped = await db
    .select({ proposalId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.action, PROPOSAL_AUTOAPPLY_SKIPPED_ACTION),
        eq(event.subject_kind, 'event'),
        inArray(
          event.subject_id,
          rows.map((row) => row.id),
        ),
      ),
    );
  const skippedIds = new Set(skipped.map((row) => row.proposalId));
  return rows.filter((row) => !skippedIds.has(row.id)) as CandidateRow[];
}

/**
 * One bounded sweep: accept every eligible pending proposal until the breaker
 * budget or the batch limit is reached. Never throws for a single domain
 * failure; failures become skipped anchors and the proposal stays pending.
 */
export async function runProposalAutoApplySweep(
  db: Db,
  options: AutoApplySweepOptions = {},
): Promise<AutoApplySweepResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? AUTO_APPLY_SWEEP_LIMIT;
  const lookbackMs = options.lookbackMs ?? AUTO_APPLY_LOOKBACK_MS;
  const breaker = await checkAutoApplyBreaker(db, now);

  if (acceptPort === null) {
    return { outcome: 'unavailable', applied: 0, skipped: 0, breaker };
  }

  const candidates = await loadCandidates(db, now, limit, lookbackMs);
  if (candidates.length === 0) {
    return { outcome: 'idle', applied: 0, skipped: 0, breaker };
  }

  let applied = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.actorKind !== 'agent') continue;
    const payload = proposalFromPayload(candidate.payload);
    if (!payload || kindStrength(payload.kind) !== 'A') continue;
    if (await findExistingRateEvent(db, candidate.id)) continue;
    if ((await getCorrectionStatus(db, candidate.id)).state !== 'active') continue;

    // Hard cap: the breaker window includes every rate event, so the budget is
    // shared across the whole ledger. Past max, the rest go to human review.
    if (breaker.applied + applied >= breaker.cap) {
      await writeSkippedAnchor(db, candidate.id, 'breaker_tripped', breaker).catch((err) => {
        console.warn('[proposal-auto-apply] skip anchor write failed', {
          proposal_id: candidate.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      skipped += 1;
      continue;
    }

    try {
      await acceptPort(db, {
        proposalId: candidate.id,
        actor: { kind: 'agent', ref: candidate.actorRef },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[proposal-auto-apply] accept failed; proposal stays pending', {
        proposal_id: candidate.id,
        kind: payload.kind,
        error: message,
      });
      await writeSkippedAnchor(db, candidate.id, 'apply_error', breaker, message).catch(
        (anchorErr) => {
          console.warn('[proposal-auto-apply] failure anchor write failed', {
            proposal_id: candidate.id,
            error: anchorErr instanceof Error ? anchorErr.message : String(anchorErr),
          });
        },
      );
      skipped += 1;
      continue;
    }

    applied += 1;
    // Honesty gate: a racing human decision can win the same proposal. Only the
    // rate event recorded with this agent identity means the lane actually applied
    // it; never write an auto-apply card for a user decision.
    const recorded = await findExistingRateEvent(db, candidate.id);
    if (!recorded) {
      applied -= 1;
      continue;
    }
    if (recorded.actor_kind !== 'agent' || recorded.actor_ref !== candidate.actorRef) {
      applied -= 1;
      continue;
    }
    // The apply already committed; a telemetry anchor failure must not turn it
    // into a reported failure (the rate/proposal rows remain the source of truth).
    await writeAppliedAnchor(db, {
      proposalId: candidate.id,
      payload,
      actorRef: candidate.actorRef,
      breaker,
      kind: payload.kind,
      appliedCount: breaker.applied + applied,
    }).catch((err) => {
      console.warn('[proposal-auto-apply] applied anchor write failed', {
        proposal_id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (applied === 0 && skipped === 0) {
    return { outcome: 'idle', applied, skipped, breaker };
  }
  return { outcome: applied > 0 ? 'applied' : 'skipped', applied, skipped, breaker };
}
