// YUK-96 P6/C — /knowledge/[id] node-page read aggregator (ADR-0020 §10).
//
// 节点页 = 视图职能（query 聚合不存盘）；hub = 作品职能（artifact 实体）。本 module
// 把单节点页所需的所有读路径聚合到一个 server-side query 里，替掉旧 client page 的
// O(N) `/api/knowledge` 全表扫 + `/api/mistakes?limit=200` 扫。
//
// 分层视图契约（ADR-0020 §10 line 130-134）：
//   1. 节点 metadata + mastery + mesh 邻居 chip
//   2. 主 atomic body_blocks inline 渲染（WHERE knowledge_ids @> [k_id] AND type='note_atomic'）
//   3. 反链 panel（复用 listBacklinks，cross_link only）
//   4. 最近活动 timeline（event payload.referenced_knowledge_ids @> [k_id] 倒序）
//   5. 无主 atomic 时 hasPrimaryAtomic=false → client 渲染占位卡
//
// 复用锚点（不重建）：loadMastery via knowledge_mastery view、listKnowledgeEdges、
// listBacklinks + getArtifactCorrectionStates（backlinks route 的同款 read-time 过滤）、
// resolveSubjectProfileForKnowledgeIds + toSlimSubjectProfile。

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { listKnowledgeEdges } from '@/capabilities/knowledge/server/edges';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import {
  type BacklinksByArtifactType,
  groupBacklinksByArtifactType,
  listBacklinks,
  resolveOwningLearningItemIds,
} from '@/capabilities/notes/server/block-refs';
import {
  type NoteSummary,
  interactiveForKnowledge,
  notesForKnowledge,
} from '@/capabilities/notes/server/notes-read';
import { retrievabilityForKc } from '@/capabilities/practice/server/fsrs';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, event, knowledge } from '@/db/schema';
import { getArtifactCorrectionStates } from '@/server/events/artifact-corrections';
import { getFsrsStatesByIds } from '@/server/fsrs/state';
import { getMasteryProjection } from '@/server/mastery/state';
import { type SlimSubjectProfile, toSlimSubjectProfile } from '@/subjects/profile';

const CROSS_LINK_REF_KIND = 'cross_link';
const NOTE_ATOMIC_TYPE = 'note_atomic';
const TIMELINE_LIMIT = 30;
export type MasteryDecayBucket = 'untrained' | 'fresh' | 'mild' | 'stale' | 'unknown';

export interface NodePagePrimaryAtomic {
  id: string;
  // owning learning_item.id for this atomic (primary_artifact_id == atomic.id),
  // null when the atomic has no non-archived owning learning_item. The node page
  // title links to /learning-items/<owning_learning_item_id> (that route queries
  // by learning_item.id, NOT artifact.id; linking by the artifact id 404s — same
  // class as the backlink rows); when null the title renders as a non-link. (Codex #193)
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
  // direction relative to the focal node: 'out' (focal → neighbor) / 'in' (neighbor → focal)
  direction: 'out' | 'in';
  weight: number;
}

// S10 (YUK-335 audit §3.9): direct children of the focal node, for the hierarchy
// block on /knowledge/[id]. mastery comes from the knowledge_mastery view (null =
// never practiced). Archived children are excluded (same dead-link discipline as
// the parent-name lookup — the endpoint 404s on archived nodes).
export interface NodePageChild {
  id: string;
  name: string;
  mastery: number | null;
}

