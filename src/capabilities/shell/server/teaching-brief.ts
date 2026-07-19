// YUK-706 (P0F/2) — one read-only TeachingBrief projected from the existing
// conjecture proposal → mind-probe question → probe-result event chain.

import type { CauseCategoryT } from '@/core/schema/cause';
import {
  BRIEF_ACK_ACTION,
  PROBE_QUESTION_SOURCE,
  PROBE_RESULT_ACTION,
} from '@/core/schema/conjecture';
import { AiProposalPayload, type ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { event, question } from '@/db/schema';
import { getCorrectionStatuses } from '@/server/events/corrections';
import { type ProposalInboxRow, getProposalInboxRow } from '@/server/proposals/inbox';
import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';

export const TEACHING_BRIEF_FINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TEACHING_BRIEF_OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded recent-candidate window; keeps quiet reads constant-round-trip. */
export const TEACHING_BRIEF_CANDIDATE_WINDOW = 50;

export type TeachingBriefEvidenceRef =
  | {
      role: 'induction';
      kind: ProposalEvidenceRefT['kind'];
      id: string;
    }
  | { role: 'probe'; kind: 'question'; id: string }
  | { role: 'outcome'; kind: 'event'; id: string };

export interface TeachingBriefFindingSection {
  claim_md: string;
  knowledge_id: string;
  cause_category: CauseCategoryT;
}

export interface TeachingBriefBasisSection {
  summary_md: string;
  evidence_trace: TeachingBriefEvidenceRef[];
}

export interface TeachingBriefBase {
  /** Stable identity: the conjecture proposal event id. */
  brief_id: string;
  state: 'finding' | 'probe_ready' | 'outcome_confirmed' | 'outcome_retired';
  updated_at: string;
  expires_at: string | null;
  finding: TeachingBriefFindingSection;
  basis: TeachingBriefBasisSection;
}

export interface FindingTeachingBrief extends TeachingBriefBase {
  state: 'finding';
  expires_at: string;
  prepared_action: {
    kind: 'review_finding';
    proposal_id: string;
    probe_preview_md: string;
  };
  current_outcome: {
    status: 'awaiting_decision';
    summary_md: string;
  };
}

export interface ProbeReadyTeachingBrief extends TeachingBriefBase {
  state: 'probe_ready';
  expires_at: null;
  prepared_action: {
    kind: 'answer_probe';
    probe_question_id: string;
    prompt_md: string;
  };
  current_outcome: {
    status: 'awaiting_answer';
    summary_md: string;
  };
}

/**
 * The outcome states' executable next step (YUK-708 / contract §2.1): acknowledge the
 * delivered result. P0F/2 shipped `{kind:'none'}`; P0F/4 upgrades the discriminated
 * union + strict Zod in lockstep so the UI may render a "知道了" that appends an ack.
 */
export interface OutcomeAcknowledgeAction {
  kind: 'acknowledge_outcome';
  probe_result_event_id: string;
}

export interface OutcomeConfirmedTeachingBrief extends TeachingBriefBase {
  state: 'outcome_confirmed';
  expires_at: string;
  prepared_action: OutcomeAcknowledgeAction;
  current_outcome: {
    status: 'confirmed';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export interface OutcomeRetiredTeachingBrief extends TeachingBriefBase {
  state: 'outcome_retired';
  expires_at: string;
  prepared_action: OutcomeAcknowledgeAction;
  current_outcome: {
    status: 'retired';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export type TeachingBrief =
  | FindingTeachingBrief
  | ProbeReadyTeachingBrief
  | OutcomeConfirmedTeachingBrief
  | OutcomeRetiredTeachingBrief;

export interface TeachingBriefResponse {
  brief: TeachingBrief | null;
}

type QuestionRow = typeof question.$inferSelect;
type EventRow = typeof event.$inferSelect;
type BriefStage = 'outcome' | 'probe' | 'finding';

interface ConjectureFacts {
  id: string;
  claimMd: string;
  knowledgeId: string;
  causeCategory: CauseCategoryT;
  reasonMd: string;
  probeMd: string;
  evidence: TeachingBriefEvidenceRef[];
  createdAt: Date;
  /** Internal selector ranking only — never serialized into the wire (contract §5). */
  salience: number;
}

interface CandidateError {
  reason: string;
}

type CandidateResult<T> = { value: T } | CandidateError;

function warnSkipped(stage: BriefStage, candidateId: string, reason: string): void {
  // Deliberately omit claim, prompt, answer, calibration values, and raw payload.
  console.warn('[teaching-brief] skipped candidate', {
    stage,
    candidate_id: candidateId,
    reason,
  });
}

export function isCandidateError<T>(result: CandidateResult<T>): result is CandidateError {
  return 'reason' in result;
}

/** The canonical facts a probe_result outcome event must carry to be projectable. */
export interface CanonicalProbeResultFacts {
  resolution: 'confirmed' | 'retired';
  outcome: 0 | 1;
  /** = the conjecture proposal id (brief_id); payload conjecture_event_id === caused_by. */
  conjectureEventId: string;
  probeQuestionId: string;
}

/**
 * Single source of truth for "is this a canonical, displayable/acknowledgeable probe
 * outcome". Validates the result EVENT itself: correct action, a question subject, a
 * legal resolution/outcome pair (confirmed↔0 / retired↔1), and self-consistent
 * conjecture provenance (payload.conjecture_event_id non-empty and === caused_by).
 * The reader (loadOutcomeBrief) and the ack writer (teaching-brief-ack.ts) both gate on
 * this so a corrupt result can never be projected OR acknowledged — the two paths' notion
 * of a canonical result cannot drift (YUK-708 review round-1, codex P2).
 */
export function validateCanonicalProbeResult(
  row: Pick<EventRow, 'action' | 'subject_kind' | 'subject_id' | 'caused_by_event_id' | 'payload'>,
): CandidateResult<CanonicalProbeResultFacts> {
  if (row.action !== PROBE_RESULT_ACTION) return { reason: 'result_action_mismatch' };
  if (
    row.subject_kind !== 'question' ||
    typeof row.subject_id !== 'string' ||
    row.subject_id.length === 0
  ) {
    return { reason: 'result_subject_invalid' };
  }
  const payload = toRecord(row.payload);
  const resolution = payload.resolution;
  const outcome = payload.outcome;
  if (
    !((resolution === 'confirmed' && outcome === 0) || (resolution === 'retired' && outcome === 1))
  ) {
    return { reason: 'outcome_resolution_mismatch' };
  }
  const conjectureEventId = payload.conjecture_event_id;
  if (
    typeof conjectureEventId !== 'string' ||
    conjectureEventId.length === 0 ||
    row.caused_by_event_id !== conjectureEventId
  ) {
    return { reason: 'result_provenance_mismatch' };
  }
  return {
    value: { resolution, outcome, conjectureEventId, probeQuestionId: row.subject_id },
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dedupeEvidence(refs: TeachingBriefEvidenceRef[]): TeachingBriefEvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.role}\u0000${ref.kind}\u0000${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factsFromProposalRow(
  row: ProposalInboxRow,
  requiredStatus: 'pending' | 'accepted',
): CandidateResult<ConjectureFacts> {
  if (row.status !== requiredStatus) return { reason: `proposal_not_${requiredStatus}` };
  if (
    row.kind !== 'conjecture' ||
    row.payload.kind !== 'conjecture' ||
    row.source_action !== 'experimental:proposal' ||
    row.source_subject_kind !== 'mind_model'
  ) {
    return { reason: 'proposal_not_canonical' };
  }

  const change = row.payload.proposed_change;
  if (row.target.subject_kind !== 'mind_model' || row.target.subject_id !== change.knowledge_id) {
    return { reason: 'proposal_target_mismatch' };
  }
  if (row.payload.evidence_refs.length === 0) {
    return { reason: 'induction_evidence_missing' };
  }

  return {
    value: {
      id: row.id,
      claimMd: change.claim_md,
      knowledgeId: change.knowledge_id,
      causeCategory: change.cause_category,
      reasonMd: row.payload.reason_md,
      probeMd: change.probe_md,
      evidence: dedupeEvidence(
        row.payload.evidence_refs.map((ref) => ({
          role: 'induction' as const,
          kind: ref.kind,
          id: ref.id,
        })),
      ),
      createdAt: row.proposed_at,
      salience: change.confidence * change.recurrence_count,
    },
  };
}

function factsFromRawProposalRow(row: EventRow): CandidateResult<ConjectureFacts> {
  const parsed = AiProposalPayload.safeParse(toRecord(row.payload).ai_proposal);
  if (
    !parsed.success ||
    parsed.data.kind !== 'conjecture' ||
    row.action !== 'experimental:proposal' ||
    row.subject_kind !== 'mind_model'
  ) {
    return { reason: 'proposal_payload_invalid' };
  }

  const payload = parsed.data;
  const change = payload.proposed_change;
  if (
    payload.target.subject_kind !== 'mind_model' ||
    payload.target.subject_id !== change.knowledge_id ||
    row.subject_id !== change.knowledge_id
  ) {
    return { reason: 'proposal_target_mismatch' };
  }
  if (payload.evidence_refs.length === 0) return { reason: 'induction_evidence_missing' };

  return {
    value: {
      id: row.id,
      claimMd: change.claim_md,
      knowledgeId: change.knowledge_id,
      causeCategory: change.cause_category,
      reasonMd: payload.reason_md,
      probeMd: change.probe_md,
      evidence: dedupeEvidence(
        payload.evidence_refs.map((ref) => ({
          role: 'induction' as const,
          kind: ref.kind,
          id: ref.id,
        })),
      ),
      createdAt: row.created_at,
      salience: change.confidence * change.recurrence_count,
    },
  };
}

async function loadLatestRatesByProposal(
  db: Db,
  proposalIds: string[],
): Promise<Map<string, EventRow>> {
  if (proposalIds.length === 0) return new Map();
  const rates = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, proposalIds)))
    .orderBy(desc(event.created_at), desc(event.id));
  const latest = new Map<string, EventRow>();
  for (const rate of rates) {
    const proposalId = rate.caused_by_event_id;
    if (proposalId && !latest.has(proposalId)) latest.set(proposalId, rate);
  }
  return latest;
}

const TERMINAL_PROPOSAL_RATINGS = new Set([
  'accept',
  'reverse',
  'change_type',
  'dismiss',
  'rollback',
]);

function hasTerminalRate(rate: EventRow | undefined): boolean {
  if (!rate) return false;
  const rating = toRecord(rate.payload).rating;
  return typeof rating === 'string' && TERMINAL_PROPOSAL_RATINGS.has(rating);
}

function hasProposalRejectMarker(row: EventRow): boolean {
  const payload = toRecord(row.payload);
  const rubric = toRecord(payload.rubric_verdict);
  const topology = toRecord(payload.topology_verdict);
  return rubric.ok === false || topology.status === 'reject';
}

async function loadProposalFacts(
  db: Db,
  proposalId: string,
  requiredStatus: 'pending' | 'accepted',
): Promise<CandidateResult<ConjectureFacts>> {
  const row = await getProposalInboxRow(db, proposalId);
  if (!row) {
    const [raw] = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, proposalId))
      .limit(1);
    return { reason: raw ? 'proposal_payload_invalid' : 'proposal_not_found' };
  }
  return factsFromProposalRow(row, requiredStatus);
}

async function loadAcceptedClaim(db: Db, proposalId: string, fallback: string): Promise<string> {
  const rates = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, proposalId),
        eq(event.caused_by_event_id, proposalId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  for (const rate of rates) {
    const payload = toRecord(rate.payload);
    if (payload.rating !== 'accept') continue;
    const corrected = payload.corrected_claim_md;
    if (typeof corrected === 'string' && corrected.trim().length > 0) return corrected;
  }
  return fallback;
}

function validateProbeQuestion(
  probe: QuestionRow,
  proposal: ConjectureFacts,
  now: Date,
): string | null {
  if (probe.source !== PROBE_QUESTION_SOURCE) return 'probe_source_mismatch';
  if (probe.draft_status !== 'draft') return 'probe_not_draft';
  if (probe.created_at.getTime() > now.getTime()) return 'probe_created_in_future';
  if (probe.source_ref !== proposal.id) return 'probe_source_ref_mismatch';
  if (toRecord(probe.metadata).conjecture_proposal_id !== proposal.id) {
    return 'probe_metadata_ref_mismatch';
  }
  if (probe.knowledge_ids.length === 0) return 'probe_knowledge_empty';
  if (probe.knowledge_ids[0] !== proposal.knowledgeId) return 'probe_knowledge_mismatch';
  if (probe.prompt_md !== proposal.probeMd) return 'probe_prompt_mismatch';
  return null;
}

function appendProbeEvidence(
  proposal: ConjectureFacts,
  probeId: string,
): TeachingBriefEvidenceRef[] {
  return dedupeEvidence([...proposal.evidence, { role: 'probe', kind: 'question', id: probeId }]);
}

/** The full chain facts needed to project OR acknowledge a delivered outcome. */
export interface AckableOutcomeFacts {
  proposal: ConjectureFacts;
  probe: QuestionRow;
  resolution: 'confirmed' | 'retired';
  /** = the conjecture proposal id (brief_id). */
  conjectureEventId: string;
}

/**
 * Single source of truth for "is this result a delivered, ackable outcome" — the COMPLETE
 * set of deliverability dimensions loadOutcomeBrief uses, so the reader and the ack writer
 * (teaching-brief-ack.ts) can never diverge (YUK-708 review rounds 2–4, codex P2):
 *   1. canonical result event — action, question subject, legal resolution/outcome pair,
 *      self-consistent provenance (validateCanonicalProbeResult);
 *   2. time window — half-open (now − OUTCOME_TTL, now]; a future-dated result is not yet
 *      deliverable and an expired one no longer is. Uses the reader's TTL constant, not a
 *      copied literal, and mirrors loadOutcomeBrief's SQL prefilter exactly;
 *   3. the mind-probe question exists;
 *   4. its conjecture proposal is accepted — loadProposalFacts → getProposalInboxRow →
 *      deriveProposalStatus, which FOLDS corrections (retract/mark_wrong/supersede flip the
 *      status off 'accepted'), so proposal-correction exclusion is covered by this shared
 *      path with no extra predicate;
 *   5. the probe is canonical for that proposal (validateProbeQuestion — source/draft/
 *      provenance/KC/prompt/created-in-future).
 * The ONE reader dimension deliberately NOT re-gated here is the `NOT EXISTS ack` filter:
 * for the writer that is the idempotency check, so an already-acked result returns
 * idempotent:true (see acknowledgeTeachingBriefOutcome), not a 409. Reason codes stay stable
 * (canonical-result reasons + result_created_in_future / result_expired / probe_not_found /
 * proposal_not_accepted / probe_*) for both the reader's skip log and the writer's 409.
 */
export async function validateAckableOutcome(
  db: Db,
  result: Pick<
    EventRow,
    | 'id'
    | 'action'
    | 'subject_kind'
    | 'subject_id'
    | 'caused_by_event_id'
    | 'created_at'
    | 'payload'
  >,
  now: Date,
): Promise<CandidateResult<AckableOutcomeFacts>> {
  const canonical = validateCanonicalProbeResult(result);
  if (isCandidateError(canonical)) return canonical;
  const { resolution, conjectureEventId, probeQuestionId } = canonical.value;

  // Time window — identical to loadOutcomeBrief's SQL prefilter (shared TTL constant, no
  // literal duplication). Half-open, eligible iff (now − OUTCOME_TTL) < created_at <= now:
  // a future-dated result is not yet deliverable; an expired one is no longer. Runs before
  // the DB chain queries so an out-of-window result short-circuits cheaply.
  const createdMs = result.created_at.getTime();
  if (createdMs > now.getTime()) return { reason: 'result_created_in_future' };
  if (createdMs <= now.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS)
    return { reason: 'result_expired' };

  // The probe lookup and the proposal-facts load depend only on the canonical products,
  // not on each other, so run them together. (Called with the top-level `db`, so these are
  // separate pooled connections — never two concurrent queries on one tx connection.)
  const [probeRows, proposalResult] = await Promise.all([
    db.select().from(question).where(eq(question.id, probeQuestionId)).limit(1),
    loadProposalFacts(db, conjectureEventId, 'accepted'),
  ]);
  const probe = probeRows[0];
  // probe_not_found stays the first-checked break so its reason code precedence is stable.
  if (!probe) return { reason: 'probe_not_found' };
  if (isCandidateError(proposalResult)) return proposalResult;
  const proposal = proposalResult.value;

  const probeError = validateProbeQuestion(probe, proposal, now);
  if (probeError) return { reason: probeError };

  return { value: { proposal, probe, resolution, conjectureEventId } };
}

async function loadOutcomeBrief(db: Db, now: Date): Promise<TeachingBrief | null> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS);
  const results = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.subject_kind, 'question'),
        gt(event.created_at, lowerBound),
        lte(event.created_at, now),
        // Only canonical resolution/outcome pairs may occupy the bounded window,
        // otherwise a flood of corrupt results could evict an older valid outcome.
        // The in-loop validation below stays authoritative for provenance.
        sql`((${event.payload}->>'resolution' = 'confirmed' AND ${event.payload}->>'outcome' = '0')
          OR (${event.payload}->>'resolution' = 'retired' AND ${event.payload}->>'outcome' = '1'))`,
        // YUK-708 (contract §4.2): an acknowledged outcome loses eligibility immediately.
        // Excluded pre-window (like the corrupt-pair filter) so a burst of acked results
        // cannot evict an older un-acked valid outcome. Ack existence is binary — there
        // is no "corrupt ack" — so this NOT EXISTS is authoritative on its own.
        sql`NOT EXISTS (
          SELECT 1 FROM ${event} AS ack
          WHERE ack.action = ${BRIEF_ACK_ACTION}
            AND ack.subject_kind = 'event'
            AND ack.subject_id = ${event.id}
        )`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(TEACHING_BRIEF_CANDIDATE_WINDOW);

  for (const result of results) {
    // Shared full-chain gate (single source of truth with the ack writer): canonical
    // result + existing canonical mind-probe + accepted conjecture proposal.
    const outcome = await validateAckableOutcome(db, result, now);
    if (isCandidateError(outcome)) {
      warnSkipped('outcome', result.id, outcome.reason);
      continue;
    }
    const { proposal, probe, resolution } = outcome.value;

    const claimMd = await loadAcceptedClaim(db, proposal.id, proposal.claimMd);
    const evidence = dedupeEvidence([
      ...appendProbeEvidence(proposal, probe.id),
      { role: 'outcome', kind: 'event', id: result.id },
    ]);
    const common = {
      brief_id: proposal.id,
      updated_at: result.created_at.toISOString(),
      expires_at: new Date(
        result.created_at.getTime() + TEACHING_BRIEF_OUTCOME_TTL_MS,
      ).toISOString(),
      finding: {
        claim_md: claimMd,
        knowledge_id: proposal.knowledgeId,
        cause_category: proposal.causeCategory,
      },
      basis: { summary_md: proposal.reasonMd, evidence_trace: evidence },
      // YUK-708 — the outcome's executable next step is acknowledgement; the ack targets
      // this very result event (also mirrored in current_outcome for the wire).
      prepared_action: {
        kind: 'acknowledge_outcome' as const,
        probe_result_event_id: result.id,
      },
    };
    if (resolution === 'confirmed') {
      return {
        ...common,
        state: 'outcome_confirmed',
        current_outcome: {
          status: 'confirmed',
          summary_md: '这条判断得到这次探针的支持；下一步可以针对这个点练习。',
          probe_question_id: probe.id,
          probe_result_event_id: result.id,
        },
      };
    }
    return {
      ...common,
      state: 'outcome_retired',
      current_outcome: {
        status: 'retired',
        summary_md: '这条判断被这次探针排除；原计划可以继续。',
        probe_question_id: probe.id,
        probe_result_event_id: result.id,
      },
    };
  }
  return null;
}

