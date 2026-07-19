// YUK-706 (P0F/2) — one read-only TeachingBrief projected from the existing
// conjecture proposal → mind-probe question → probe-result event chain.

import {
  PROBE_QUESTION_SOURCE,
  PROBE_RESULT_ACTION,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import type { CauseCategoryT } from '@/core/schema/cause';
import { AiProposalPayload, type ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import {
  type ProposalInboxRow,
  getProposalInboxRow,
  listProposalInboxPage,
} from '@/server/proposals/inbox';
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';

export const TEACHING_BRIEF_FINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TEACHING_BRIEF_OUTCOME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface OutcomeConfirmedTeachingBrief extends TeachingBriefBase {
  state: 'outcome_confirmed';
  expires_at: string;
  prepared_action: { kind: 'none' };
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
  prepared_action: { kind: 'none' };
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

function isCandidateError<T>(result: CandidateResult<T>): result is CandidateError {
  return 'reason' in result;
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
    },
  };
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

async function loadOutcomeBrief(db: Db, now: Date): Promise<TeachingBrief | null> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_OUTCOME_TTL_MS);
  const results = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        gt(event.created_at, lowerBound),
        lte(event.created_at, now),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  for (const result of results) {
    const payload = toRecord(result.payload);
    const resolution = payload.resolution;
    const outcome = payload.outcome;
    if (
      !(
        (resolution === 'confirmed' && outcome === 0) ||
        (resolution === 'retired' && outcome === 1)
      )
    ) {
      warnSkipped('outcome', result.id, 'outcome_resolution_mismatch');
      continue;
    }
    const proposalId = payload.conjecture_event_id;
    if (
      result.subject_kind !== 'question' ||
      typeof result.subject_id !== 'string' ||
      result.subject_id.length === 0
    ) {
      warnSkipped('outcome', result.id, 'result_subject_invalid');
      continue;
    }
    if (
      typeof proposalId !== 'string' ||
      proposalId.length === 0 ||
      result.caused_by_event_id !== proposalId
    ) {
      warnSkipped('outcome', result.id, 'result_provenance_mismatch');
      continue;
    }

    const [probe] = await db
      .select()
      .from(question)
      .where(eq(question.id, result.subject_id))
      .limit(1);
    if (!probe) {
      warnSkipped('outcome', result.id, 'probe_not_found');
      continue;
    }
    const proposalResult = await loadProposalFacts(db, proposalId, 'accepted');
    if (isCandidateError(proposalResult)) {
      warnSkipped('outcome', result.id, proposalResult.reason);
      continue;
    }
    const proposal = proposalResult.value;
    const probeError = validateProbeQuestion(probe, proposal, now);
    if (probeError) {
      warnSkipped('outcome', result.id, probeError);
      continue;
    }

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
      prepared_action: { kind: 'none' as const },
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
        sql`NOT EXISTS (
          SELECT 1 FROM ${event}
          WHERE ${event.subject_kind} = 'question'
            AND ${event.subject_id} = ${question.id}
            AND ${event.action} = ${PROBE_RESULT_ACTION}
        )`,
      ),
    )
    .orderBy(desc(question.created_at), desc(question.id));

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

async function logAcceptedWithoutProbe(db: Db): Promise<void> {
  const { rows } = await listProposalInboxPage(db, {
    status: 'accepted',
    kind: 'conjecture',
  });
  for (const row of rows) {
    const [probe] = await db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.source, PROBE_QUESTION_SOURCE),
          eq(question.source_ref, row.id),
          sql`${question.metadata}->>'conjecture_proposal_id' = ${row.id}`,
        ),
      )
      .limit(1);
    if (!probe) warnSkipped('probe', row.id, 'accepted_without_probe');
  }
}

async function loadFindingBrief(db: Db, now: Date): Promise<TeachingBrief | null> {
  const lowerBound = new Date(now.getTime() - TEACHING_BRIEF_FINDING_TTL_MS);
  const rawConjectures = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:proposal'),
        eq(event.subject_kind, 'mind_model'),
        gt(event.created_at, lowerBound),
        lte(event.created_at, now),
        sql`${event.payload}->'ai_proposal'->>'kind' = 'conjecture'`,
      ),
    );
  for (const raw of rawConjectures) {
    const parsed = AiProposalPayload.safeParse(toRecord(raw.payload).ai_proposal);
    if (!parsed.success || parsed.data.kind !== 'conjecture') {
      warnSkipped('finding', raw.id, 'proposal_payload_invalid');
    }
  }

  const { rows } = await listProposalInboxPage(db, {
    status: 'pending',
    kind: 'conjecture',
  });
  const ranked = rows
    .filter(
      (row) =>
        row.proposed_at.getTime() <= now.getTime() &&
        now.getTime() < row.proposed_at.getTime() + TEACHING_BRIEF_FINDING_TTL_MS,
    )
    .sort((a, b) => {
      const aChange = a.payload.kind === 'conjecture' ? a.payload.proposed_change : null;
      const bChange = b.payload.kind === 'conjecture' ? b.payload.proposed_change : null;
      const aSalience = aChange ? aChange.confidence * aChange.recurrence_count : -1;
      const bSalience = bChange ? bChange.confidence * bChange.recurrence_count : -1;
      if (aSalience !== bSalience) return bSalience - aSalience;
      if (a.proposed_at.getTime() !== b.proposed_at.getTime()) {
        return b.proposed_at.getTime() - a.proposed_at.getTime();
      }
      return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
    });

  for (const row of ranked) {
    const proposalResult = factsFromProposalRow(row, 'pending');
    if (isCandidateError(proposalResult)) {
      warnSkipped('finding', row.id, proposalResult.reason);
      continue;
    }
    const proposal = proposalResult.value;
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
  return null;
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
  const outcome = await loadOutcomeBrief(db, now);
  if (outcome) return { brief: outcome };

  const probe = await loadProbeBrief(db, now);
  if (probe) return { brief: probe };

  await logAcceptedWithoutProbe(db);
  return { brief: await loadFindingBrief(db, now) };
}