export interface NodePageBacklink {
  from_artifact_id: string;
  // owning learning_item.id for the source artifact (primary_artifact_id == from_artifact_id),
  // null when the source artifact has no non-archived owning learning_item. The node page links
  // to /learning-items/<from_learning_item_id> (that route queries by learning_item.id, NOT
  // artifact.id); when null the source renders as a non-link to avoid a 404. (Codex #193)
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
  mastery: number | null;
  // A5 S1 (YUK-354) — ADR-0035 p(L) confidence-interval band + low-confidence flag,
  // surfaced for the focal-node BandChip (discrete band + interval + source). Cold start
  // (no mastery_state row) → null/null/false; the client renders the unknown band.
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
  // A5 S3 (YUK-354) — NodeComposite 三维折叠 RAW 读模型（p(L) 上方已铺；这里补 R + β）。
  // 同 S1 raw-over-wire 先例：node-page 出 RAW，前端 buildNodeThreeDim 客户端 band 化。
  // 三轴正交：纯 READ，绝不写回。
  //   retrievability = FSRS R(t)∈[0,1]（null = 无 fsrs_state 行，无留存数据，非 R=0）；
  //   beta           = 代表性 β（IRT logit；null = 无投影/冷启，0 = 无难度锚 sentinel）。
  retrievability: number | null;
  beta: number | null;
  last_evidence_at: string | null;
  mastery_decay_bucket: MasteryDecayBucket;
  subject_profile: SlimSubjectProfile;
  // S10: direct (non-archived) children for the hierarchy block, name-ordered.
  children: NodePageChild[];
  mesh_neighbors: NodePageMeshNeighbor[];
  primary_atomic: NodePagePrimaryAtomic | null;
  // ADR-0027: all notes labeled with this node (atomic/hub/long), atomic-first.
  // `primary_atomic` stays as the inline-rendered 节点简介 (newest atomic); `notes`
  // is the full labeled set for the "带当前 knowledge_id 标签的笔记列表" (0/1/many).
  notes: NoteSummary[];
  // ADR-0033 D5: interactive artifacts labeled with this node. A separate field,
  // NOT mixed into `notes` — `notes` is the ADR-0027 note contract (the page
  // groups it by note type); interactive is opaque to note machinery.
  interactive_artifacts: NoteSummary[];
  backlinks: NodePageBacklink[];
  backlinks_by_type: BacklinksByArtifactType<NodePageBacklink>;
  timeline: NodePageTimelineEntry[];
}

/**
 * A5 S3 (YUK-354) — batched R(t) read for the 'knowledge' axis. One DB round-trip
 * (getFsrsStatesByIds) over `material_fsrs_state WHERE subject_kind='knowledge' AND
 * subject_id IN (ids)`, each row through retrievabilityForKc(state, now) → R ∈ [0,1].
 * KCs with no row are ABSENT from the map (the caller renders "no retention data yet",
 * NOT R=0 — a missing card is unknown, not fully-forgotten). Map presence ⇔ a real
 * fsrs_state row (hard source); absence ⇔ unknown — no separate `hasState` flag needed,
 * it was always true (OCR).
 *
 * `now` is injectable for deterministic tests (retrievability is time-relative).
 * READ-ONLY — three-axis orthogonality: never writes any axis.
 */
