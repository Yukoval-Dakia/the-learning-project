// M3 知识面（YUK-317）— ui 数据层：图谱/节点页对真 API 的调用与 wire 类型。
// 路由宿主（dev）：/api/knowledge、/api/proposals 经 vite proxy → Hono(:8787)。
// M4-T5 (YUK-318)：边提议读已从 /api/events 裸查换源到统一收件箱。

import { apiJson } from '@/ui/lib/api';

// ── 树快照（loadTreeSnapshot wire：knowledge 行 + mastery 视图 join） ──
export interface KnowledgeTreeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  effective_domain: string | null;
  mastery: number | null; // 0..1
  // A5 S1 (YUK-354) — p(L) CI band (0..1) + low-confidence flag for the BandChip
  // (discrete band + interval + source). null/null/false = cold start → unknown band.
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

export const getTree = () => apiJson<{ rows: KnowledgeTreeNode[] }>('/api/knowledge');

// ── A5 S2 (YUK-354) FrontierRail wire（learnable_frontier 横幅）─────────────
// 后端 server/frontier-read.ts loadFrontierRail。band 字段（mastery_lo/hi/
// low_confidence/evidence_count）平铺，直接喂 <BandChip input={item} />。
export interface FrontierRailItem {
  kid: string;
  name: string;
  reason: string;
  // true → 冷启提议（非 live）前置建议（「建议·低置信」）；false → live 边确定解锁（「下一步」）。
  propose: boolean;
  lowConf: boolean;
  // BandChip 所需的 MasteryBandInput 形状（0..1；null = 冷启未知态）。
  mastery: number | null;
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

export const getFrontier = () => apiJson<{ rows: FrontierRailItem[] }>('/api/knowledge/frontier');

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

// S10 (YUK-335)：层级块直接子节点（mastery 0..1 来自 knowledge_mastery 视图）。
export interface NodePageChild {
  id: string;
  name: string;
  mastery: number | null;
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
  // A5 S1 (YUK-354) — p(L) CI band (0..1) + low-confidence flag for the focal-node
  // BandChip. null/null/false = cold start → unknown band.
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
  last_evidence_at: string | null;
  mastery_decay_bucket: 'untrained' | 'fresh' | 'mild' | 'stale' | 'unknown';
  children: NodePageChild[];
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

// 边提议（M4-T5 / YUK-318：统一收件箱投影。旧 /api/events 裸查不感知决策，
// 已决提议会复返、靠客户端 decided 集合补救；新源服务端按 status=pending
// 过滤，accept/dismiss 后自然退出列表）。wire = shell 包 ProposalInboxRow
// 的 UI 投影：payload 是 AiProposalPayload，边字段在 proposed_change 内。
export interface EdgeProposalInboxRow {
  id: string;
  status: string;
  proposed_at: string;
  payload: {
    reason_md?: string;
    proposed_change: {
      from_knowledge_id?: string;
      to_knowledge_id?: string;
      relation_type?: string;
      weight?: number;
    };
  };
}

export const getEdgeProposals = () =>
  apiJson<{ rows: EdgeProposalInboxRow[] }>('/api/proposals?kind=knowledge_edge&status=pending');

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
