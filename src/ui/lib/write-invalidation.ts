// Single owner of "which cached reads a write makes stale". These reads span shell, notes,
// knowledge, copilot and the root shell sidebar, so the keys live here rather than in one
// capability: a capability → capability value import would add a boundary-ratchet pair.
// Callers hang these on a mutation's onSuccess/onSettled; the returned promise settles once
// every active read has refetched.

import type { QueryClient, QueryKey } from '@tanstack/react-query';

export const queryKeys = {
  workbenchSummary: ['workbench-summary'],
  overnightDigest: ['overnight-digest'],
  prepDeskProbes: ['prep-desk-probes'],
  prepDeskConjectures: ['prep-desk-conjectures'],
  teachingBrief: ['teaching-brief'],
  workbenchAiChanges: ['workbench-ai-changes'],
  pendingProposals: ['proposals', 'pending'],
  decisionProposals: ['proposals', 'pending', 'decision'],
  observationProposals: ['proposals', 'pending', 'observation-preview'],
  autoAppliedProposals: ['proposals', 'auto-applied'],
  notePages: ['note-page'],
  notePage: (artifactId: string) => ['note-page', artifactId],
  noteAiChangesAll: ['note-ai-changes'],
  noteAiChanges: (artifactId: string) => ['note-ai-changes', artifactId],
  knowledgeEdges: ['knowledge-edges'],
  knowledgeEdgeProposals: ['knowledge-edge-proposals'],
} as const;

type Invalidation = { key: QueryKey; refetch?: 'none' };

// Reads whose content depends on a proposal's applied effect, beyond the workbench surfaces.
function proposalEffectKeys(kind: string): Invalidation[] {
  if (kind === 'knowledge_edge') {
    return [{ key: queryKeys.knowledgeEdges }, { key: queryKeys.knowledgeEdgeProposals }];
  }
  if (kind === 'note_update') {
    return [{ key: queryKeys.notePages }, { key: queryKeys.noteAiChangesAll }];
  }
  return [];
}

async function invalidate(qc: QueryClient, targets: readonly Invalidation[]): Promise<void> {
  await Promise.all(
    targets.map(({ key, refetch }) =>
      qc.invalidateQueries({ queryKey: key, refetchType: refetch ?? 'active' }),
    ),
  );
}

/** accept / dismiss / reverse / change_type on any proposal, from any surface. */
export function invalidateAfterProposalDecision(
  qc: QueryClient,
  { kind }: { kind: string },
): Promise<void> {
  return invalidate(qc, [
    { key: queryKeys.workbenchSummary },
    // A mounted inbox keeps the decided card in place; an active refetch of the paged decision
    // query would drop it and replay every loaded page. Mark stale so the next mount reloads.
    { key: queryKeys.pendingProposals, refetch: 'none' },
    // The auto-applied block carries the global decision-rate breaker.
    { key: queryKeys.autoAppliedProposals },
    { key: queryKeys.overnightDigest },
    { key: queryKeys.prepDeskConjectures },
    // Accepting a conjecture serves a probe into the 待你试做 queue.
    { key: queryKeys.prepDeskProbes },
    { key: queryKeys.teachingBrief },
    ...proposalEffectKeys(kind),
  ]);
}

/**
 * Retract of an auto-applied proposal. It turns stale, never pending, so neither the decision
 * inbox nor the sidebar count moves; only the auto-applied block changes.
 */
export function invalidateAfterProposalRetract(qc: QueryClient): Promise<void> {
  return invalidate(qc, [{ key: queryKeys.autoAppliedProposals }]);
}

/** Undo of one AI revision on a note, from the workbench strip or the note reader. */
export function invalidateAfterAiChangeUndo(
  qc: QueryClient,
  { artifactId }: { artifactId: string },
): Promise<void> {
  return invalidate(qc, [
    // Shared by the note reader and the copilot hero block.
    { key: queryKeys.notePage(artifactId) },
    { key: queryKeys.noteAiChanges(artifactId) },
    { key: queryKeys.workbenchAiChanges },
  ]);
}

/** Teaching brief outcome acknowledged. */
export function invalidateAfterTeachingBriefAck(qc: QueryClient): Promise<void> {
  return invalidate(qc, [
    { key: queryKeys.teachingBrief },
    { key: queryKeys.overnightDigest },
    { key: queryKeys.prepDeskProbes },
  ]);
}

/**
 * Probe answer recorded. The 待你试做 queue is not refreshed here: the answered card stays
 * on screen with its verdict until the learner dismisses it.
 */
export function invalidateAfterProbeAnswer(qc: QueryClient): Promise<void> {
  return invalidate(qc, [{ key: queryKeys.teachingBrief }]);
}

/** Learner dismissed an answered probe's verdict; the probe now leaves the queue. */
export function invalidateAfterProbeVerdictDismissed(qc: QueryClient): Promise<void> {
  return invalidate(qc, [{ key: queryKeys.prepDeskProbes }]);
}
