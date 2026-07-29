import { type EvidenceCell, conjectureKey } from '@/capabilities/agency/server/conjecture/evidence';
import {
  type EffectiveProbeResultStatus,
  getEffectiveProbeResultStatuses,
} from '@/capabilities/agency/server/conjecture/probe-evidence';
import { PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import { AiProposalPayload } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { type CorrectionStatus, getCorrectionStatuses } from '@/kernel/events';
import type { FailureAttempt } from '@/server/events/queries';
import { and, eq, inArray, sql } from 'drizzle-orm';

export const CONJECTURE_DISMISS_COOLDOWN_DAYS = 30;
export const CONJECTURE_REOPEN_FAILURE_FLOOR = 2;

type ConjectureHistoryCandidate = Pick<EvidenceCell, 'key' | 'cause_category' | 'knowledge_id'>;

export interface ConjectureHistory {
  latest_decision: 'accept' | 'dismiss' | null;
  latest_decision_at: Date | null;
  latest_accept_at: Date | null;
  latest_terminal_at: Date | null;
  prior_claim_md: string | null;
}

export type LoadConjectureHistoryFn = (
  db: Db,
  candidates: readonly ConjectureHistoryCandidate[],
) => Promise<Map<string, ConjectureHistory>>;

const CONJECTURE_HISTORY_QUERY_CHUNK_SIZE = 500;

function toPlainRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compareNewest(
  left: { id: string; created_at: Date },
  right: { id: string; created_at: Date },
): number {
  return right.created_at.getTime() - left.created_at.getTime() || right.id.localeCompare(left.id);
}

function emptyConjectureHistory(): ConjectureHistory {
  return {
    latest_decision: null,
    latest_decision_at: null,
    latest_accept_at: null,
    latest_terminal_at: null,
    prior_claim_md: null,
  };
}

async function loadCorrectionStatusesChunked(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, CorrectionStatus>> {
  const statuses = new Map<string, CorrectionStatus>();
  for (let offset = 0; offset < ids.length; offset += CONJECTURE_HISTORY_QUERY_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + CONJECTURE_HISTORY_QUERY_CHUNK_SIZE);
    for (const [id, status] of await getCorrectionStatuses(db, chunk)) statuses.set(id, status);
  }
  return statuses;
}

/**
 * Load only history relevant to tonight's evidence candidates. Proposal/rate/result
 * joins remain bounded by those KC ids, while correction-aware terminal validation
 * reuses the Agency-owned probe evidence reader.
 */
export async function loadConjectureHistory(
  db: Db,
  candidates: readonly ConjectureHistoryCandidate[],
): Promise<Map<string, ConjectureHistory>> {
  const candidateKeys = new Set(candidates.map((candidate) => candidate.key));
  const knowledgeIds = [...new Set(candidates.map((candidate) => candidate.knowledge_id))];
  if (knowledgeIds.length === 0) return new Map();

  const proposalRows: Array<{
    id: string;
    payload: unknown;
    subject_id: string;
  }> = [];
  for (
    let offset = 0;
    offset < knowledgeIds.length;
    offset += CONJECTURE_HISTORY_QUERY_CHUNK_SIZE
  ) {
    const chunk = knowledgeIds.slice(offset, offset + CONJECTURE_HISTORY_QUERY_CHUNK_SIZE);
    proposalRows.push(
      ...(await db
        .select({
          id: event.id,
          payload: event.payload,
          subject_id: event.subject_id,
        })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:proposal'),
            eq(event.subject_kind, 'mind_model'),
            inArray(event.subject_id, chunk),
          ),
        )),
    );
  }
  const proposalCorrectionStatuses = await loadCorrectionStatusesChunked(
    db,
    proposalRows.map((row) => row.id),
  );
  const proposalById = new Map<string, { key: string; claim_md: string }>();
  for (const row of proposalRows) {
    if (proposalCorrectionStatuses.get(row.id)?.state !== 'active') continue;
    const parsed = AiProposalPayload.safeParse(toPlainRecord(row.payload).ai_proposal);
    if (
      !parsed.success ||
      parsed.data.kind !== 'conjecture' ||
      parsed.data.target.subject_kind !== 'mind_model'
    ) {
      continue;
    }
    const change = parsed.data.proposed_change;
    if (
      parsed.data.target.subject_id !== change.knowledge_id ||
      row.subject_id !== change.knowledge_id
    ) {
      continue;
    }
    const key = conjectureKey(change.cause_category, change.knowledge_id);
    if (!candidateKeys.has(key)) continue;
    proposalById.set(row.id, {
      key,
      claim_md: change.claim_md.trim(),
    });
  }
  const proposalIds = [...proposalById.keys()];
  if (proposalIds.length === 0) return new Map();

  const rateRows: Array<{
    id: string;
    caused_by_event_id: string | null;
    payload: unknown;
    created_at: Date;
  }> = [];
  const terminalRows: Array<{
    id: string;
    payload: unknown;
    created_at: Date;
  }> = [];
  for (let offset = 0; offset < proposalIds.length; offset += CONJECTURE_HISTORY_QUERY_CHUNK_SIZE) {
    const chunk = proposalIds.slice(offset, offset + CONJECTURE_HISTORY_QUERY_CHUNK_SIZE);
    const [rateChunk, terminalChunk] = await Promise.all([
      db
        .select({
          id: event.id,
          caused_by_event_id: event.caused_by_event_id,
          payload: event.payload,
          created_at: event.created_at,
        })
        .from(event)
        .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, chunk))),
      db
        .select({
          id: event.id,
          payload: event.payload,
          created_at: event.created_at,
        })
        .from(event)
        .where(
          and(
            eq(event.action, PROBE_RESULT_ACTION),
            eq(event.subject_kind, 'question'),
            inArray(sql<string>`${event.payload}->>'conjecture_event_id'`, chunk),
            inArray(sql<string>`${event.payload}->>'resolution'`, ['confirmed', 'retired']),
          ),
        ),
    ]);
    rateRows.push(...rateChunk);
    terminalRows.push(...terminalChunk);
  }

  const rateCorrectionStatuses = await loadCorrectionStatusesChunked(
    db,
    rateRows.map((row) => row.id),
  );
  const activeRateRows = rateRows
    .filter((row) => rateCorrectionStatuses.get(row.id)?.state === 'active')
    .sort(compareNewest);
  const latestRateByProposal = new Map<string, (typeof rateRows)[number]>();
  const historyByKey = new Map<string, ConjectureHistory>();
  for (const row of activeRateRows) {
    const proposalId = row.caused_by_event_id;
    if (!proposalId) continue;
    const proposal = proposalById.get(proposalId);
    if (!proposal) continue;
    if (!latestRateByProposal.has(proposalId)) latestRateByProposal.set(proposalId, row);
    const rating = toPlainRecord(row.payload).rating;
    if (rating !== 'accept' && rating !== 'dismiss') continue;
    const history = historyByKey.get(proposal.key) ?? emptyConjectureHistory();
    if (history.latest_decision === null) {
      history.latest_decision = rating;
      history.latest_decision_at = row.created_at;
    }
    if (rating === 'accept' && history.latest_accept_at === null) {
      const correctedClaim = toPlainRecord(row.payload).corrected_claim_md;
      history.latest_accept_at = row.created_at;
      history.prior_claim_md =
        typeof correctedClaim === 'string' && correctedClaim.trim().length > 0
          ? correctedClaim.trim()
          : proposal.claim_md;
    }
    historyByKey.set(proposal.key, history);
  }

  const effectiveTerminalStatuses = new Map<string, EffectiveProbeResultStatus>();
  for (
    let offset = 0;
    offset < terminalRows.length;
    offset += CONJECTURE_HISTORY_QUERY_CHUNK_SIZE
  ) {
    const chunk = terminalRows
      .slice(offset, offset + CONJECTURE_HISTORY_QUERY_CHUNK_SIZE)
      .map((row) => row.id);
    for (const [id, status] of await getEffectiveProbeResultStatuses(db, chunk, {
      validateDirectChain: true,
    })) {
      effectiveTerminalStatuses.set(id, status);
    }
  }
  terminalRows.sort(compareNewest);
  for (const row of terminalRows) {
    if (effectiveTerminalStatuses.get(row.id) !== 'active') continue;
    const proposalId = toPlainRecord(row.payload).conjecture_event_id;
    if (typeof proposalId !== 'string') continue;
    const proposal = proposalById.get(proposalId);
    const latestRate = latestRateByProposal.get(proposalId);
    if (!proposal || !latestRate || toPlainRecord(latestRate.payload).rating !== 'accept') {
      continue;
    }
    const history = historyByKey.get(proposal.key) ?? emptyConjectureHistory();
    if (history.latest_terminal_at === null) history.latest_terminal_at = row.created_at;
    historyByKey.set(proposal.key, history);
  }
  return historyByKey;
}

