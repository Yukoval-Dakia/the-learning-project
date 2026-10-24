// Knowledge-edge proposal pipeline. AI proposes edges as propose events; a user
// accept applies the mutation. This deliberately uses one structured model call
// rather than the interactive review task's streaming tool loop, because it runs
// unattended at night.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { validateProposalQuality } from '@/capabilities/knowledge/server/rubric-validator';
import {
  EdgeProposalSchema,
  type EdgeProposalSchemaT,
  parseEdgeProposeOutput,
} from '@/capabilities/knowledge/tasks/knowledge-tasks';
import type { ActivityRefT } from '@/core/schema/activity';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import { type TopologyEdge, checkEdgeTopology } from '@/core/topology-gate';
import type { Db, Tx } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { writeRetryableAiFailureLedger } from '@/server/ai/failure-ledger';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import type { Env } from '@/server/memory/client';
import type { SubjectProfile } from '@/subjects/profile';
import {
  type EdgeCandidate,
  type EdgeNeighbor,
  type EdgeProviderAttemptOptions,
  type EdgeReconcileDecision,
  applyConfidenceThreshold,
  isEdgeReconcileInvariantError,
  judgeEdgeReconcile,
} from './edge-reconcile';
import {
  insertEdgePlannedRows,
  makeEdgePlannedRow,
  markEdgeReconcileApplied,
} from './edge-reconcile-store';
import { archiveKnowledgeEdgeFromEvents, createKnowledgeEdge } from './edges';
import { loadTreeSnapshot } from './tree';

export type { EdgeProposeOutput } from '@/capabilities/knowledge/tasks/knowledge-tasks';
export type { EdgeProposalSchemaT };
export { EdgeProposalSchema, parseEdgeProposeOutput };

export type RunTaskFn = TaskTextRunFn;

// Defaults to the live judge; tests inject a deterministic stub to exercise both
// the supersede and KEEP_BOTH wiring without a model call.
export type JudgeEdgeReconcileFn = (
  candidate: EdgeCandidate,
  neighbors: EdgeNeighbor[],
) => Promise<EdgeReconcileDecision>;

export interface RunEdgeProposeAndWriteParams {
  db: Db;
  recentFailures: FailureAttempt[];
  runTaskFn: RunTaskFn;
  env?: Env;
  subjectProfile?: SubjectProfile;
  /** Test override; production uses the live judge with `env`. */
  judgeReconcileFn?: JudgeEdgeReconcileFn;
  providerAttempt?: EdgeProviderAttemptOptions;
  pgbossJobId?: string;
}

export interface RunEdgeProposeAndWriteResult {
  /** False only when the catch-all swallowed an error; the nightly watermark checks it. */
  ok: boolean;
  /** True once the model task was actually called, not merely reached. */
  llm_attempted: boolean;
  proposed: number;
  skipped_self_loop: number;
  skipped_unknown_node: number;
  skipped_duplicate_edge: number;
  skipped_duplicate_pending: number;
  /** Rubric failures: a marked propose event is kept for audit, not a live proposal. */
  folded_rubric_rejected: number;
  /** Topology hard rejects (redundancy, cycles, direction): folded like rubric failures. */
  folded_topology_rejected: number;
  /** Edges still proposed live, with a warning marker for downstream downweighting. */
  warned_transitive_redundancy: number;
  /** Supersede recommendations awaiting user approval, never autonomous mutations. */
  reconcile_superseded: number;
}

const EMPTY_RESULT: RunEdgeProposeAndWriteResult = {
  ok: true,
  llm_attempted: false,
  proposed: 0,
  skipped_self_loop: 0,
  skipped_unknown_node: 0,
  skipped_duplicate_edge: 0,
  skipped_duplicate_pending: 0,
  folded_rubric_rejected: 0,
  folded_topology_rejected: 0,
  warned_transitive_redundancy: 0,
  reconcile_superseded: 0,
};

/**
 * Build input, call the propose task, validate, and write propose events. Errors
 * are swallowed and logged so a nightly cron is not stopped by one bad batch.
 */
