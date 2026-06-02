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
// resolveSubjectProfileForKnowledgeIds + toSlimSubjectProfile、bodyBlocksToNoteSections。

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, event, knowledge, knowledge_mastery, question } from '@/db/schema';
import { listBacklinks, resolveOwningLearningItemIds } from '@/server/artifacts/block-refs';
import { bodyBlocksToNoteSections } from '@/server/artifacts/body-blocks';
import { getArtifactCorrectionStates } from '@/server/events/artifact-corrections';
import { listKnowledgeEdges } from '@/server/knowledge/edges';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { type SlimSubjectProfile, toSlimSubjectProfile } from '@/subjects/profile';

const CROSS_LINK_REF_KIND = 'cross_link';
const NOTE_ATOMIC_TYPE = 'note_atomic';
const TIMELINE_LIMIT = 30;

export interface NodePageEmbeddedQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
}

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
  embedded_check_status: string;
  embedded_questions: NodePageEmbeddedQuestion[];
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
  evidence_count: number;
  last_evidence_at: string | null;
  subject_profile: SlimSubjectProfile;
  mesh_neighbors: NodePageMeshNeighbor[];
  primary_atomic: NodePagePrimaryAtomic | null;
  backlinks: NodePageBacklink[];
  timeline: NodePageTimelineEntry[];
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
  // 1. node metadata + mastery (single-row join; no O(N) tree scan).
  const nodeRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      mastery: knowledge_mastery.mastery,
      evidence_count: sql<number>`COALESCE(${knowledge_mastery.evidence_count}, 0)`,
      last_evidence_at: knowledge_mastery.last_evidence_at,
    })
    .from(knowledge)
    .leftJoin(knowledge_mastery, eq(knowledge_mastery.knowledge_id, knowledge.id))
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

  // 2. mesh neighbors — both directions (ADR-0010 edges). Resolve neighbor names.
  const [outEdges, inEdges] = await Promise.all([
    listKnowledgeEdges(db, { from: knowledgeId }),
    listKnowledgeEdges(db, { to: knowledgeId }),
  ]);
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
      embedded_check_status: artifact.embedded_check_status,
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
    const sections = bodyBlocksToNoteSections(atomic.body_blocks);
    let embeddedQuestions: NodePageEmbeddedQuestion[] = [];
    if (atomic.embedded_check_status === 'ready') {
      const checkSection = sections.find((s) => s.kind === 'check');
      const ids = checkSection?.embedded_check?.question_ids ?? [];
      if (ids.length > 0) {
        const qRows = await db
          .select({
            id: question.id,
            kind: question.kind,
            prompt_md: question.prompt_md,
            choices_md: question.choices_md,
          })
          .from(question)
          .where(inArray(question.id, ids));
        const byId = new Map(qRows.map((r) => [r.id, r]));
        embeddedQuestions = ids
          .map((id) => byId.get(id))
          .filter((r): r is NonNullable<typeof r> => r !== undefined);
      }
    }
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
      embedded_check_status: atomic.embedded_check_status,
      embedded_questions: embeddedQuestions,
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

  const profile = await resolveSubjectProfileForKnowledgeIds(db, [knowledgeId]);

  return {
    id: node.id,
    name: node.name,
    domain: node.domain,
    parent_id: node.parent_id,
    parent_name: parentName,
    effective_domain: effectiveDomain,
    mastery: node.mastery,
    evidence_count: node.evidence_count,
    last_evidence_at: node.last_evidence_at ? node.last_evidence_at.toISOString() : null,
    subject_profile: toSlimSubjectProfile(profile),
    mesh_neighbors: meshNeighbors,
    primary_atomic: primaryAtomic,
    backlinks,
    timeline,
  };
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