export function applyConjectureHistoryGate<T extends EvidenceCell>(
  cells: readonly T[],
  failures: readonly FailureAttempt[],
  historyByKey: ReadonlyMap<string, ConjectureHistory>,
  now: Date,
): { cells: T[]; priorClaimMdByKey: Map<string, string> } {
  const failureCreatedAtById = new Map(
    failures.map((failure) => [failure.attempt_event_id, failure.created_at] as const),
  );
  const priorClaimMdByKey = new Map<string, string>();
  const cooldownCutoff = new Date(
    now.getTime() - CONJECTURE_DISMISS_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  );

  const eligible = cells.filter((cell) => {
    const history = historyByKey.get(cell.key);
    if (!history) return true;
    if (
      history.latest_decision === 'dismiss' &&
      history.latest_decision_at !== null &&
      history.latest_decision_at > cooldownCutoff
    ) {
      return false;
    }

    // An accepted conjecture with no terminal result is still being tested. A newer
    // accept after an older terminal likewise represents an active reopened version.
    if (
      history.latest_decision === 'accept' &&
      history.latest_accept_at !== null &&
      (history.latest_terminal_at === null || history.latest_accept_at > history.latest_terminal_at)
    ) {
      return false;
    }
    if (history.latest_terminal_at === null) return true;
    const terminalAt = history.latest_terminal_at;

    const freshFailureCount = new Set(
      cell.evidence_event_ids.filter((eventId) => {
        const createdAt = failureCreatedAtById.get(eventId);
        return createdAt !== undefined && createdAt > terminalAt;
      }),
    ).size;
    if (
      freshFailureCount < CONJECTURE_REOPEN_FAILURE_FLOOR ||
      history.prior_claim_md === null ||
      history.prior_claim_md.length === 0
    ) {
      return false;
    }
    return true;
  });
  for (const cell of eligible) {
    const priorClaimMd = historyByKey.get(cell.key)?.prior_claim_md;
    if (priorClaimMd) priorClaimMdByKey.set(cell.key, priorClaimMd);
  }
  return { cells: eligible, priorClaimMdByKey };
}