export async function runEdgeProposeAndWrite(
  params: RunEdgeProposeAndWriteParams,
): Promise<RunEdgeProposeAndWriteResult> {
  // Declared outside try so the catch path can still report whether the model ran.
  let llmAttempted = false;
  try {
    const tree = await loadTreeSnapshot(params.db);
    // Empty tree is a genuine "nothing to do" night, before any model call.
    if (tree.length === 0) return { ...EMPTY_RESULT };

    const existingEdges = await params.db
      .select({
        id: knowledge_edge.id,
        from_knowledge_id: knowledge_edge.from_knowledge_id,
        to_knowledge_id: knowledge_edge.to_knowledge_id,
        relation_type: knowledge_edge.relation_type,
        archived_at: knowledge_edge.archived_at,
      })
      .from(knowledge_edge);

    const existingEdgeKey = new Set(
      existingEdges.map((e) => edgeKey(e.from_knowledge_id, e.to_knowledge_id, e.relation_type)),
    );

    // The reconcile prompt sees names, never ids.
    const nodeNameById = new Map(tree.map((n) => [n.id, n.name]));

    // Topology checks use live edges only. Dedup deliberately uses the full set,
    // because an archived row still occupies its unique (from, to, type) slot.
    const liveTopologyEdges: TopologyEdge[] = existingEdges
      .filter((e) => e.archived_at === null)
      .map((e) => ({
        from_knowledge_id: e.from_knowledge_id,
        to_knowledge_id: e.to_knowledge_id,
        relation_type: e.relation_type,
      }));

    // Live edges with ids for neighbor lookup. Kept in memory so later candidates
    // reconcile against the batch-evolved mesh.
    type LiveEdge = {
      edge_id: string;
      from_knowledge_id: string;
      to_knowledge_id: string;
      relation_type: string;
    };
    const liveNeighborEdges: LiveEdge[] = existingEdges
      .filter((e) => e.archived_at === null)
      .map((e) => ({
        edge_id: e.id,
        from_knowledge_id: e.from_knowledge_id,
        to_knowledge_id: e.to_knowledge_id,
        relation_type: e.relation_type,
      }));

    const pendingEdgeKey = await loadPendingEdgeProposalKeys(params.db);
    // At most one pending supersede recommendation per old edge per batch.
    const pendingSupersededEdgeIds = new Set<string>();

    const input = {
      tree_snapshot: tree.map((n) => ({
        id: n.id,
        name: n.name,
        parent_id: n.parent_id,
        effective_domain: n.effective_domain,
      })),
      // Keep the prompt shape stable; archived_at is for the gate, not the model.
      existing_edges: existingEdges.map((e) => ({
        from_knowledge_id: e.from_knowledge_id,
        to_knowledge_id: e.to_knowledge_id,
        relation_type: e.relation_type,
      })),
      recent_failures: params.recentFailures.map((fa) => {
        const cause = effectiveCauseForFailureAttempt(fa);
        return {
          attempt_event_id: fa.attempt_event_id,
          referenced_knowledge_ids: fa.referenced_knowledge_ids,
          cause: cause?.primary_category ?? null,
          cause_source: cause?.source ?? null,
          analysis_md: cause?.analysis_md ?? cause?.user_notes ?? null,
        };
      }),
    };

    // Set immediately before the call so both success and the catch path report it.
    llmAttempted = true;
    const result = await params.runTaskFn('KnowledgeEdgeProposeTask', input, {
      subjectProfile: params.subjectProfile,
    });
    const parsed = parseEdgeProposeOutput(result.text);

    const validNodeIds = new Set(tree.map((n) => n.id));
    const treeParentLinks = tree.flatMap((node) =>
      node.parent_id ? [{ child_id: node.id, parent_id: node.parent_id }] : [],
    );
    // Every exit derives from the local flag, so a moved assignment cannot drift.
    const stats = { ...EMPTY_RESULT, llm_attempted: llmAttempted };

    for (const p of parsed.proposals) {
      if (p.from_knowledge_id === p.to_knowledge_id) {
        stats.skipped_self_loop += 1;
        continue;
      }
      if (!validNodeIds.has(p.from_knowledge_id) || !validNodeIds.has(p.to_knowledge_id)) {
        stats.skipped_unknown_node += 1;
        continue;
      }
      const key = edgeKey(p.from_knowledge_id, p.to_knowledge_id, p.relation_type);
      if (existingEdgeKey.has(key)) {
        stats.skipped_duplicate_edge += 1;
        continue;
      }
      if (pendingEdgeKey.has(key)) {
        stats.skipped_duplicate_pending += 1;
        continue;
      }

      // Scope evidence per edge: attaching the whole batch would let one edge borrow
      // another's failures. Empty scope takes the evidence-missing path and folds.
      const endpointTouchingFailures = params.recentFailures.filter((failure) => {
        const effectiveRefs = new Set([
          ...failure.referenced_knowledge_ids,
          ...(failure.judge?.referenced_knowledge_ids ?? []),
        ]);
        return effectiveRefs.has(p.from_knowledge_id) || effectiveRefs.has(p.to_knowledge_id);
      });
      const proposalPayload = {
        kind: 'knowledge_edge' as const,
        target: { subject_kind: 'knowledge_edge' as const, subject_id: null },
        reason_md: p.reasoning,
        evidence_refs: endpointTouchingFailures.map((failure) => ({
          kind: 'event' as const,
          id: failure.attempt_event_id,
        })),
        proposed_change: {
          from_knowledge_id: p.from_knowledge_id,
          to_knowledge_id: p.to_knowledge_id,
          relation_type: p.relation_type,
          weight: p.weight,
        },
        cooldown_key: `knowledge_edge:${key}`,
      };

      const proposalWriteBase = {
        actor_ref: 'dreaming' as const,
        outcome: 'success' as const,
        task_run_id: result.task_run_id ?? null,
        cost_usd: result.cost_usd,
        created_at: new Date(),
      };

      const eventPayloadBase = {
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type,
        weight: p.weight,
        reasoning: p.reasoning,
      };

      // Structural gate: tree redundancy, cycles, direction, and transitive
      // redundancy. Includes earlier batch edges so combined cycles are caught.
      const topology = checkEdgeTopology(
        {
          from_knowledge_id: p.from_knowledge_id,
          to_knowledge_id: p.to_knowledge_id,
          relation_type: p.relation_type,
        },
        liveTopologyEdges,
        treeParentLinks,
      );

      if (topology.status === 'reject') {
        // Fold like a rubric reject: keep a marked event for audit, no live proposal.
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: { ...proposalPayload, evidence_refs: [] },
          event_override: {
            action: 'propose',
            subject_kind: 'knowledge_edge',
            payload: {
              ...eventPayloadBase,
              topology_verdict: {
                status: 'reject',
                gate: topology.gate,
                reason: topology.reason,
              },
            },
          },
        });
        pendingEdgeKey.add(key);
        stats.folded_topology_rejected += 1;
        continue;
      }

      const verdict = await validateProposalQuality(
        parseAiProposalPayload(proposalPayload),
        params.db,
        { isAgent: true, actorRef: 'dreaming' },
      );

      if (!verdict.ok) {
        // Folded, not dropped: keep a marked event and exclude it from pending dedup.
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: proposalPayload,
          event_override: {
            action: 'propose',
            subject_kind: 'knowledge_edge',
            payload: {
              from_knowledge_id: p.from_knowledge_id,
              to_knowledge_id: p.to_knowledge_id,
              relation_type: p.relation_type,
              weight: p.weight,
              reasoning: p.reasoning,
              rubric_verdict: { ok: false, gate: verdict.gate, reason: verdict.reason },
            },
          },
        });
        // Suppress an immediate duplicate within this batch.
        pendingEdgeKey.add(key);
        stats.folded_rubric_rejected += 1;
        continue;
      }

      // Reconcile only after both gates pass. Parse/network/low-confidence degrade
      // to keep-both; an uncertain judge never causes a destructive write.
      const neighbors: EdgeNeighbor[] = liveNeighborEdges
        .filter((e) => !pendingSupersededEdgeIds.has(e.edge_id))
        .filter(
          (e) =>
            e.from_knowledge_id === p.from_knowledge_id ||
            e.to_knowledge_id === p.from_knowledge_id ||
            e.from_knowledge_id === p.to_knowledge_id ||
            e.to_knowledge_id === p.to_knowledge_id,
        )
        .map((e, index) => ({
          index,
          edge_id: e.edge_id,
          from_knowledge_id: e.from_knowledge_id,
          to_knowledge_id: e.to_knowledge_id,
          relation_type: e.relation_type as EdgeNeighbor['relation_type'],
          from_name: nodeNameById.get(e.from_knowledge_id),
          to_name: nodeNameById.get(e.to_knowledge_id),
        }));

      const candidateForReconcile: EdgeCandidate = {
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type as EdgeCandidate['relation_type'],
        from_name: nodeNameById.get(p.from_knowledge_id),
        to_name: nodeNameById.get(p.to_knowledge_id),
        reasoning: p.reasoning,
      };

      // The ring only understands the five core relation types; experimental ones
      // skip it and keep both.
      const isCoreRelation = CORE_RELATION_TYPES.has(p.relation_type);

      let decision: EdgeReconcileDecision | null = null;
      if (isCoreRelation && neighbors.length > 0) {
        try {
          const judge =
            params.judgeReconcileFn ??
            ((cand: EdgeCandidate, nbrs: EdgeNeighbor[]) =>
              judgeEdgeReconcile(cand, nbrs, {
                env: params.env,
                providerAttempt: params.providerAttempt ?? {
                  db: params.db,
                  caller: 'worker',
                  deadlineAt: new Date(Date.now() + 65_000),
                },
              }));
          // Re-apply the threshold so an injected judge cannot bypass the
          // no-destructive-supersede-on-low-confidence rule.
          decision = applyConfidenceThreshold(await judge(candidateForReconcile, neighbors));
        } catch (err) {
          if (isEdgeReconcileInvariantError(err)) throw err;
          // Safe-degrade. Log only the message: a parse error carries the raw model
          // response, which must stay out of console logs.
          console.warn(
            'runEdgeProposeAndWrite: reconcile judge failed, KEEP_BOTH degrade',
            err instanceof Error ? err.message : String(err),
          );
          decision = null;
        }
      }

      if (decision?.action === 'SUPERSEDE' && decision.superseded_edge_id) {
        // A stale id that no longer matches a tracked live edge degrades to keep-both.
        const supersededId = decision.superseded_edge_id;
        const supersededEdge = liveNeighborEdges.find((e) => e.edge_id === supersededId);
        // A correction event needs at least one ref; if none can be formed, keep both.
        const affectedRefs: ActivityRefT[] = endpointTouchingFailures.map((failure) => ({
          kind: 'question',
          id: failure.question_id,
        }));

        if (supersededEdge && affectedRefs.length > 0) {
          // Advisory: persist a pending proposal; replacement/archive need explicit accept.
          await writeAiProposal(params.db, {
            ...proposalWriteBase,
            payload: {
              ...proposalPayload,
              target: { subject_kind: 'knowledge_edge', subject_id: supersededId },
              proposed_change: {
                ...proposalPayload.proposed_change,
                edge_op: 'supersede' as const,
                archive_edge_id: supersededId,
                supersede_confidence: decision.confidence,
                supersede_neighbor_index: decision.neighbor_index,
                supersede_affected_refs: affectedRefs,
              },
              cooldown_key: `knowledge_edge_supersede:${supersededId}:${key}`,
            },
          });
          pendingSupersededEdgeIds.add(supersededId);
          pendingEdgeKey.add(key);
          stats.reconcile_superseded += 1;
          continue;
        }
        // Missing edge or refs falls through to keep-both.
      }

      // A warning still proposes the edge live, but marks it so downstream can
      // downweight the redundant direct edge. The clean path stays unmarked.
      if (topology.status === 'warn') {
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: proposalPayload,
          event_override: {
            action: 'propose',
            subject_kind: 'knowledge_edge',
            payload: {
              ...eventPayloadBase,
              topology_verdict: {
                status: 'warn',
                gate: topology.gate,
                reason: topology.reason,
              },
            },
          },
        });
        stats.warned_transitive_redundancy += 1;
      } else {
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: proposalPayload,
        });
      }
      pendingEdgeKey.add(key);
      // Only live-path edges enter the batch mesh; folded/pending proposals are not
      // rows, and adding them would create false cycles.
      liveTopologyEdges.push({
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type,
      });
      stats.proposed += 1;
    }

    return stats;
  } catch (err) {
    if (isEdgeReconcileInvariantError(err)) throw err;
    // Message only: the error may carry a raw model response.
    console.error(
      'runEdgeProposeAndWrite: failed (no proposals written)',
      err instanceof Error ? err.message : String(err),
    );
    await writeRetryableAiFailureLedger(params.db, 'KnowledgeEdgeProposeTask');
    // Never advance the nightly watermark on a swallowed error; report whether the
    // model ran so a pre-model failure is not mistaken for an idle night.
    return { ...EMPTY_RESULT, ok: false, llm_attempted: llmAttempted };
  }
}

