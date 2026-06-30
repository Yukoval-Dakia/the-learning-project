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

// ── A5 S4 (YUK-531) per-KC 误区 funnel wire（「指向此点的误区」）─────────────
// 后端 server/misconception-read.ts loadMisconceptionsForKc。两段：confirmed
// (RT1 误区) + candidate (猜想/候选)。conf 是定性档（高/中/低），裸 weight/
// confidence 绝不过 wire（⑥）。UI 组件是 PR-5；此处只供 fetch + 类型。
export interface MisconceptionRow {
  // segment-scoped id：confirmed = misconception.id；candidate = proposal event id。两段
  // id 空间不相交 —— PR-5 必须按 `segment` 路由 action（绝不单凭 id），否则会打到错的后端。
  id: string;
  // 'confirmed' = 确认误区(RT1)；'candidate' = 猜想/候选（pending conjecture）。
  segment: 'confirmed' | 'candidate';
  label: string;
  belief: string;
  // 显示投影（非裸 draft|active）；active→「复发中」/fading→「消退中」。
  status: 'active' | 'fading';
  // 轨道来源 chip：hard→「硬轨校准」/soft→「软轨先验」。
  source: 'hard' | 'soft';
  // 定性置信档（高/中/低）——绝无裸概率。
  conf: '高' | '中' | '低';
  // 复现次数（int，计数允许）。
  seen: number;
  // 证据 event-id 回链 —— 仅 event-id（candidate 段已在后端把非 event 的 ref 过滤掉，
  // 故每个 id 都可安全渲染成 event 回链，不会出现死链）。
  evidence: string[];
}

export const getMisconceptions = (id: string) =>
  apiJson<{ rows: MisconceptionRow[] }>(`/api/knowledge/${encodeURIComponent(id)}/misconceptions`);

// A5 S4 (YUK-531 PR-5) — candidate(猜想/候选) 误区 veto = dismiss 对应 pending conjecture 提议。
// id = candidate 段行 id = pending conjecture 提议 event id（两段 id 空间不相交，故 PR-5 仅对
// segment==='candidate' 调它）。Option A：confirmed(RT1 误区) archive 是延后 soft-track 后端
// slice —— UI 对 confirmed 行只渲乐观「已纠偏」本地态、绝不打此端点。
export const vetoMisconception = (id: string) =>
  apiJson<{ kind: string }>(`/api/knowledge/misconceptions/${encodeURIComponent(id)}/veto`, {
    method: 'POST',
  });

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
  // A5 S3 (YUK-354) — NodeComposite 三维折叠 RAW（R + β；p(L) 上方已铺）。
  // 喂 buildNodeThreeDim(node-dims.ts) 客户端组装三条正交维度的离散 band 视图。
  retrievability: number | null;
  beta: number | null;
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