async function loadProbeBrief(db: Db, now: Date): Promise<TeachingBrief | null> {
  const probes = await db
    .select()
    .from(question)
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        // Cheap canonical-shape checks run pre-window so drifted probes cannot
        // crowd out an older valid served probe; validateProbeQuestion below
        // stays authoritative (and keeps the observable skip log) for the rest.
        eq(question.draft_status, 'draft'),
        sql`${question.source_ref} = ${question.metadata}->>'conjecture_proposal_id'`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
      ),
    )
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(TEACHING_BRIEF_CANDIDATE_WINDOW);

  for (const probe of probes) {
    const metadata = toRecord(probe.metadata);
    const proposalId = metadata.conjecture_proposal_id;
    if (typeof proposalId !== 'string' || proposalId.length === 0) {
      warnSkipped('probe', probe.id, 'probe_metadata_ref_missing');
      continue;
    }
    const proposalResult = await loadProposalFacts(db, proposalId, 'accepted');
    if (isCandidateError(proposalResult)) {
      warnSkipped('probe', probe.id, proposalResult.reason);
      continue;
    }
    const proposal = proposalResult.value;
    const probeError = validateProbeQuestion(probe, proposal, now);
    if (probeError) {
      warnSkipped('probe', probe.id, probeError);
      continue;
    }
    const claimMd = await loadAcceptedClaim(db, proposal.id, proposal.claimMd);
    return {
      brief_id: proposal.id,
      state: 'probe_ready',
      updated_at: probe.created_at.toISOString(),
      expires_at: null,
      finding: {
        claim_md: claimMd,
        knowledge_id: proposal.knowledgeId,
        cause_category: proposal.causeCategory,
      },
      basis: {
        summary_md: proposal.reasonMd,
        evidence_trace: appendProbeEvidence(proposal, probe.id),
      },
      prepared_action: {
        kind: 'answer_probe',
        probe_question_id: probe.id,
        prompt_md: probe.prompt_md,
      },
      current_outcome: {
        status: 'awaiting_answer',
        summary_md: '判别题已备好；完成后再更新这条判断。',
      },
    };
  }
  return null;
}

