// Read-only TeachingBrief projected from the conjecture proposal → mind-probe
// question → probe-result event chain.

import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { ConjectureProbeSpec } from '@/core/schema/business';
import type { CauseCategoryT } from '@/core/schema/cause';
import {
  BRIEF_ACK_ACTION,
  PROBE_NON_EVIDENCE_RESOLUTION,
  PROBE_QUESTION_INITIAL_VERSION,
  PROBE_QUESTION_SOURCE,
  PROBE_RESOLUTION_RULE_VERSION,
  PROBE_RESULT_ACTION,
  type ProbeResolution,
  TERMINAL_PROBE_RESOLUTIONS,
  isCanonicalEvidenceProbeOutcomeResolution,
} from '@/core/schema/conjecture';
import { AiProposalPayload, type ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import {
  assessment_issuance,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { type ProposalInboxRow, getProposalInboxRow } from '@/kernel/proposals/inbox';
import { proposalReasonPlainText } from '@/kernel/proposals/reason-text';
import {
  type CompletedProbeProposal,
  loadCompletedProbeAssessmentAnchors,
  validateCompletedProbeProvenance,
  validateIssuedProbeProvenance,
} from '@/kernel/read-models/completed-probe-provenance';
import {
  type EffectiveProbeResultStatus,
  getEffectiveProbeResultStatuses,
} from '@/kernel/read-models/probe-evidence';

export const TEACHING_BRIEF_FINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TEACHING_BRIEF_OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded recent-candidate window; keeps quiet reads constant-round-trip. */
export const TEACHING_BRIEF_CANDIDATE_WINDOW = 50;
/**
 * Fail closed on an exhausted scan rather than resurrect preliminary evidence
 * from incomplete terminal history.
 */
const TERMINAL_SCAN_PER_CONJECTURE = 8;

/**
 * Outcome copy: short, factual, no probabilities or verdicts about the person.
 * The `*_REWRITTEN` variants name the pre-edit claim, because the served probe
 * belongs to it, not to the rewrite the reader sees.
 */
export const TEACHING_BRIEF_OUTCOME_COPY = {
  AWAITING_DECISION: '这仍是一条待检验的判断。',
  AWAITING_ANSWER: '判别题已备好；完成后再更新这条判断。',
  AWAITING_ANSWER_REWRITTEN: '判别题针对的是你改写前的那条判断；你的改写还没有配套的判别题。',
  EVIDENCE_FOR: '这次表现与这条判断一致，但单次探针不足以下结论；还需要一次独立复验。',
  EVIDENCE_FOR_REWRITTEN:
    '这次表现与改写前的那条判断一致，但单次探针不足以下结论；你的改写仍未被检验。',
  CONFIRMED: '这条判断得到这次探针的支持；下一步可以针对这个点练习。',
  CONFIRMED_REWRITTEN: '这次探针支持的是你改写前的那条判断；你的改写还没有被检验。',
  RETIRED: '这条判断被这次探针排除；原计划可以继续。',
  RETIRED_REWRITTEN: '这次探针排除的是你改写前的那条判断；你的改写还没有被检验。',
} as const;

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
  /**
   * The claim the served probe actually tests, present only when the owner rewrote
   * the claim on accept and always different from `claim_md`. `claim_md` keeps the
   * owner's words; this key says the probe evidence belongs to the pre-edit claim.
   * Absent (not null) when nothing was rewritten.
   */
  tested_claim_md?: string;
}

export interface TeachingBriefBasisSection {
  summary_md: string;
  evidence_trace: TeachingBriefEvidenceRef[];
}

export interface TeachingBriefBase {
  /** Stable identity: the conjecture proposal event id. */
  brief_id: string;
  state:
    | 'finding'
    | 'probe_ready'
    | 'outcome_evidence_for'
    | 'outcome_confirmed'
    | 'outcome_retired';
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

/** Acknowledge the delivered result; `retired` outcomes have no further action. */
export interface OutcomeAcknowledgeAction {
  kind: 'acknowledge_outcome';
  probe_result_event_id: string;
}

/**
 * Practise the confirmed KC on demand via `/practice?kc=<knowledge_id>`. Nothing is
 * written until the user acts; the result id lets the same ack retire the brief.
 */
export interface OutcomePracticeAction {
  kind: 'practice_scoped';
  knowledge_id: string;
  probe_result_event_id: string;
}

export interface OutcomeConfirmedTeachingBrief extends TeachingBriefBase {
  state: 'outcome_confirmed';
  expires_at: string;
  prepared_action: OutcomePracticeAction;
  current_outcome: {
    status: 'confirmed';
    summary_md: string;
    probe_question_id: string;
    probe_result_event_id: string;
  };
}

export interface OutcomeEvidenceForTeachingBrief extends TeachingBriefBase {
  state: 'outcome_evidence_for';
  expires_at: string;
  prepared_action: OutcomeAcknowledgeAction;
  current_outcome: {
    status: 'evidence_for';
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
  | OutcomeEvidenceForTeachingBrief
  | OutcomeConfirmedTeachingBrief
  | OutcomeRetiredTeachingBrief;

export interface TeachingBriefResponse {
  brief: TeachingBrief | null;
}

type QuestionRow = typeof question.$inferSelect;
type EventRow = typeof event.$inferSelect;
type BriefStage = 'outcome' | 'probe' | 'finding';
// A pooled connection or an open transaction; the ack writer selects under its lock.
type DbLike = Db | Tx;

interface ConjectureFacts extends CompletedProbeProposal {
  /** Trimmed here as defense in depth for legacy rows; display and comparison share it. */
  claimMd: string;
  causeCategory: CauseCategoryT;
  reasonMd: string;
  evidence: TeachingBriefEvidenceRef[];
  createdAt: Date;
  /** Internal ranking only; never serialized. */
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

/** Facts a probe_result outcome must carry to be projectable. */
export interface CanonicalProbeResultFacts {
  resolution: ProbeResolution;
  outcome: 0 | 1;
  /** The conjecture proposal id (brief_id); equals payload conjecture_event_id. */
  conjectureEventId: string;
  probeQuestionId: string;
}

/** Shared SQL mirror of the canonical resolution/outcome pair matrix. */
function canonicalProbeResolutionOutcomeSql() {
  return sql`((${event.payload}->>'resolution' IN ('evidence_for', 'confirmed')
      AND ${event.payload}->>'outcome' = '0')
    OR (${event.payload}->>'resolution' = 'retired'
      AND ${event.payload}->>'outcome' = '1'))`;
}

/**
 * A terminal non-evidence disposition is intentional, not corrupt, so it must not
 * appear in diagnostic warnings.
 */
function terminalNonEvidenceProbeResolutionOutcomeSql() {
  return sql`(${event.payload}->>'resolution' = ${PROBE_NON_EVIDENCE_RESOLUTION}
    AND ${event.payload}->'outcome' = 'null'::jsonb)`;
}

/**
 * Single gate for a canonical, displayable/acknowledgeable probe outcome: action,
 * subject, resolution/outcome pair, and provenance must all agree. Reader and ack
 * writer share it so their notion of a canonical result cannot drift.
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
  const disposition = { resolution: payload.resolution, outcome: payload.outcome };
  // Keep this pair matrix aligned with the SQL bounded-window prefilters in
  // loadOutcomeBrief and logNonCanonicalCandidates below.
  if (!isCanonicalEvidenceProbeOutcomeResolution(disposition)) {
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
    value: {
      resolution: disposition.resolution,
      outcome: disposition.outcome,
      conjectureEventId,
      probeQuestionId: row.subject_id,
    },
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
      claimMd: change.claim_md.trim(),
      knowledgeId: change.knowledge_id,
      causeCategory: change.cause_category,
      reasonMd: proposalReasonPlainText(row.payload.reason_md),
      probeMd: change.probe_md,
      probeReferenceMd: change.probe_reference_md,
      probeSpec: change.probe_spec ?? null,
      followupProbeMd: change.followup_probe_md ?? null,
      followupProbeReferenceMd: change.followup_probe_reference_md ?? null,
      followupProbeSpec: change.followup_probe_spec ?? null,
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
      claimMd: change.claim_md.trim(),
      knowledgeId: change.knowledge_id,
      causeCategory: change.cause_category,
      reasonMd: proposalReasonPlainText(payload.reason_md),
      probeMd: change.probe_md,
      probeReferenceMd: change.probe_reference_md,
      probeSpec: change.probe_spec ?? null,
      followupProbeMd: change.followup_probe_md ?? null,
      followupProbeReferenceMd: change.followup_probe_reference_md ?? null,
      followupProbeSpec: change.followup_probe_spec ?? null,
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

/** Active lists share the same original proposal facts as completed report evidence. */
export function validateIssuedProbeFromProposal({
  proposalRow,
  ...issued
}: Omit<Parameters<typeof validateIssuedProbeProvenance>[0], 'proposal'> & {
  proposalRow: EventRow | null;
}) {
  if (!proposalRow) return { reason: 'proposal_not_found' };
  const proposal = factsFromRawProposalRow(proposalRow);
  if (isCandidateError(proposal)) return proposal;
  return validateIssuedProbeProvenance({ ...issued, proposal: proposal.value });
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
  db: DbLike,
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

/**
 * Load conjecture facts straight from the proposal's RAW event, WITHOUT the correction/status
 * fold — verifies only that the event exists and is a canonical conjecture proposal. Used by the
 * historical report path (validateAckableOutcome skipCurrentStatusFold), where a later retract must
 * not erase an outcome that was already delivered. Mirrors loadFindingBrief's raw-row source.
 */
async function loadRawConjectureFacts(
  db: DbLike,
  proposalId: string,
): Promise<CandidateResult<ConjectureFacts>> {
  const [raw] = await db.select().from(event).where(eq(event.id, proposalId)).limit(1);
  if (!raw) return { reason: 'proposal_not_found' };
  return factsFromRawProposalRow(raw);
}

/**
 * The finding of an accepted conjecture. `claim_md` prefers the owner's inline rewrite and
 * falls back to the proposal claim; after a rewrite the probe still belongs to the original
 * claim, so `tested_claim_md` carries it and the caller adjusts the copy. KC and cause are
 * never editable, so the probe target cannot drift.
 */
async function loadAcceptedFinding(
  db: DbLike,
  proposal: ConjectureFacts,
): Promise<TeachingBriefFindingSection> {
  const base = {
    knowledge_id: proposal.knowledgeId,
    cause_category: proposal.causeCategory,
  };
  const rates = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, proposal.id),
        eq(event.caused_by_event_id, proposal.id),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  for (const rate of rates) {
    const payload = toRecord(rate.payload);
    if (payload.rating !== 'accept') continue;
    const corrected = payload.corrected_claim_md;
    if (typeof corrected !== 'string') continue;
    const trimmed = corrected.trim();
    if (trimmed.length === 0) continue;
    // A rewrite that normalizes to the proposal claim needs no disclosure key. Both current
    // schemas trim, and this reader-side normalization preserves that verdict for legacy rows.
    if (trimmed === proposal.claimMd) return { ...base, claim_md: trimmed };
    return { ...base, claim_md: trimmed, tested_claim_md: proposal.claimMd };
  }
  return { ...base, claim_md: proposal.claimMd };
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
  const sequence = toRecord(probe.metadata).probe_sequence;
  if (sequence !== undefined && sequence !== 1 && sequence !== 2) {
    return 'probe_sequence_invalid';
  }
  if (probe.knowledge_ids.length === 0) return 'probe_knowledge_empty';
  if (probe.knowledge_ids[0] !== proposal.knowledgeId) return 'probe_knowledge_mismatch';
  const expectedPrompt = sequence === 2 ? proposal.followupProbeMd : proposal.probeMd;
  if (expectedPrompt === null) return 'probe_followup_missing';
  if (probe.prompt_md !== expectedPrompt) return 'probe_prompt_mismatch';
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
  resolution: ProbeResolution;
  /** = the conjecture proposal id (brief_id). */
  conjectureEventId: string;
}

/**
 * Complete deliverability check shared by the reader and ack writer: canonical result,
 * TTL window, probe existence, accepted proposal (with corrections folded), and issued
 * provenance. The ack exclusion is intentionally not re-checked here: for the writer that
 * is idempotency, so an existing ack returns idempotent instead of 409. Reason codes are
 * shared by the reader's skip log and the writer's 409.
 */
export async function validateAckableOutcome(
  db: DbLike,
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
  // serial: the ack path runs inside a single-connection transaction, so the two reads
  // cannot be concurrent; the GET path keeps Promise.all.
  //
  // skipTimeWindow: the historical survival report counts the structural chain but must
  // include now-expired and later-acked outcomes, so live-reader window/ack filters are off.
  // skipCurrentStatusFold: a later retract must not erase a delivery that already happened;
  // the proposal is read raw, while every non-status structural check still runs.
  {
    serial = false,
    skipTimeWindow = false,
    skipCurrentStatusFold = false,
    precomputedEvidenceStatus,
  }: {
    serial?: boolean;
    skipTimeWindow?: boolean;
    skipCurrentStatusFold?: boolean;
    precomputedEvidenceStatus?: EffectiveProbeResultStatus;
  } = {},
): Promise<CandidateResult<AckableOutcomeFacts>> {
  const canonical = validateCanonicalProbeResult(result);
  if (isCandidateError(canonical)) return canonical;
  const { resolution, conjectureEventId, probeQuestionId } = canonical.value;
  const evidenceStatus =
    precomputedEvidenceStatus ??
    (await getEffectiveProbeResultStatuses(db, [result.id])).get(result.id);
  if (evidenceStatus !== 'active') {
    return { reason: 'result_evidence_inactive' };
  }

  // Half-open (now − TTL, now]: a future result is not yet deliverable, an expired one no
  // longer is. Check before the DB chain so out-of-window results short-circuit.
  if (!skipTimeWindow) {
    const createdMs = result.created_at.getTime();
    if (createdMs > now.getTime()) return { reason: 'result_created_in_future' };
    if (createdMs <= now.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS)
      return { reason: 'result_expired' };
  }

  // The probe lookup and the proposal-facts load depend only on the canonical products, not
  // on each other. On the pooled read path they run together (Promise.all, separate
  // connections); on a single-connection transaction (serial:true) they must run one at a
  // time. Both orderings check probe_not_found first, so the reason precedence is stable.
  const loadProbe = () =>
    db
      .select({ probe: question, issuance: assessment_issuance, revision: question_revision })
      .from(question)
      .leftJoin(
        assessment_issuance,
        eq(assessment_issuance.issuance_id, sql<string>`'iss_probe_' || ${question.id}`),
      )
      .leftJoin(
        question_revision,
        eq(question_revision.revision_id, assessment_issuance.revision_id),
      )
      .where(eq(question.id, probeQuestionId))
      .limit(1);
  // skipCurrentStatusFold → read the proposal from its RAW event (verifies it is a canonical
  // conjecture, no correction/status fold), otherwise require the folded status to be 'accepted'
  // (the live reader/ack path).
  const loadProposal = (): Promise<CandidateResult<ConjectureFacts>> =>
    skipCurrentStatusFold
      ? loadRawConjectureFacts(db, conjectureEventId)
      : loadProposalFacts(db, conjectureEventId, 'accepted');
  let probeRows: Awaited<ReturnType<typeof loadProbe>>;
  let proposalResult: CandidateResult<ConjectureFacts>;
  if (serial) {
    probeRows = await loadProbe();
    proposalResult = await loadProposal();
  } else {
    [probeRows, proposalResult] = await Promise.all([loadProbe(), loadProposal()]);
  }
  const probeRow = probeRows[0];
  // probe_not_found stays the first-checked break so its reason code precedence is stable.
  if (!probeRow) return { reason: 'probe_not_found' };
  if (isCandidateError(proposalResult)) return proposalResult;
  const proposal = proposalResult.value;

  const probe = probeRow.probe;
  if (probeRow.issuance) {
    const completed = validateCompletedProbeProvenance({
      result,
      probe,
      proposal,
      issuance: probeRow.issuance,
      revision: probeRow.revision,
      assessmentAnchors: await loadCompletedProbeAssessmentAnchors(db, [result]),
      now,
    });
    if (isCandidateError(completed)) return completed;
  } else {
    // Historical unissued outcomes retain their original row-based semantics.
    const probeError = validateProbeQuestion(probe, proposal, now);
    if (probeError) return { reason: probeError };
  }

  return { value: { proposal, probe, resolution, conjectureEventId } };
}

/**
 * The single primary outcome currently deliverable, or null. The ack writer requires its
 * target to be exactly this, so ackable and delivered sets match including selection. An
 * older outcome hidden behind a terminal remains superseded.
 *
 * The writer calls this inside its advisory-locked transaction so verdict and append share
 * one snapshot, closing the TOCTOU window; pass serial:true on that single connection.
 */
export async function loadOutcomeBrief(
  db: DbLike,
  now: Date,
  { serial = false }: { serial?: boolean } = {},
): Promise<
  | OutcomeEvidenceForTeachingBrief
  | OutcomeConfirmedTeachingBrief
  | OutcomeRetiredTeachingBrief
  | null
> {
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
        // Keep this SQL mirror aligned with validateCanonicalProbeResult; the
        // in-loop validation below stays authoritative for provenance.
        canonicalProbeResolutionOutcomeSql(),
        // Corrected outcomes are excluded before the bounded window. The subquery
        // ignores structurally invalid correction kinds (notably supersede without
        // a replacement) just as getCorrectionStatuses does; the in-memory gate
        // additionally validates the full event and recurrence dependencies.
        sql`COALESCE((
          SELECT correction.payload->>'correction_kind'
          FROM ${event} AS correction
          WHERE correction.action = 'correct'
            AND correction.subject_kind = 'event'
            AND correction.subject_id = ${event.id}
            AND (
              (correction.payload->>'correction_kind' = 'supersede'
                AND COALESCE(correction.payload->>'replacement_event_id', '') <> '')
              OR (correction.payload->>'correction_kind' IN
                  ('retract', 'mark_wrong', 'restore')
                AND NOT correction.payload ? 'replacement_event_id')
            )
          ORDER BY correction.created_at DESC, correction.id DESC
          LIMIT 1
        ), '') NOT IN ('retract', 'mark_wrong', 'supersede')`,
        // An acknowledged outcome loses eligibility. Filter before the window cap so a
        // burst of acks cannot evict an older valid outcome; ack existence is binary.
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

  const resultStatuses = await getEffectiveProbeResultStatuses(
    db,
    results.map((result) => result.id),
  );
  const candidateConjectureIds = [
    ...new Set(
      results.flatMap((result) => {
        const conjectureEventId = toRecord(result.payload).conjecture_event_id;
        return typeof conjectureEventId === 'string' ? [conjectureEventId] : [];
      }),
    ),
  ];
  const loadTerminalWindow = (conjectureEventId: string) =>
    db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, PROBE_RESULT_ACTION),
          eq(event.subject_kind, 'question'),
          eq(sql<string>`${event.payload}->>'conjecture_event_id'`, conjectureEventId),
          sql`${event.payload}->>'resolution_rule_version' =
              ${PROBE_RESOLUTION_RULE_VERSION}`,
          canonicalProbeResolutionOutcomeSql(),
          inArray(sql<string>`${event.payload}->>'resolution'`, [...TERMINAL_PROBE_RESOLUTIONS]),
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(TERMINAL_SCAN_PER_CONJECTURE + 1);
  // Bound each conjecture independently so one noisy history cannot crowd another
  // candidate out of a global LIMIT. The ack transaction uses one connection and
  // therefore loads these windows serially.
  const terminalWindows: Array<{
    conjectureEventId: string;
    rows: EventRow[];
    truncated: boolean;
  }> = [];
  if (serial) {
    for (const conjectureEventId of candidateConjectureIds) {
      const rows = await loadTerminalWindow(conjectureEventId);
      terminalWindows.push({
        conjectureEventId,
        rows: rows.slice(0, TERMINAL_SCAN_PER_CONJECTURE),
        truncated: rows.length > TERMINAL_SCAN_PER_CONJECTURE,
      });
    }
  } else {
    terminalWindows.push(
      ...(await Promise.all(
        candidateConjectureIds.map(async (conjectureEventId) => {
          const rows = await loadTerminalWindow(conjectureEventId);
          return {
            conjectureEventId,
            rows: rows.slice(0, TERMINAL_SCAN_PER_CONJECTURE),
            truncated: rows.length > TERMINAL_SCAN_PER_CONJECTURE,
          };
        }),
      )),
    );
  }
  const terminalRows = terminalWindows.flatMap(({ rows }) => rows);
  const terminalStatuses = await getEffectiveProbeResultStatuses(
    db,
    terminalRows.map((row) => row.id),
  );
  // A terminal may suppress preliminary evidence only after the same full-chain
  // validation used for display/ack succeeds. Event-level shape alone is not
  // sufficient: a drifted/missing probe or non-accepted proposal must fail
  // closed without hiding the still-valid preliminary result.
  const validateTerminal = async (row: (typeof terminalRows)[number]) => ({
    row,
    outcome: await validateAckableOutcome(db, row, now, {
      serial,
      // Supersession is permanent: an older terminal must not let a
      // later-timestamp preliminary result resurface when only the terminal
      // crosses the live display TTL.
      skipTimeWindow: true,
      precomputedEvidenceStatus: terminalStatuses.get(row.id),
    }),
  });
  // The ack path runs on one transaction connection and therefore must remain
  // serial; the ordinary pooled GET path can validate the bounded candidate set
  // concurrently.
  const terminalOutcomes = serial
    ? await (async () => {
        const outcomes: Awaited<ReturnType<typeof validateTerminal>>[] = [];
        for (const row of terminalRows) outcomes.push(await validateTerminal(row));
        return outcomes;
      })()
    : await Promise.all(terminalRows.map(validateTerminal));
  const terminalOutcomesById = new Map(
    terminalOutcomes.map(({ row, outcome }) => [row.id, outcome] as const),
  );
  const terminalConjectureIds = new Set(
    terminalOutcomes.flatMap(({ outcome }) =>
      isCandidateError(outcome) ? [] : [outcome.value.proposal.id],
    ),
  );
  const incompleteTerminalConjectureIds = new Set(
    terminalWindows.flatMap(({ conjectureEventId, truncated }) =>
      truncated && !terminalConjectureIds.has(conjectureEventId) ? [conjectureEventId] : [],
    ),
  );

  for (const result of results) {
    if (resultStatuses.get(result.id) !== 'active') {
      warnSkipped('outcome', result.id, 'result_evidence_inactive');
      continue;
    }
    const canonical = validateCanonicalProbeResult(result);
    if (!isCandidateError(canonical) && canonical.value.resolution === 'evidence_for') {
      if (terminalConjectureIds.has(canonical.value.conjectureEventId)) continue;
      if (incompleteTerminalConjectureIds.has(canonical.value.conjectureEventId)) {
        warnSkipped('outcome', result.id, 'terminal_history_scan_truncated');
        continue;
      }
    }
    // Shared full-chain gate (single source of truth with the ack writer): canonical
    // result + existing canonical mind-probe + accepted conjecture proposal.
    const outcome =
      terminalOutcomesById.get(result.id) ??
      (await validateAckableOutcome(db, result, now, {
        serial,
        precomputedEvidenceStatus: resultStatuses.get(result.id),
      }));
    if (isCandidateError(outcome)) {
      warnSkipped('outcome', result.id, outcome.reason);
      continue;
    }
    const { proposal, probe, resolution } = outcome.value;

    const finding = await loadAcceptedFinding(db, proposal);
    // The probe belongs to the pre-edit claim; never announce it as testing the rewrite.
    const rewritten = finding.tested_claim_md !== undefined;
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
      finding,
      basis: { summary_md: proposal.reasonMd, evidence_trace: evidence },
    };
    if (resolution === 'evidence_for') {
      return {
        ...common,
        state: 'outcome_evidence_for',
        // A single matching answer is only preliminary evidence. It must not unlock
        // KC practice as if the conjecture were confirmed; the learner can dismiss
        // this update while a later independent probe supplies the next decision.
        prepared_action: {
          kind: 'acknowledge_outcome' as const,
          probe_result_event_id: result.id,
        },
        current_outcome: {
          status: 'evidence_for',
          summary_md: rewritten
            ? TEACHING_BRIEF_OUTCOME_COPY.EVIDENCE_FOR_REWRITTEN
            : TEACHING_BRIEF_OUTCOME_COPY.EVIDENCE_FOR,
          probe_question_id: probe.id,
          probe_result_event_id: result.id,
        },
      };
    }
    if (resolution === 'confirmed') {
      return {
        ...common,
        state: 'outcome_confirmed',
        // KC-scoped practice: knowledge_id is the canonical proposal KC; the result id
        // keeps the same ack targeting this outcome.
        prepared_action: {
          kind: 'practice_scoped' as const,
          knowledge_id: proposal.knowledgeId,
          probe_result_event_id: result.id,
        },
        current_outcome: {
          status: 'confirmed',
          summary_md: rewritten
            ? TEACHING_BRIEF_OUTCOME_COPY.CONFIRMED_REWRITTEN
            : TEACHING_BRIEF_OUTCOME_COPY.CONFIRMED,
          probe_question_id: probe.id,
          probe_result_event_id: result.id,
        },
      };
    }
    return {
      ...common,
      state: 'outcome_retired',
      // A retired judgement rules the finding out; only acknowledge. Practice is scoped
      // to confirmed outcomes.
      prepared_action: {
        kind: 'acknowledge_outcome' as const,
        probe_result_event_id: result.id,
      },
      current_outcome: {
        status: 'retired',
        summary_md: rewritten
          ? TEACHING_BRIEF_OUTCOME_COPY.RETIRED_REWRITTEN
          : TEACHING_BRIEF_OUTCOME_COPY.RETIRED,
        probe_question_id: probe.id,
        probe_result_event_id: result.id,
      },
    };
  }
  return null;
}

async function loadProbeBrief(db: Db, now: Date): Promise<TeachingBrief | null> {
  const probes = await db
    .select({ probe: question, issuance: assessment_issuance, revision: question_revision })
    .from(question)
    .innerJoin(question_group_lifecycle, eq(question_group_lifecycle.group_id, question.id))
    .innerJoin(
      assessment_issuance,
      eq(assessment_issuance.issuance_id, sql<string>`'iss_probe_' || ${question.id}`),
    )
    .innerJoin(
      question_revision,
      and(
        eq(question_revision.revision_id, assessment_issuance.revision_id),
        eq(question_revision.group_id, question.id),
      ),
    )
    .where(
      and(
        eq(question.source, PROBE_QUESTION_SOURCE),
        eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
        eq(question_group_lifecycle.suspended, false),
        eq(question_group_lifecycle.withdrawn, false),
        // The probe answer endpoint supports exactly one frozen open response.
        // Filter issuance eligibility before the candidate window, so legacy
        // unissued rows cannot hide an older answerable probe.
        sql`CASE WHEN jsonb_typeof(${question_revision.response_spec}->'slots') = 'array'
          THEN jsonb_array_length(${question_revision.response_spec}->'slots') = 1
          ELSE false END`,
        sql`${question_revision.response_spec}->'slots'->0->>'kind' = 'open_response'`,
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

  for (const { probe, issuance, revision } of probes) {
    const metadata = toRecord(probe.metadata);
    // Preserve the submit endpoint's authored-snapshot guard for response-aware
    // probes. Legacy rows without that snapshot use the frozen issuance face.
    if (metadata.probe_spec !== undefined) {
      const authored = ConjectureProbeSpec.safeParse(metadata.probe_spec);
      if (!authored.success) {
        warnSkipped('probe', probe.id, 'probe_snapshot_invalid');
        continue;
      }
      if (
        probe.version !== PROBE_QUESTION_INITIAL_VERSION ||
        probe.prompt_md !== authored.data.prompt_md ||
        probe.reference_md !== authored.data.reference_md
      ) {
        warnSkipped('probe', probe.id, 'probe_snapshot_changed');
        continue;
      }
    }
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
    const issued = validateIssuedProbeProvenance({ probe, proposal, issuance, revision, now });
    if (isCandidateError(issued)) {
      warnSkipped('probe', probe.id, issued.reason);
      continue;
    }
    const projected = { ...probe, prompt_md: issued.value.promptMd };
    const probeError = validateProbeQuestion(projected, proposal, now);
    if (probeError) {
      warnSkipped('probe', probe.id, probeError);
      continue;
    }
    const finding = await loadAcceptedFinding(db, proposal);
    return {
      brief_id: proposal.id,
      state: 'probe_ready',
      updated_at: probe.created_at.toISOString(),
      expires_at: null,
      finding,
      basis: {
        summary_md: proposal.reasonMd,
        evidence_trace: appendProbeEvidence(proposal, probe.id),
      },
      prepared_action: {
        kind: 'answer_probe',
        probe_question_id: probe.id,
        prompt_md: projected.prompt_md,
      },
      current_outcome: {
        status: 'awaiting_answer',
        // The issued prompt matches the one authored with this proposal, so after a
        // rewrite it demonstrably tests the pre-edit claim.
        summary_md:
          finding.tested_claim_md !== undefined
            ? TEACHING_BRIEF_OUTCOME_COPY.AWAITING_ANSWER_REWRITTEN
            : TEACHING_BRIEF_OUTCOME_COPY.AWAITING_ANSWER,
      },
    };
  }
  return null;
}

async function logAcceptedWithoutProbe(db: Db, now: Date): Promise<void> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_FINDING_TTL_MS);
  // Status, kind, TTL, and missing-probe detection share one bounded query; corrections
  // fold in one more batch below.
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
        // Warn only on invalid result pairs: displayable canonical outcomes and the
        // intentional terminal non-evidence disposition are both legitimate rows.
        sql`NOT (${event.subject_kind} = 'question'
          AND (${canonicalProbeResolutionOutcomeSql()}
            OR ${terminalNonEvidenceProbeResolutionOutcomeSql()}))`,
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
        // Only the latest correction decides (last-write-wins), so a corrected-then-
        // restored proposal stays eligible. A malformed latest supersede fails closed;
        // getCorrectionStatuses below remains the authoritative second gate.
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
      // A `finding` is still PENDING — no accept, therefore no rewrite and no probe;
      // `tested_claim_md` is structurally absent here (locked by the wire schema).
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
      summary_md: TEACHING_BRIEF_OUTCOME_COPY.AWAITING_DECISION,
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
