// M3 知识面（YUK-317）— ui 数据层：图谱/节点页对真 API 的调用与 wire 类型。
// 路由宿主（dev）：/api/knowledge 经 vite proxy → Hono(:8787)；
// /api/events（边提议读，events 域未迁）经 catch-all → 旧栈，随 M4/M5 收编。

import { apiJson } from '@/ui/lib/api';

// ── 树快照（loadTreeSnapshot wire：knowledge 行 + mastery 视图 join） ──
export interface KnowledgeTreeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  effective_domain: string | null;
  mastery: number | null; // 0..1
  evidence_count: number;
}

export const getTree = () => apiJson<{ rows: KnowledgeTreeNode[] }>('/api/knowledge');

// ── 边 ──────────────────────────────────────────────────────────
export interface KnowledgeEdgeRow {
  id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight: number;
  status: string;
}

export const getEdges = () => apiJson<{ rows: KnowledgeEdgeRow[] }>('/api/knowledge/edges');

export const createEdge = (input: {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}) =>
  apiJson<{ row: KnowledgeEdgeRow }>('/api/knowledge/edges', {
    method: 'POST',
    body: JSON.stringify(input),
  });

// ── 节点页聚合（KnowledgeNodePage wire，server/node-page.ts） ────
export interface NoteSummary {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  verification_status: string;
  updated_at: string;
}

export interface NodePageMeshNeighbor {
  edge_id: string;
  knowledge_id: string;
  name: string;
  relation_type: string;
  direction: 'out' | 'in';
  weight: number;
}

export interface NodePageBacklink {
  from_artifact_id: string;
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
  mastery_decay_bucket: 'untrained' | 'fresh' | 'mild' | 'stale' | 'unknown';
  mesh_neighbors: NodePageMeshNeighbor[];
  primary_atomic: {
    id: string;
    owning_learning_item_id: string | null;
    title: string;
    version: number;
    body_blocks: {
      type: string;
      content?: Array<{
        type: string;
        attrs?: { id?: string; semantic_kind?: string; source_markdown?: string };
      }>;
    } | null;
    generation_status: string;
    verification_status: string;
    embedded_check_status: string;
  } | null;
  notes: NoteSummary[];
  interactive_artifacts: NoteSummary[];
  backlinks: NodePageBacklink[];
  backlinks_by_type: Record<string, NodePageBacklink[]>;
  timeline: NodePageTimelineEntry[];
}

export const getNodePage = (id: string) =>
  apiJson<KnowledgeNodePage>(`/api/knowledge/${encodeURIComponent(id)}`);

// ── 提议（节点 propose 决断 + 边提议读/决断） ────────────────────
export const decideNodeProposal = (id: string, decision: 'accept' | 'reject') =>
  apiJson(`/api/knowledge/proposals/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });

// 边提议事件（events 域查询，旧栈 catch-all；M4 提议生命周期真身后收编）。
export interface EdgeProposalEvent {
  id: string;
  payload: {
    from_knowledge_id?: string;
    to_knowledge_id?: string;
    relation_type?: string;
    weight?: number;
    reason_md?: string;
  };
  outcome: string | null;
  created_at: string;
}

export const getEdgeProposals = () =>
  apiJson<{ rows: EdgeProposalEvent[] }>(
    '/api/events?action=propose&subject_kind=knowledge_edge&limit=100',
  );

export const decideEdgeProposal = (
  eventId: string,
  decision: 'accept' | 'reverse' | 'change_type' | 'dismiss',
  newRelationType?: string,
) =>
  apiJson(`/api/knowledge/edges/proposals/${encodeURIComponent(eventId)}`, {
    method: 'POST',
    body: JSON.stringify({
      decision,
      ...(newRelationType ? { new_relation_type: newRelationType } : {}),
    }),
  });