async function logAcceptedWithoutProbe(db: Db, now: Date): Promise<void> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_FINDING_TTL_MS);
  // Latest-rate status, canonical kind, TTL, and missing-probe detection all stay in
  // one bounded SQL query. Corrections fold in one additional batch query below.
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:proposal'),
        eq(event.subject_kind, 'mind_model'),
        gt(event.created_at, lowerBound),
        lte(event.created_at, now),
        sql`${event.payload}->'ai_proposal'->>'kind' = 'conjecture'`,
        sql`${event.payload}->'rubric_verdict'->>'ok' IS DISTINCT FROM 'false'`,
        sql`${event.payload}->'topology_verdict'->>'status' IS DISTINCT FROM 'reject'`,
        sql`(
          SELECT latest_rate.payload->>'rating'
          FROM ${event} AS latest_rate
          WHERE latest_rate.action = 'rate'
            AND latest_rate.caused_by_event_id = ${event.id}
          ORDER BY latest_rate.created_at DESC, latest_rate.id DESC
          LIMIT 1
        ) IN ('accept', 'reverse', 'change_type')`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${question}
          WHERE ${question.source} = ${PROBE_QUESTION_SOURCE}
            AND ${question.source_ref} = ${event.id}
            AND ${question.metadata}->>'conjecture_proposal_id' = ${event.id}
        )`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(TEACHING_BRIEF_CANDIDATE_WINDOW);
  const correctionStatuses = await getCorrectionStatuses(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if (correctionStatuses.get(row.id)?.state !== 'active') continue;
    warnSkipped('probe', row.id, 'accepted_without_probe');
  }
}

// Corrupt rows are excluded from the bounded selector windows in SQL so they cannot
// evict valid candidates; this bounded diagnostic pass preserves the contract §7
// observable skip log for exactly those rows.
async function logNonCanonicalCandidates(db: Db, now: Date): Promise<void> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS);
  const badResults = await db
    .select({ id: event.id, subject_kind: event.subject_kind })
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        gt(event.created_at, lowerBound),
        lte(event.created_at, now),
        sql`NOT (${event.subject_kind} = 'question'
          AND ((${event.payload}->>'resolution' = 'confirmed' AND ${event.payload}->>'outcome' = '0')
            OR (${event.payload}->>'resolution' = 'retired' AND ${event.payload}->>'outcome' = '1')))`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(TEACHING_BRIEF_CANDIDATE_WINDOW);
  for (const row of badResults) {
    warnSkipped(
      'outcome',
      row.id,
      row.subject_kind === 'question' ? 'outcome_resolution_mismatch' : 'result_subject_invalid',
    );
  }

  const badProbes = await db
    .select({ id: question.id })
    .from(question)
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        // Non-canonical probe shape = pool-visible (canonical probes are always
        // 'draft' — shared predicate keeps NULL≡active semantics, so a NULL
        // draft_status probe is correctly logged) OR incoherent provenance.
        or(
          notDraftPredicate(question.draft_status),
          sql`${question.source_ref} IS DISTINCT FROM ${question.metadata}->>'conjecture_proposal_id'`,
        ),
        sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
      ),
    )
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(TEACHING_BRIEF_CANDIDATE_WINDOW);
  for (const row of badProbes) warnSkipped('probe', row.id, 'probe_shape_non_canonical');
}

async function loadFindingBrief(db: Db, now: Date): Promise<TeachingBrief | null> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_FINDING_TTL_MS);
  const rawConjectures = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:proposal'),
        eq(event.subject_kind, 'mind_model'),
        gt(event.created_at, lowerBound),
        lte(event.created_at, now),
        sql`${event.payload}->'ai_proposal'->>'kind' = 'conjecture'`,
        // Decided/rejected proposals must be excluded BEFORE the bounded window is applied,
        // otherwise a burst of decided conjectures can evict an older still-pending finding
        // from the candidate set entirely (contract §5 requires ranking over all eligible
        // pending findings in the TTL window).
        sql`COALESCE(${event.payload}->'rubric_verdict'->>'ok', '') <> 'false'`,
        sql`COALESCE(${event.payload}->'topology_verdict'->>'status', '') <> 'reject'`,
        sql`COALESCE((
          SELECT latest_rate.payload->>'rating'
          FROM ${event} AS latest_rate
          WHERE latest_rate.action = 'rate'
            AND latest_rate.caused_by_event_id = ${event.id}
          ORDER BY latest_rate.created_at DESC, latest_rate.id DESC
          LIMIT 1
        ), '') NOT IN (${sql.join(
          [...TERMINAL_PROPOSAL_RATINGS].map((rating) => sql`${rating}`),
          sql`, `,
        )})`,
        // Corrected/retracted/superseded proposals are likewise excluded pre-window.
        // Mirror getCorrectionStatuses' last-write-wins semantics: only the LATEST
        // correction decides, so a corrected-then-restored proposal stays eligible.
        // A latest supersede without replacement (malformed) is excluded here even
        // though the in-memory pass would keep the prior state — fail-closed skip is
        // the contract's stance on corrupt records, and getCorrectionStatuses below
        // stays as the authoritative second gate.
        sql`COALESCE((
          SELECT correction.payload->>'correction_kind'
          FROM ${event} AS correction
          WHERE correction.action = 'correct'
            AND correction.subject_kind = 'event'
            AND correction.subject_id = ${event.id}
          ORDER BY correction.created_at DESC, correction.id DESC
          LIMIT 1
        ), '') NOT IN ('retract', 'mark_wrong', 'supersede')`,
      ),
    )
    .orderBy(
      // Salience ranks BEFORE the window truncates (contract §5: highest-salience
      // fresh finding across ALL eligible candidates). Non-numeric payloads rank
      // as zero — they are skipped later anyway.
      sql`CASE
        WHEN jsonb_typeof(${event.payload}->'ai_proposal'->'proposed_change'->'confidence') = 'number'
         AND jsonb_typeof(${event.payload}->'ai_proposal'->'proposed_change'->'recurrence_count') = 'number'
        THEN (${event.payload}->'ai_proposal'->'proposed_change'->>'confidence')::numeric
           * (${event.payload}->'ai_proposal'->'proposed_change'->>'recurrence_count')::numeric
        ELSE 0
      END DESC`,
      desc(event.created_at),
      desc(event.id),
    )
    .limit(TEACHING_BRIEF_CANDIDATE_WINDOW);
  const proposalIds = rawConjectures.map((row) => row.id);
  const [latestRates, correctionStatuses] = await Promise.all([
    loadLatestRatesByProposal(db, proposalIds),
    getCorrectionStatuses(db, proposalIds),
  ]);

  const ranked = rawConjectures
    .flatMap((row) => {
      const proposalResult = factsFromRawProposalRow(row);
      if (isCandidateError(proposalResult)) {
        warnSkipped('finding', row.id, proposalResult.reason);
        return [];
      }
      if (
        correctionStatuses.get(row.id)?.state !== 'active' ||
        hasProposalRejectMarker(row) ||
        hasTerminalRate(latestRates.get(row.id))
      ) {
        return [];
      }
      return [{ proposal: proposalResult.value, salience: proposalResult.value.salience }];
    })
    .sort((a, b) => {
      const aSalience = a.salience;
      const bSalience = b.salience;
      if (aSalience !== bSalience) return bSalience - aSalience;
      if (a.proposal.createdAt.getTime() !== b.proposal.createdAt.getTime()) {
        return b.proposal.createdAt.getTime() - a.proposal.createdAt.getTime();
      }
      return a.proposal.id === b.proposal.id ? 0 : a.proposal.id < b.proposal.id ? 1 : -1;
    });

  const top = ranked.at(0);
  if (!top) return null;
  const proposal = top.proposal;
  return {
    brief_id: proposal.id,
    state: 'finding',
    updated_at: proposal.createdAt.toISOString(),
    expires_at: new Date(
      proposal.createdAt.getTime() + TEACHING_BRIEF_FINDING_TTL_MS,
    ).toISOString(),
    finding: {
      claim_md: proposal.claimMd,
      knowledge_id: proposal.knowledgeId,
      cause_category: proposal.causeCategory,
    },
    basis: {
      summary_md: proposal.reasonMd,
      evidence_trace: proposal.evidence,
    },
    prepared_action: {
      kind: 'review_finding',
      proposal_id: proposal.id,
      probe_preview_md: proposal.probeMd,
    },
    current_outcome: {
      status: 'awaiting_decision',
      summary_md: '这仍是一条待检验的判断。',
    },
  };
}

/**
 * Project the single globally-preferred TeachingBrief. Every operation is a SELECT;
 * query failures deliberately propagate so the route can distinguish service failure
 * from a truthful quiet `{brief:null}`.
 */
export async function loadTeachingBrief(
  db: Db,
  now: Date = new Date(),
): Promise<TeachingBriefResponse> {
  try {
    await logNonCanonicalCandidates(db, now);
  } catch (error) {
    // Diagnostic-only scan; it must never break brief selection.
    console.warn('[teaching-brief] non-canonical scan failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const outcome = await loadOutcomeBrief(db, now);
  if (outcome) return { brief: outcome };

  const probe = await loadProbeBrief(db, now);
  if (probe) return { brief: probe };

  try {
    await logAcceptedWithoutProbe(db, now);
  } catch (error) {
    // Diagnostic-only scan; it must never break the finding-brief fallback.
    console.warn('[teaching-brief] accepted-without-probe scan failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { brief: await loadFindingBrief(db, now) };
}