function edgeKey(fromId: string, toId: string, relationType: string): string {
  return `${fromId}|${toId}|${relationType}`;
}

// The five core relation types the reconcile ring covers.
const CORE_RELATION_TYPES = new Set<string>([
  'prerequisite',
  'related_to',
  'contrasts_with',
  'applied_in',
  'derived_from',
]);

/**
 * Apply a user-approved supersede inside the caller's transaction: record plan,
 * archive old, create replacement + generate event, write correction, mark applied.
 * The log is audit/provenance, not a replay cursor; double-apply is prevented by
 * the unique edge key and upstream dedup, not deterministic ids.
 */
export async function applyApprovedEdgeSupersede(
  db: Tx,
  opts: {
    candidate: EdgeProposalSchemaT;
    supersededEdgeId: string;
    decision: EdgeReconcileDecision;
    affectedRefs: ActivityRefT[];
    proposeEventId: string;
  },
): Promise<{ edgeId: string; generateEventId: string }> {
  const { candidate: p, supersededEdgeId, decision, affectedRefs, proposeEventId } = opts;
  const now = new Date();

  const logRow = makeEdgePlannedRow({
    candidate_from_knowledge_id: p.from_knowledge_id,
    candidate_to_knowledge_id: p.to_knowledge_id,
    candidate_relation_type: p.relation_type,
    action: 'SUPERSEDE',
    superseded_edge_id: supersededEdgeId,
    confidence: decision.confidence,
    reason: decision.reason,
    llm_raw: { action: decision.action, neighbor_index: decision.neighbor_index },
  });

  const newGenerateEventId = createId();
  const oldArchiveGenerateEventId = createId();
  const correctionEventId = createId();
  await insertEdgePlannedRows(db, [logRow]);

  const archived = await archiveKnowledgeEdgeFromEvents(db, supersededEdgeId, {
    event_id: oldArchiveGenerateEventId,
    caused_by_event_id: proposeEventId,
    created_at: now,
    reasoning: `reconcile SUPERSEDE: ${decision.reason}`,
  });
  if (!archived.archived)
    throw new Error(`superseded edge ${supersededEdgeId} is already archived`);

  const newEdgeId = await createKnowledgeEdge(db, {
    generate_event_id: newGenerateEventId,
    from_knowledge_id: p.from_knowledge_id,
    to_knowledge_id: p.to_knowledge_id,
    relation_type: p.relation_type,
    weight: p.weight,
    reasoning: p.reasoning,
    actor_kind: 'user',
    actor_ref: 'self',
    propose_event_id: proposeEventId,
    created_at: now,
  });

  await writeEvent(db, {
    id: correctionEventId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: oldArchiveGenerateEventId,
    outcome: 'success',
    payload: {
      correction_kind: 'supersede',
      replacement_event_id: newGenerateEventId,
      reason_md: `user accepted reconcile supersede: ${decision.reason}`,
      affected_refs: affectedRefs,
    },
    caused_by_event_id: oldArchiveGenerateEventId,
    created_at: now,
  });

  await markEdgeReconcileApplied(db, logRow.id);

  return { edgeId: newEdgeId, generateEventId: newGenerateEventId };
}

