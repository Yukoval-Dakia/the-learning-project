// Proposal auto-apply lane: the single generic executor behind strength A.
//
// Flow per proposal: the producer still writes the normal `propose` event first
// (writer stamps `payload.auto_apply` from the kind strength *at creation time*
// only while the PROPOSAL_AUTO_APPLY_ENABLED master switch is on; both the tier
// and the switch are non-retroactive, so rows written before either turned on
// carry no marker and stay pending). A scheduled sweep later accepts eligible
// rows through the same decision protocol as the inbox, with the proposing
// agent's real identity as the rate actor, then writes one generic anchor
// (`experimental:auto_apply`) that the digest read model consumes. Retraction
// stays the existing correct/retract lane; this module never undoes anything.
//
// Master switch off: the sweep returns before reading the breaker, accepting,
// writing skip anchors or backfilling anchors. The pg-boss job stays registered,
// so the switch takes effect through the normal 15s config refresh (no restart).
//
// Safety: the verdict-rate breaker is checked before every sweep and again per
// apply against its max; rows the lane cannot apply are marked
// `experimental:auto_apply_skipped` so they fall back to human review instead of
// silently disappearing. Kernel-owned so capability jobs can call it without a
// capability -> server dependency; the accept dispatcher is installed as a port
// at worker boot.
//
// Starvation control: the candidate query excludes decided / corrected / already
// skipped rows in SQL *before* the page limit, and every in-loop refusal writes a
// skipped anchor. Without both, 25 permanently-ineligible rows would occupy every
// page and the 26th eligible proposal would never be reached.
//
// Anchor durability: the accept commits before this lane can write the card
// anchor. A missing anchor is not a lost decision — the next sweep backfills it
// from the agent rate event, so the card and its undo entry always reappear.

import { and, asc, gte, inArray, sql } from 'drizzle-orm';

import {
  type AiProposalPayloadT,
  kindStrength,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';
import { findExistingRateEvent } from './applier-helpers';
import {
  type VerdictBreakerResult,
  checkAutoApplyBreaker,
  checkVerdictRateBreaker,
} from './auto-apply-breaker';
import { AUTO_APPLY_POLICY, proposalAutoApplyEnabled } from './auto-apply-marker';
import { proposalDisplayTitle } from './presentation';
import { proposalReasonPlainText } from './reason-text';

/** Successful auto-apply anchor (generic; the completion-era anchor stays readable). */
export const PROPOSAL_AUTOAPPLY_ACTION = 'experimental:auto_apply';
/** Returned-to-human anchor (breaker / refusal / apply failure); excludes later sweeps. */
export const PROPOSAL_AUTOAPPLY_SKIPPED_ACTION = 'experimental:auto_apply_skipped';

/** Lookback for missed rows; older eligible rows fall back to human review. */
const AUTO_APPLY_LOOKBACK_MS = 7 * 24 * 3_600_000;
const AUTO_APPLY_SWEEP_LIMIT = 25;
/** Proposal-event actions that carry an eligibility marker for strength A. */
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

const ACCEPT_PORT_SLOT = 'kernel/proposals/auto-apply:accept';

/** Installed once at worker boot with the canonical accept dispatcher. */
export function installProposalAutoApplyAcceptPort(port: ProposalAutoApplyAcceptPort): void {
  installHostOperation(ACCEPT_PORT_SLOT, port);
}

function requireAcceptPort(): ProposalAutoApplyAcceptPort {
  const port = installedHostOperation<ProposalAutoApplyAcceptPort>(ACCEPT_PORT_SLOT);
  if (!port) {
    throw new HostOperationNotInstalledError(
      'proposal auto-apply accept port is not installed; call installProposalAutoApplyAcceptPort at worker startup',
    );
  }
  return port;
}

export interface AutoApplySweepOptions {
  now?: Date;
  limit?: number;
  lookbackMs?: number;
}

export interface AutoApplySweepResult {
  readonly outcome: 'idle' | 'applied' | 'skipped' | 'disabled';
  readonly applied: number;
  readonly skipped: number;
  /** Cards whose accept committed earlier but whose anchor was missing. */
  readonly backfilled: number;
  /** null when the lane switch is off: nothing was read, applied or skipped. */
  readonly breaker: VerdictBreakerResult | null;
}

type SkipReason = 'breaker_tripped' | 'apply_error' | 'ineligible';
type IneligibleDetail =
  | 'actor_not_agent'
  | 'payload_unparseable'
  | 'kind_not_auto'
  | 'decision_skipped';

interface CandidateRow {
  readonly id: string;
  readonly actorKind: string;
  readonly actorRef: string;
  readonly payload: unknown;
}

interface MissingAnchorRow extends CandidateRow {
  readonly rateActorRef: string | null;
  readonly rateCreatedAt: Date | string | null;
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
  /** Backfilled anchors reuse the original decision time; fresh applies use now. */
  readonly appliedAt?: Date;
}

async function writeAppliedAnchor(db: Db, input: AnchorInput): Promise<void> {
  const at = input.appliedAt ?? new Date();
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
    ingest_at: at,
    created_at: at,
  });
}

