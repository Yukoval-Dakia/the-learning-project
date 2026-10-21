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

    // Live edges with their real ids, for neighbor lookup. Kept in memory because
    // in-flight batch rows are not persisted yet; a later candidate must reconcile
    // against the batch-evolved mesh.
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

      // Rubric evidence is scoped per edge: a failure counts only when its effective
      // id set (attempt ∪ judge) touches one of this edge's endpoints. Attaching the
      // whole batch would let one edge borrow another's evidence. An empty scoped set
      // takes the validator's evidence-missing path and folds. L2 digest/adaptive gate
      // stay deferred. Built before the topology check so the reject branch can reuse
      // the payload with empty evidence_refs.
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

      // Common write fields; each branch adds its own payload and event override.
      const proposalWriteBase = {
        actor_ref: 'dreaming' as const,
        outcome: 'success' as const,
        task_run_id: result.task_run_id ?? null,
        cost_usd: result.cost_usd,
        created_at: new Date(),
      };

      // Shared by the topology reject and warn branches; only the verdict differs.
      const eventPayloadBase = {
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type,
        weight: p.weight,
        reasoning: p.reasoning,
      };

      // Structural gate, separate from the semantic rubric: tree redundancy, cycles,
      // direction contradictions and transitive redundancy. The edge list includes
      // earlier edges from this batch, so two proposals that only form a cycle
      // together are still caught.
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
        // Fold like a rubric reject: a marked event stays for audit, no live
        // proposal is created, and a later batch may re-evaluate. A folded reject
        // carries no evidence.
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
        // Folded, not dropped: keep a marked event for audit and exclude it from
        // pending dedup so a later batch can re-propose. Mirrors the tool path's
        // foldRubricRejectedEdge.
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

      // Reconciliation runs only after both gates pass. It asks whether the
      // candidate semantically corrects a live neighbor (supersede) or coexists
      // with it (keep both). Parse errors, network failures and low confidence all
      // degrade to keep-both; an uncertain judge never causes a destructive write.
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
          // The judge is advisory: persist a pending proposal; the replacement and
          // archive happen only after an explicit user accept.
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
      // Only live-path edges enter the batch mesh. Folded edges are never persisted,
      // so adding them would create false cycles for later candidates. Pending
      // proposals are not live rows either, so they stay out of both accumulators.
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
    // Never advance the nightly watermark on a swallowed error, or this batch's
    // events are lost. Also report whether the model was called, so a pre-model
    // failure is not mistaken for an idle night.
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
 * Apply a user-approved supersede inside the caller's transaction, so a crash
 * rolls back everything and there is nothing to replay:
 *   1. record the plan in the reconciliation log;
 *   2. archive the old edge;
 *   3. create the new edge and its generate event;
 *   4. write the correction event, targeting the old archive event;
 *   5. mark the log row applied.
 *
 * The log is audit/provenance, not a replay cursor. Double-apply is prevented by
 * the unique edge key and the upstream duplicate check, not by deterministic ids.
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
  // 1) Record the plan; applied_at is stamped last in the same transaction.
  await insertEdgePlannedRows(db, [logRow]);

  // 2) Retire the old edge before introducing its replacement.
  const archived = await archiveKnowledgeEdgeFromEvents(db, supersededEdgeId, {
    event_id: oldArchiveGenerateEventId,
    caused_by_event_id: proposeEventId,
    created_at: now,
    reasoning: `reconcile SUPERSEDE: ${decision.reason}`,
  });
  if (!archived.archived)
    throw new Error(`superseded edge ${supersededEdgeId} is already archived`);

  // 3) Create the replacement. Its key is unique here because duplicates,
  //    including the archived old edge's slot, were filtered upstream.
  const newEdgeId = await createKnowledgeEdge(db, {
    generate_event_id: newGenerateEventId,
    from_knowledge_id: p.from_knowledge_id,
    to_knowledge_id: p.to_knowledge_id,
    relation_type: p.relation_type,
    weight: p.weight,
    reasoning: p.reasoning,
    // Align actor and time with the generate event so the edge folds to its row.
    actor_kind: 'user',
    actor_ref: 'self',
    propose_event_id: proposeEventId,
    created_at: now,
  });

  // 4) Human-attributed correction provenance for the accepted replacement.
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

  // 5) Same transaction, so a committed log row always means a full apply.
  await markEdgeReconcileApplied(db, logRow.id);

  return { edgeId: newEdgeId, generateEventId: newGenerateEventId };
}

/**
 * Keys of pending edge proposals: propose events with no chained rate event and no
 * terminal fold. Used so dreaming does not re-propose the same edge nightly.
 */
export async function loadPendingEdgeProposalKeys(db: Db): Promise<Set<string>> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        eq(event.subject_kind, 'knowledge_edge'),
        // Folded proposals are terminal, not pending. Counting them here would
        // permanently block re-proposing the same edge. A topology reject carries
        // no rubric marker, so both predicates are required.
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