/**
 * Keys of pending edge proposals: propose events with no rate event and no
 * terminal fold, so dreaming does not re-propose the same edge nightly.
 */
export async function loadPendingEdgeProposalKeys(db: Db): Promise<Set<string>> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        eq(event.subject_kind, 'knowledge_edge'),
        // Folded proposals are terminal. A topology reject carries no rubric
        // marker, so both predicates are required.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
        sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
      ),
    )
    .orderBy(desc(event.created_at));

  if (proposeRows.length === 0) return new Set();

  const proposeIds = proposeRows.map((r) => r.id);
  const rateRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'knowledge_edge'),
        inArray(event.caused_by_event_id, proposeIds),
      ),
    );
  const ratedProposeIds = new Set(
    rateRows.map((r) => r.caused_by_event_id).filter((id): id is string => id !== null),
  );

  const out = new Set<string>();
  for (const row of proposeRows) {
    if (ratedProposeIds.has(row.id)) continue;
    const p = row.payload as {
      from_knowledge_id?: unknown;
      to_knowledge_id?: unknown;
      relation_type?: unknown;
    };
    if (
      typeof p.from_knowledge_id === 'string' &&
      typeof p.to_knowledge_id === 'string' &&
      typeof p.relation_type === 'string'
    ) {
      out.add(edgeKey(p.from_knowledge_id, p.to_knowledge_id, p.relation_type));
    }
  }
  return out;
}