export async function loadRetrievabilityMap(
  db: Db,
  knowledgeIds: string[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const states = await getFsrsStatesByIds(db, 'knowledge', knowledgeIds);
  const out = new Map<string, number>();
  for (const [id, row] of states) {
    out.set(id, retrievabilityForKc(row.state, now));
  }
  return out;
}

/**
 * Aggregate every read the /knowledge/[id] node page needs into one server call.
 * Returns null when the knowledge node doesn't exist (or is archived) so the
 * route can 404 instead of rendering an empty shell.
 */
export async function loadKnowledgeNodePage(
  db: Db,
  knowledgeId: string,
): Promise<KnowledgeNodePage | null> {
  // 1. node metadata (single row; no O(N) tree scan). B1 double-truth fix —
  // mastery / evidence_count / last_evidence_at are overlaid below from the SoT
  // mastery_state.theta_hat projection (getMasteryProjection → σ(θ̂)), NOT the
  // deprecated knowledge_mastery view's weighted-success-rate + `<3 → 0.5`
  // placeholder. `last_evidence_at` maps to mastery_state.last_outcome_at (the
  // real last-attempt time).
  const nodeRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
    })
    .from(knowledge)
    .where(and(eq(knowledge.id, knowledgeId), isNull(knowledge.archived_at)))
    .limit(1);
  const node = nodeRows[0];
  if (!node) return null;

  // parent name + effective_domain — walk up domain inheritance if this node's
  // domain is null (matches loadTreeSnapshot's effective-domain semantics).
  let parentName: string | null = null;
  let effectiveDomain = node.domain;
  if (node.parent_id) {
    // Skip archived parents: the /knowledge/[id] endpoint 404s on archived nodes
    // (it filters isNull(archived_at) above), so surfacing an archived parent name
    // would render a dead link. archived parent → parentName=null → non-link. (Codex #193)
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

  // 1b. direct children — non-archived nodes whose parent_id is this node.
  // Archived children are filtered out for the same dead-link reason as the parent
  // lookup (the endpoint 404s on archived nodes). Name-ordered for stable display.
  // B1 double-truth fix — child mastery is overlaid from the SoT mastery_state
  // projection below (same as the focal node), NOT the deprecated view.
  const childRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
    })
    .from(knowledge)
    .where(and(eq(knowledge.parent_id, knowledgeId), isNull(knowledge.archived_at)))
    .orderBy(knowledge.name);

  // Single batch read of the SoT mastery projection for the focal node + every
  // child. Absent (never-attempted) nodes → mastery null, matching the
  // deprecated view's NULL (no-evidence) output.
  const masteryProjection = await getMasteryProjection(db, [
    node.id,
    ...childRows.map((c) => c.id),
  ]);
  const nodeMastery = masteryProjection.get(node.id);
  const children: NodePageChild[] = childRows.map((row) => ({
    id: row.id,
    name: row.name,
    mastery: masteryProjection.get(row.id)?.mastery ?? null,
  }));

  // 2. mesh neighbors + focal-node R(t). The R read (NodeComposite 三维 R axis; only the
  // focal node carries the three-dim fold, children stay mastery-only) is independent of
  // the edge queries → parallelize in one Promise.all (OCR). Absent row → R null (unknown,
  // not R=0).
  const [focalRetrievabilityMap, outEdges, inEdges] = await Promise.all([
    loadRetrievabilityMap(db, [node.id]),
    listKnowledgeEdges(db, { from: knowledgeId }),
    listKnowledgeEdges(db, { to: knowledgeId }),
  ]);
  const focalRetrievability = focalRetrievabilityMap.get(node.id);
  const neighborIds = Array.from(
    new Set([
      ...outEdges.map((e) => e.to_knowledge_id),
      ...inEdges.map((e) => e.from_knowledge_id),
    ]),
  );
  const neighborNames = await loadNames(db, neighborIds);
  // Drop edges whose neighbor isn't in the (non-archived) name map: an archived
  // neighbor would render a chip linking to a node the endpoint 404s on. No
  // id-fallback name — skip the chip entirely instead. (Codex #193)
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

  // 3. primary atomic — the newest non-archived note_atomic whose knowledge_ids
  // contains this node. atomic.knowledge_ids length is 1 (ADR-0020 §3), so a
  // node has at most one "节点简介" atomic; we still pick newest if multiple.
  const atomicRows = await db
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
    .limit(1);

  let primaryAtomic: NodePagePrimaryAtomic | null = null;
  const backlinks: NodePageBacklink[] = [];
  const atomic = atomicRows[0];
  if (atomic) {
    // YUK-358 决定3：graded embedded-check question projection removed with the
    // orphan chain. The check section itself survives as the Phase-3
    // self-explanation anchor (body_blocks carries it; rendered downstream).
    // Resolve the primary atomic to its owning learning_item so the title links
    // to /learning-items/<learning_item_id> instead of the artifact id (those are
    // distinct ids; linking by artifact id 404s — Codex #193 / YUK-161). Mirrors
    // the backlink-source resolution below; null when no non-archived owner.
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

    // 4. backlinks — inbound cross_links pointing AT the primary atomic. Reuse
    // the same read-time filters as the artifact backlink panel route (XC-5):
    // cross_link refs only, drop archived / non-ready / retracted sources.
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
      // Resolve each source artifact to its owning learning_item so the panel can
      // link to /learning-items/<learning_item_id> instead of the artifact id
      // (those are distinct ids; linking by artifact id 404s — Codex #193). The
      // link is learning_item.primary_artifact_id == source.artifact_id. Per ADR-0027
      // an artifact may be referenced by >1 item; resolveOwning returns the earliest as
      // a representative. Drop archived learning_items → unresolved sources render as
      // non-links downstream.
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

  // 5. timeline — events whose payload.referenced_knowledge_ids contains this
  // node, newest first (ADR-0020 GIN index `event_referenced_knowledge_gin`).
  const timelineRows = await db
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
    .limit(TIMELINE_LIMIT);
  const timeline: NodePageTimelineEntry[] = timelineRows.map((r) => ({
    event_id: r.event_id,
    action: r.action,
    subject_kind: r.subject_kind,
    actor_kind: r.actor_kind,
    outcome: r.outcome,
    created_at: r.created_at.toISOString(),
  }));

  // 3b. all notes labeled with this node (ADR-0027) — atomic/hub/long, atomic-first.
  // Superset of `primary_atomic`; powers the multi-note list on /knowledge/[id].
  const notes = await notesForKnowledge(db, knowledgeId);

  // 3c. interactive artifacts labeled with this node (ADR-0033 D5) — parallel
  // read, kept out of `notes` (note contract) on purpose.
  const interactiveArtifacts = await interactiveForKnowledge(db, knowledgeId);

  const profile = await resolveSubjectProfileForKnowledgeIds(db, [knowledgeId]);

  // B1 double-truth fix — focal-node mastery / evidence_count / last_evidence_at
  // from the SoT mastery_state projection (σ(θ̂)). Absent row → cold start:
  // mastery null / evidence 0 / no last_evidence_at (matches the old view NULL/0).
  // last_evidence_at is the real last-attempt time (mastery_state.last_outcome_at).
  const nodeEvidenceCount = nodeMastery?.evidence_count ?? 0;
  const nodeLastEvidenceAt = nodeMastery?.last_outcome_at ?? null;

  return {
    id: node.id,
    name: node.name,
    domain: node.domain,
    parent_id: node.parent_id,
    parent_name: parentName,
    effective_domain: effectiveDomain,
    mastery: nodeMastery?.mastery ?? null,
    // A5 S1 (YUK-354) — band fields from the same getMasteryProjection read above.
    // Absent (cold start) → null/false; the client maps mastery=null to the unknown band.
    mastery_lo: nodeMastery?.mastery_lo ?? null,
    mastery_hi: nodeMastery?.mastery_hi ?? null,
    low_confidence: nodeMastery?.low_confidence ?? false,
    evidence_count: nodeEvidenceCount,
    // A5 S3 (YUK-354) — three-dim RAW: R(t) (null = no fsrs_state row) + representative
    // β (null = no mastery_state projection / cold start). Client bands them via
    // buildNodeThreeDim. β=0 (no difficulty anchor) is honestly degraded to 难度未知.
    retrievability: focalRetrievability ?? null,
    beta: nodeMastery?.beta ?? null,
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

export function masteryDecayBucket(
  evidenceCount: number,
  lastEvidenceAt: Date | null,
  now = new Date(),
): MasteryDecayBucket {
  if (evidenceCount <= 0) return 'untrained';
  if (!lastEvidenceAt) return 'unknown';
  const ageDays = Math.max(0, Math.floor((now.getTime() - lastEvidenceAt.getTime()) / 86_400_000));
  if (ageDays >= 30) return 'stale';
  if (ageDays >= 7) return 'mild';
  return 'fresh';
}

// Resolve non-archived knowledge names. Archived neighbors are intentionally
// omitted from the map so mesh-chip construction can drop them (linking to an
// archived node 404s — the /knowledge/[id] endpoint filters archived). (Codex #193)
async function loadNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(inArray(knowledge.id, ids), isNull(knowledge.archived_at)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// Walk up the parent chain until a node carries an explicit domain. Mirrors
// loadTreeSnapshot's effective-domain inheritance: it only keeps non-archived
// rows in byId and stops at an archived ancestor, so the walk filters
// isNull(archived_at) too — an archived (or missing) ancestor stops the walk
// and returns null, matching the parent-name lookup above. Without this filter
// the node detail page could inherit a domain from an archived ancestor that
// the tree never would (divergent effective_domain — Codex #193 / YUK-161).
// Depth-capped at 32 to guard against cyclic parent_id data.
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
