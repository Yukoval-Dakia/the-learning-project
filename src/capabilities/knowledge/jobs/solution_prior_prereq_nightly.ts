// Nightly, propose-only. Admitted solution priors that agree on the same
// prerequisite pair become one knowledge-edge suggestion. Live edges, a pending
// twin, and a dismiss cooldown are refused by the existing edge writer, so this
// job never accepts and never re-opens a pair the owner already turned down.

import type { Job } from 'pg-boss';
import { writeKnowledgeEdgeProposal } from '@/capabilities/knowledge/server/edge-proposal-write';
import { LEARNER_SUMMARY_MAX_CHARS } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { learnerSummaryIfAllowed } from '@/kernel/proposals/learner-summary';
import {
  type PrerequisiteEdgeSupport,
  loadAdmittedPriorPrerequisiteEdges,
} from '@/kernel/read-models/admitted-prior-prerequisites';

const RELATION_PREREQUISITE = 'prerequisite' as const;
const ACTOR_REF = 'solution_prior';
const EVIDENCE_QUESTION_CAP = 8;

export interface SolutionPriorPrereqResult {
  supported_pairs: number;
  proposed: number;
  skipped_duplicate_pending: number;
  skipped_cooldown: number;
  skipped_duplicate_edge: number;
  skipped_rubric: number;
  skipped_other: number;
}

function emptyResult(): SolutionPriorPrereqResult {
  return {
    supported_pairs: 0,
    proposed: 0,
    skipped_duplicate_pending: 0,
    skipped_cooldown: 0,
    skipped_duplicate_edge: 0,
    skipped_rubric: 0,
    skipped_other: 0,
  };
}

function learnerLine(fromName: string, toName: string): string | undefined {
  const fixed = '「」是「」的先修'.length;
  const budget = LEARNER_SUMMARY_MAX_CHARS - fixed;
  let from = fromName;
  let to = toName;
  if (from.length + to.length > budget) {
    const fromRoom = Math.max(1, Math.min(from.length, Math.floor(budget / 2)));
    const toRoom = Math.max(1, budget - fromRoom);
    from = from.slice(0, fromRoom);
    to = to.slice(0, toRoom);
  }
  return learnerSummaryIfAllowed(`「${from}」是「${to}」的先修`);
}

function reasonFor(edge: PrerequisiteEdgeSupport): string {
  const text = `${edge.questionIds.length} 道已准入题把「${edge.fromName}」列为「${edge.toName}」的先修。`;
  return text.length <= 4000 ? text : text.slice(0, 4000);
}

export async function runSolutionPriorPrerequisiteProposals(
  db: Db,
): Promise<SolutionPriorPrereqResult> {
  const edges = await loadAdmittedPriorPrerequisiteEdges(db);
  const result = emptyResult();
  result.supported_pairs = edges.length;
  for (const edge of edges) {
    const learnerSummary = learnerLine(edge.fromName, edge.toName);
    const written = await writeKnowledgeEdgeProposal(db, {
      validate: 'rubric',
      change: {
        edge_op: 'create',
        from_knowledge_id: edge.fromKnowledgeId,
        to_knowledge_id: edge.toKnowledgeId,
        relation_type: RELATION_PREREQUISITE,
        weight: 1,
      },
      ...(learnerSummary !== undefined ? { learner_summary: learnerSummary } : {}),
      reason_md: reasonFor(edge),
      evidence_refs: edge.questionIds.slice(0, EVIDENCE_QUESTION_CAP).map((id) => ({
        kind: 'question' as const,
        id,
      })),
      actor_ref: ACTOR_REF,
      created_at: new Date(),
    });
    switch (written.status) {
      case 'proposed':
        result.proposed += 1;
        break;
      case 'skipped:duplicate_pending':
        result.skipped_duplicate_pending += 1;
        break;
      case 'skipped:cooldown':
        result.skipped_cooldown += 1;
        break;
      case 'skipped:duplicate_live_edge':
        result.skipped_duplicate_edge += 1;
        break;
      case 'skipped:rubric_rejected':
        result.skipped_rubric += 1;
        break;
      default:
        result.skipped_other += 1;
        break;
    }
  }
  return result;
}

export function buildSolutionPriorPrereqNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<Record<string, unknown>> {
  return async () => {
    const result = await runSolutionPriorPrerequisiteProposals(db);
    console.log('[solution_prior_prereq_nightly] result', result);
    return { ...result };
  };
}