async function writeSkippedAnchor(
  db: Db,
  proposalId: string,
  reason: SkipReason,
  breaker: VerdictBreakerResult,
  opts: { errorMessage?: string; detail?: IneligibleDetail } = {},
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
      ...(opts.detail ? { detail: opts.detail } : {}),
      level: breaker.level,
      applied: breaker.applied,
      cap: breaker.cap,
      window: breaker.window,
      policy: AUTO_APPLY_POLICY,
      ...(opts.errorMessage ? { error: opts.errorMessage.slice(0, 300) } : {}),
    },
    caused_by_event_id: proposalId,
    ingest_at: now,
    created_at: now,
  });
}

async function writeSkippedAnchorSafe(
  db: Db,
  proposalId: string,
  reason: SkipReason,
  breaker: VerdictBreakerResult,
  opts: { errorMessage?: string; detail?: IneligibleDetail } = {},
): Promise<void> {
  await writeSkippedAnchor(db, proposalId, reason, breaker, opts).catch((err) => {
    console.warn('[proposal-auto-apply] skip anchor write failed', {
      proposal_id: proposalId,
      reason,
      detail: opts.detail,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Pending strength-A proposals with no terminal trace yet. Rate, correction and
 * skipped-anchor exclusions run in SQL before LIMIT, so one page of ineligible
 * rows can never crowd out later eligible ones.
 */
async function loadCandidates(db: Db, now: Date, limit: number, lookbackMs: number) {
  const lookbackStart = new Date(now.getTime() - lookbackMs);
  return (await db
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
        sql`not exists (select 1 from event rate_row where rate_row.action = 'rate' and rate_row.caused_by_event_id = "event"."id")`,
        sql`not exists (select 1 from event correction_row where correction_row.action = 'correct' and correction_row.subject_kind = 'event' and correction_row.subject_id = "event"."id")`,
        sql`not exists (select 1 from event skip_row where skip_row.action = ${PROPOSAL_AUTOAPPLY_SKIPPED_ACTION} and skip_row.subject_kind = 'event' and skip_row.subject_id = "event"."id")`,
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id))
    .limit(limit)) as CandidateRow[];
}

/**
 * Agent rates whose card anchor never landed (accept committed, anchor write
 * failed, process died, ...). Backfilling keeps the card and its undo entry
 * visible; without it the proposal would be decided but invisible.
 */
async function loadMissingAnchors(db: Db, now: Date, limit: number, lookbackMs: number) {
  const lookbackStart = new Date(now.getTime() - lookbackMs);
  return (await db
    .select({
      id: event.id,
      actorKind: event.actor_kind,
      actorRef: event.actor_ref,
      payload: event.payload,
      rateActorRef: sql<
        string | null
      >`(select rate_row.actor_ref from event rate_row where rate_row.action = 'rate' and rate_row.actor_kind = 'agent' and rate_row.payload ->> 'rating' = 'accept' and rate_row.caused_by_event_id = "event"."id" order by rate_row.created_at desc, rate_row.id desc limit 1)`,
      rateCreatedAt: sql<Date | null>`(select rate_row.created_at from event rate_row where rate_row.action = 'rate' and rate_row.actor_kind = 'agent' and rate_row.payload ->> 'rating' = 'accept' and rate_row.caused_by_event_id = "event"."id" order by rate_row.created_at desc, rate_row.id desc limit 1)`,
    })
    .from(event)
    .where(
      and(
        inArray(event.action, [...PROPOSAL_EVENT_ACTIONS]),
        sql`${event.payload} -> 'auto_apply' ->> 'eligible' = 'true'`,
        gte(event.created_at, lookbackStart),
        sql`exists (select 1 from event rate_row where rate_row.action = 'rate' and rate_row.actor_kind = 'agent' and rate_row.payload ->> 'rating' = 'accept' and rate_row.caused_by_event_id = "event"."id")`,
        sql`not exists (select 1 from event anchor_row where anchor_row.action = ${PROPOSAL_AUTOAPPLY_ACTION} and anchor_row.caused_by_event_id = "event"."id")`,
        sql`not exists (select 1 from event skip_row where skip_row.action = ${PROPOSAL_AUTOAPPLY_SKIPPED_ACTION} and skip_row.subject_kind = 'event' and skip_row.subject_id = "event"."id")`,
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id))
    .limit(limit)) as MissingAnchorRow[];
}

async function backfillMissingAnchors(
  db: Db,
  now: Date,
  limit: number,
  lookbackMs: number,
  breaker: VerdictBreakerResult,
): Promise<number> {
  const rows = await loadMissingAnchors(db, now, limit, lookbackMs);
  let written = 0;
  for (const row of rows) {
    // A switch flip during the read must stop the remaining writes; backfilled
    // anchors are the lane's own output and the next enabled sweep would redo them.
    if (!proposalAutoApplyEnabled()) break;
    const payload = proposalFromPayload(row.payload);
    if (!payload) {
      await writeSkippedAnchorSafe(db, row.id, 'ineligible', breaker, {
        detail: 'payload_unparseable',
      });
      continue;
    }
    const rateActorRef = row.rateActorRef?.trim() ?? '';
    const rateCreatedAt = row.rateCreatedAt;
    const appliedAt =
      rateCreatedAt instanceof Date
        ? rateCreatedAt
        : rateCreatedAt
          ? new Date(rateCreatedAt)
          : null;
    if (rateActorRef.length === 0 || !appliedAt || Number.isNaN(appliedAt.getTime())) continue;
    try {
      await writeAppliedAnchor(db, {
        proposalId: row.id,
        payload,
        actorRef: rateActorRef,
        breaker,
        kind: payload.kind,
        appliedCount: breaker.applied,
        // The card's applied_at is the anchor's created_at. Backfill at the
        // original decision time so an expired undo window stays expired instead
        // of reopening an old proposal over newer learner edits.
        appliedAt,
      });
      written += 1;
    } catch (err) {
      // The rate row stays the source of truth; the next sweep retries.
      console.warn('[proposal-auto-apply] anchor backfill failed', {
        proposal_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return written;
}

/**
 * One bounded sweep: backfill missing cards, then accept every eligible pending
 * proposal until the breaker budget or the batch limit is reached. Never throws
 * for a single domain failure; failures and refusals become skipped anchors and
 * the proposal stays pending for human review.
 */
export async function runProposalAutoApplySweep(
  db: Db,
  options: AutoApplySweepOptions = {},
): Promise<AutoApplySweepResult> {
  // Off is zero work: no accepts, no skip anchors, no anchor backfill. The job
  // stays registered, so flipping the switch is hot (config refresh, no restart).
  if (!proposalAutoApplyEnabled()) {
    return { outcome: 'disabled', applied: 0, skipped: 0, backfilled: 0, breaker: null };
  }
  const now = options.now ?? new Date();
  const limit = options.limit ?? AUTO_APPLY_SWEEP_LIMIT;
  const lookbackMs = options.lookbackMs ?? AUTO_APPLY_LOOKBACK_MS;
  // Fail fast on a wiring defect: an uninstalled port is a host bug, not a
  // reason to silently skip the lane (host-operation contract).
  const accept = requireAcceptPort();
  const breaker = await checkAutoApplyBreaker(db, now);

  const backfilled = await backfillMissingAnchors(db, now, limit, lookbackMs, breaker);
  const candidates = await loadCandidates(db, now, limit, lookbackMs);
  if (candidates.length === 0) {
    return {
      outcome: backfilled > 0 ? 'applied' : 'idle',
      applied: 0,
      skipped: 0,
      backfilled,
      breaker,
    };
  }

  let applied = 0;
  let skipped = 0;
  let stoppedBySwitch = false;
  for (const candidate of candidates) {
    // Re-read before every item. The entry check only covers the wait for the
    // breaker/backfill/candidate queries; a switch flipped mid-sweep must not
    // accept or write skip anchors (a skip would permanently return the row to
    // human review). An accept already dispatched cannot be recalled.
    if (!proposalAutoApplyEnabled()) {
      stoppedBySwitch = true;
      break;
    }
    if (candidate.actorKind !== 'agent') {
      await writeSkippedAnchorSafe(db, candidate.id, 'ineligible', breaker, {
        detail: 'actor_not_agent',
      });
      skipped += 1;
      continue;
    }
    const payload = proposalFromPayload(candidate.payload);
    if (!payload) {
      await writeSkippedAnchorSafe(db, candidate.id, 'ineligible', breaker, {
        detail: 'payload_unparseable',
      });
      skipped += 1;
      continue;
    }
    if (kindStrength(payload.kind) !== 'A') {
      await writeSkippedAnchorSafe(db, candidate.id, 'ineligible', breaker, {
        detail: 'kind_not_auto',
      });
      skipped += 1;
      continue;
    }

    // Hard cap: the breaker window includes every rate event, so the budget is
    // shared across the whole ledger. Past max, the rest go to human review.
    if (breaker.applied + applied >= breaker.cap) {
      await writeSkippedAnchorSafe(db, candidate.id, 'breaker_tripped', breaker);
      skipped += 1;
      continue;
    }

    // Second read after the possibly slow ineligible/breaker branches and right
    // before the decision write, so a mid-loop flip stops before any accept.
    if (!proposalAutoApplyEnabled()) {
      stoppedBySwitch = true;
      break;
    }
    let acceptError: unknown = null;
    try {
      await accept(db, {
        proposalId: candidate.id,
        actor: { kind: 'agent', ref: candidate.actorRef },
      });
    } catch (err) {
      acceptError = err;
    }

    // A thrown accept may still have committed: some appliers enqueue follow-up
    // work after the decision transaction. Read the decision before writing any
    // permanent skip, so an applied proposal never loses its card and undo entry.
    let recorded: Awaited<ReturnType<typeof findExistingRateEvent>> | null = null;
    try {
      recorded = await findExistingRateEvent(db, candidate.id);
    } catch (err) {
      // Cannot tell whether the accept committed; leave it untouched for the next
      // sweep instead of writing a permanent skip.
      console.warn('[proposal-auto-apply] decision read failed; leaving proposal for next sweep', {
        proposal_id: candidate.id,
        kind: payload.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const ownAccept =
      recorded !== null &&
      recorded.decision === 'accept' &&
      recorded.actor_kind === 'agent' &&
      recorded.actor_ref === candidate.actorRef;
    const acceptErrorMessage =
      acceptError === null
        ? null
        : acceptError instanceof Error
          ? acceptError.message
          : String(acceptError);

    if (acceptErrorMessage !== null) {
      if (ownAccept) {
        // The decision committed; this lane only lost the follow-up call. Keep the
        // same applied path as a successful accept (anchor backfill covers a write
        // failure) instead of hiding it behind a permanent skip.
        console.warn('[proposal-auto-apply] accept threw after commit; keeping applied card', {
          proposal_id: candidate.id,
          kind: payload.kind,
          error: acceptErrorMessage,
        });
      } else if (recorded !== null) {
        // Decided by someone else while this call raced; no skip and no card.
        continue;
      } else {
        console.warn('[proposal-auto-apply] accept failed before commit; proposal stays pending', {
          proposal_id: candidate.id,
          kind: payload.kind,
          error: acceptErrorMessage,
        });
        await writeSkippedAnchorSafe(db, candidate.id, 'apply_error', breaker, {
          errorMessage: acceptErrorMessage,
        });
        skipped += 1;
        continue;
      }
    } else {
      if (recorded === null) {
        // Accept returned without a rate (SkippedProposalDecision / stale skip).
        // Mark it returned-to-human so it cannot occupy the page forever.
        await writeSkippedAnchorSafe(db, candidate.id, 'ineligible', breaker, {
          detail: 'decision_skipped',
        });
        skipped += 1;
        continue;
      }
      if (!ownAccept) {
        // Decided by someone else (human, or another agent identity): no card from
        // this lane and no skip anchor on a decision that already happened.
        continue;
      }
    }

    applied += 1;
    // The apply already committed; a telemetry anchor failure must not turn it
    // into a reported failure. The next sweep backfills it (see above).
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

  if (applied === 0 && skipped === 0 && backfilled === 0) {
    return {
      outcome: stoppedBySwitch ? 'disabled' : 'idle',
      applied,
      skipped,
      backfilled,
      breaker,
    };
  }
  return {
    outcome: applied > 0 || backfilled > 0 ? 'applied' : 'skipped',
    applied,
    skipped,
    backfilled,
    breaker,
  };
}
