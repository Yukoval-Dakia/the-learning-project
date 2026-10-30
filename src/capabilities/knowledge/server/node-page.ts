// `/knowledge/[id]` read aggregator. One server call gathers metadata, mastery,
// mesh neighbors, the primary atomic body, backlinks, timeline, notes and the
// subject profile, instead of the old client-side full-table scans.
//
// Backlink filtering matches the backlink route so a retracted or archived source
// never renders as a live link.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { listKnowledgeEdges } from '@/capabilities/knowledge/server/edges';
import { type MasteryDecayBucket, masteryDecayBucket } from '@/core/mastery-freshness';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import type { Db } from '@/db/client';
import { artifact, event, knowledge } from '@/db/schema';
import {
  type BacklinksByArtifactType,
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from '@/kernel/read-models/artifact-backlinks';
import { getArtifactCorrectionStates } from '@/kernel/read-models/artifact-corrections';
import { abilityReadingsById, readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { getRepresentativeKcBeta } from '@/kernel/read-models/mastery-projection';
import {
  type NoteSummary,
  interactiveForKnowledge,
  notesForKnowledge,
} from '@/kernel/read-models/notes-read';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { type SlimSubjectProfile, toSlimSubjectProfile } from '@/subjects/profile';

const CROSS_LINK_REF_KIND = 'cross_link';
const NOTE_ATOMIC_TYPE = 'note_atomic';
const TIMELINE_LIMIT = 30;

export interface NodePagePrimaryAtomic {
  id: string;
  // The learning-item route expects learning_item.id, not artifact.id, so the title
  // links through this and stays a non-link when there is no owner.
  owning_learning_item_id: string | null;
  title: string;
  version: number;
  body_blocks: ArtifactBodyBlocksT | null;
  generation_status: string;
  verification_status: string;
}

export interface NodePageMeshNeighbor {
  edge_id: string;
  knowledge_id: string;
  name: string;
  relation_type: string;
  /** Relative to the focal node. */
  direction: 'out' | 'in';
  weight: number;
}

// Direct children for the hierarchy block. Mastery null means never practiced;
// archived children are excluded because their endpoint would 404.
export interface NodePageChild {
  id: string;
  name: string;
  mastery: number | null;
}

export interface NodePageBacklink {
  from_artifact_id: string;
  // Same id distinction as the primary atomic: null renders as a non-link.
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
}

export interface NodePageTimelineEntry {
  event_id: string;
  action: string;
  subject_kind: string;
  actor_kind: string;
  outcome: string | null;
  created_at: string;
}

export interface KnowledgeNodePage {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  parent_name: string | null;
  effective_domain: string | null;
  /** YUK-1600 identity role: 'kc' is mastery-evaluable; goal/container faces read 不评掌握. */
  role: 'kc' | 'goal' | 'container';
  mastery: number | null;
  // Mastery interval and low-confidence flag; cold start is null/null/false.
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
  // Raw three-axis values; the client bands them. Pure read.
  // retrievability is FSRS R(t), null when no state row exists (unknown, not 0).
  // beta is the representative IRT anchor, available before any attempt.
  // difficulty_anchored separates a real beta=0 anchor from the unanchored sentinel.
  retrievability: number | null;
  retention: RetentionReading | null;
  beta: number | null;
  difficulty_anchored: boolean;
  last_evidence_at: string | null;
  mastery_decay_bucket: MasteryDecayBucket;
  subject_profile: SlimSubjectProfile;
  children: NodePageChild[];
  mesh_neighbors: NodePageMeshNeighbor[];
  primary_atomic: NodePagePrimaryAtomic | null;
  /** All notes labeled with this node, atomic first; primary_atomic is the newest. */
  notes: NoteSummary[];
  /** Interactive artifacts stay separate; note machinery must not see them. */
  interactive_artifacts: NoteSummary[];
  backlinks: NodePageBacklink[];
  backlinks_by_type: BacklinksByArtifactType<NodePageBacklink>;
  timeline: NodePageTimelineEntry[];
}

/**
 * Every read the node page needs, in one call. Null for a missing or archived node
 * so the route can 404 instead of rendering an empty shell.
 */
export async function loadKnowledgeNodePage(
  db: Db,
  knowledgeId: string,
): Promise<KnowledgeNodePage | null> {
  if (!isLearnerVisibleKnowledgeId(knowledgeId)) return null;
  // Mastery is overlaid from the mastery_state projection, not the deprecated
  // knowledge_mastery view, so last_evidence_at is the real last attempt.
  const nodeRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      role: knowledge.role,
    })
    .from(knowledge)
    .where(and(eq(knowledge.id, knowledgeId), isNull(knowledge.archived_at)))
    .limit(1);
  const node = nodeRows[0];
  if (!node) return null;

  // Resolve the parent name and inherit a domain only from non-archived ancestors,
  // or the page would link to a 404.
  let parentName: string | null = null;
  let effectiveDomain = node.domain;
  if (node.parent_id) {
    const parentRows = await db
      .select({ name: knowledge.name, domain: knowledge.domain, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(and(eq(knowledge.id, node.parent_id), isNull(knowledge.archived_at)))
      .limit(1);
    parentName = parentRows[0]?.name ?? null;
  }
  if (effectiveDomain === null && node.parent_id) {
    effectiveDomain = await resolveEffectiveDomain(db, node.parent_id);
  }

  const childRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
    })
    .from(knowledge)
    .where(and(eq(knowledge.parent_id, knowledgeId), isNull(knowledge.archived_at)))
    .orderBy(knowledge.name);

  // Independent reads: mastery may not exist before an attempt, while a difficulty
  // anchor can. Map presence is the has-anchor bit beta=0 alone cannot express.
  // One judgment-contract read carries both mastery-family readings (mastery +
  // retention) under one snapshot, and owns the YUK-1600 non-kc role gate.
  const [judgmentBatch, focalBetaMap] = await Promise.all([
    readLearnerJudgments(db, {
      knowledge_ids: [node.id, ...childRows.map((c) => c.id)],
      context: 'any',
      as_of: new Date(),
    }),
    getRepresentativeKcBeta(db, [node.id]),
  ]);
  const masteryProjection = abilityReadingsById(judgmentBatch);
  const nodeMastery = masteryProjection.get(node.id);
  const difficultyAnchored = focalBetaMap.has(node.id);
  const focalBeta = focalBetaMap.get(node.id) ?? nodeMastery?.beta ?? null;
  const children: NodePageChild[] = childRows
    .filter((row) => isLearnerVisibleKnowledgeId(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      mastery: masteryProjection.get(row.id)?.mastery ?? null,
    }));

  const [outEdges, inEdges] = await Promise.all([
    listKnowledgeEdges(db, { from: knowledgeId }),
    listKnowledgeEdges(db, { to: knowledgeId }),
  ]);
  // The contract returns an honest unknown retention for a goal/container focal
  // node; only a number or candidate score reaches the wire below, so the
  // payload keeps its cold-start null semantics for unreadable retention.
  const focalRetention = judgmentBatch.items.find(
    (item) => item.knowledge_id === node.id,
  )?.retention;
  const focalReading = focalRetention?.kind === 'available' ? focalRetention.reading : undefined;
  const focalRetrievability =
    typeof focalReading === 'number' || focalReading?.kind === 'score' ? focalReading : undefined;
  const neighborIds = Array.from(
    new Set([
      ...outEdges.map((e) => e.to_knowledge_id),
      ...inEdges.map((e) => e.from_knowledge_id),
    ]),
  );
  const neighborNames = await loadNames(db, neighborIds);
  // Drop edges to archived/unknown neighbors rather than render a dead chip.
  const meshNeighbors: NodePageMeshNeighbor[] = [
    ...outEdges
      .filter((e) => neighborNames.has(e.to_knowledge_id))
      .map((e) => ({
        edge_id: e.id,
        knowledge_id: e.to_knowledge_id,
        name: neighborNames.get(e.to_knowledge_id) as string,
        relation_type: e.relation_type,
        direction: 'out' as const,
        weight: e.weight,
      })),
    ...inEdges
      .filter((e) => neighborNames.has(e.from_knowledge_id))
      .map((e) => ({
        edge_id: e.id,
        knowledge_id: e.from_knowledge_id,
        name: neighborNames.get(e.from_knowledge_id) as string,
        relation_type: e.relation_type,
        direction: 'in' as const,
        weight: e.weight,
      })),
  ];

  // Five independent reads run concurrently; backlinks wait for the primary atomic.
  // Named promises prevent swapping the two NoteSummary results.
  // Primary atomic = newest non-archived note_atomic containing this node.
  const atomicPromise = db
    .select({
      id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      body_blocks: artifact.body_blocks,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
    })
    .from(artifact)
    .where(
      and(
        eq(artifact.type, NOTE_ATOMIC_TYPE),
        isNull(artifact.archived_at),
        sql`${artifact.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
      ),
    )
    .orderBy(desc(artifact.created_at))
    .limit(1)
    .execute();
  const timelinePromise = db
    .select({
      event_id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      actor_kind: event.actor_kind,
      outcome: event.outcome,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      sql`${event.payload}->'referenced_knowledge_ids' @> ${JSON.stringify([knowledgeId])}::jsonb`,
    )
    .orderBy(desc(event.created_at))
    .limit(TIMELINE_LIMIT)
    .execute();
  const notesPromise = notesForKnowledge(db, knowledgeId);
  const interactivePromise = interactiveForKnowledge(db, knowledgeId);
  const profilePromise = resolveSubjectProfileForKnowledgeIds(db, [knowledgeId]);
  await Promise.all([
    atomicPromise,
    timelinePromise,
    notesPromise,
    interactivePromise,
    profilePromise,
  ]);
  const atomicRows = await atomicPromise;
  const timelineRows = await timelinePromise;
  const notes = await notesPromise;
  const interactiveArtifacts = await interactivePromise;
  const profile = await profilePromise;

  let primaryAtomic: NodePagePrimaryAtomic | null = null;
  const backlinks: NodePageBacklink[] = [];
  const atomic = atomicRows[0];
  if (atomic) {
    const owningLearningItemForAtomic = await resolveOwningLearningItemIds(db, [atomic.id]);
    primaryAtomic = {
      id: atomic.id,
      owning_learning_item_id: owningLearningItemForAtomic.get(atomic.id) ?? null,
      title: atomic.title,
      version: atomic.version,
      body_blocks: atomic.body_blocks,
      generation_status: atomic.generation_status,
      verification_status: atomic.verification_status,
    };

    // Inbound cross-links only; drop archived, non-ready, retracted or superseded
    // sources, matching the backlink panel route.
    const inbound = (await listBacklinks(db, { toArtifactId: atomic.id })).filter(
      (ref) => ref.ref_kind === CROSS_LINK_REF_KIND,
    );
    if (inbound.length > 0) {
      const sourceIds = Array.from(new Set(inbound.map((ref) => ref.from_artifact_id)));
      const sourceRows = await db
        .select({
          id: artifact.id,
          archived_at: artifact.archived_at,
          generation_status: artifact.generation_status,
        })
        .from(artifact)
        .where(inArray(artifact.id, sourceIds));
      const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
      const correctionStates = await getArtifactCorrectionStates(db, sourceIds);
      // One representative owner per artifact; unresolved sources render as non-links.
      const owningLearningItemByArtifactId = await resolveOwningLearningItemIds(db, sourceIds);
      for (const ref of inbound) {
        const source = sourceById.get(ref.from_artifact_id);
        if (!source) continue;
        if (source.archived_at != null) continue;
        if (source.generation_status !== 'ready') continue;
        const correction = correctionStates.get(ref.from_artifact_id);
        if (correction) {
          if (correction.whole.state === 'retracted' || correction.whole.state === 'superseded') {
            continue;
          }
          const blockState = correction.blocks.get(ref.from_block_id);
          if (
            blockState &&
            (blockState.state === 'retracted' || blockState.state === 'superseded')
          ) {
            continue;
          }
        }
        backlinks.push({
          from_artifact_id: ref.from_artifact_id,
          from_learning_item_id: owningLearningItemByArtifactId.get(ref.from_artifact_id) ?? null,
          from_title: ref.from_artifact_title,
          from_type: ref.from_artifact_type,
          from_block_id: ref.from_block_id,
        });
      }
    }
  }

  const timeline: NodePageTimelineEntry[] = timelineRows.map((r) => ({
    event_id: r.event_id,
    action: r.action,
    subject_kind: r.subject_kind,
    actor_kind: r.actor_kind,
    outcome: r.outcome,
    created_at: r.created_at.toISOString(),
  }));

  // Absent projection means cold start: no mastery, zero evidence, no last attempt.
  const nodeEvidenceCount = nodeMastery?.evidence_count ?? 0;
  const nodeLastEvidenceAt = nodeMastery?.last_outcome_at ?? null;

  return {
    id: node.id,
    name: node.name,
    domain: node.domain,
    parent_id: node.parent_id,
    parent_name: parentName,
    effective_domain: effectiveDomain,
    role: node.role,
    mastery: nodeMastery?.mastery ?? null,
    // Cold start is null/false; the client maps null mastery to the unknown band.
    mastery_lo: nodeMastery?.mastery_lo ?? null,
    mastery_hi: nodeMastery?.mastery_hi ?? null,
    low_confidence: nodeMastery?.low_confidence ?? false,
    evidence_count: nodeEvidenceCount,
    // Raw R(t) and beta. The presence bit distinguishes a real beta=0 anchor from
    // the unanchored sentinel.
    retrievability:
      typeof focalRetrievability === 'number'
        ? focalRetrievability
        : focalRetrievability?.kind === 'score'
          ? focalRetrievability.value
          : null,
    retention: focalRetrievability ?? null,
    beta: focalBeta,
    difficulty_anchored: difficultyAnchored,
    last_evidence_at: nodeLastEvidenceAt ? nodeLastEvidenceAt.toISOString() : null,
    mastery_decay_bucket: masteryDecayBucket(nodeEvidenceCount, nodeLastEvidenceAt),
    subject_profile: toSlimSubjectProfile(profile),
    children,
    mesh_neighbors: meshNeighbors,
    primary_atomic: primaryAtomic,
    notes,
    interactive_artifacts: interactiveArtifacts,
    backlinks,
    backlinks_by_type: groupBacklinksByArtifactType(backlinks),
    timeline,
  };
}

// Archived and invisible ids are omitted so their chips can be dropped.
async function loadNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(inArray(knowledge.id, ids), isNull(knowledge.archived_at)));
  return new Map(
    rows.filter((row) => isLearnerVisibleKnowledgeId(row.id)).map((r) => [r.id, r.name]),
  );
}

// Walk up until a node carries an explicit domain, stopping at archived or missing
// ancestors like the tree reader does. The depth cap guards cyclic parent data.
async function resolveEffectiveDomain(db: Db, startParentId: string): Promise<string | null> {
  let currentId: string | null = startParentId;
  let depth = 0;
  while (currentId && depth < 32) {
    const rows: { domain: string | null; parent_id: string | null }[] = await db
      .select({ domain: knowledge.domain, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(and(eq(knowledge.id, currentId), isNull(knowledge.archived_at)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.domain !== null) return row.domain;
    currentId = row.parent_id;
    depth++;
  }
  return null;
}
