// M3 知识面（YUK-317）— ui 数据层：图谱/节点页对真 API 的调用与 wire 类型。
// 路由宿主（dev）：/api/knowledge、/api/proposals 经 vite proxy → Hono(:8787)。
// M4-T5 (YUK-318)：边提议读已从 /api/events 裸查换源到统一收件箱。

import {
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiOperationJson,
} from '@/ui/lib/api';

// ── 树快照（loadTreeSnapshot wire：knowledge 行 + mastery 视图 join） ──
type KnowledgeTreeWire = ApiOperationJsonResponse<'getKnowledgeTreeSnapshot'>['rows'][number];
export type KnowledgeTreeNode = Pick<
  KnowledgeTreeWire,
  | 'id'
  | 'name'
  | 'domain'
  | 'parent_id'
  | 'effective_domain'
  | 'mastery'
  | 'mastery_lo'
  | 'mastery_hi'
  | 'low_confidence'
  | 'evidence_count'
>;

export const getTreeForSubject = (subject?: string) =>
  apiOperationJson('getKnowledgeTreeSnapshot', {
    url: subject ? `/api/knowledge?subject=${encodeURIComponent(subject)}` : '/api/knowledge',
    method: 'GET',
  });

export const getTree = () => getTreeForSubject();

// ── A5 S2 (YUK-354) FrontierRail wire（learnable_frontier 横幅）─────────────
// 后端 server/frontier-read.ts loadFrontierRail。band 字段（mastery_lo/hi/
// low_confidence/evidence_count）平铺，直接喂 <BandChip input={item} />。
export type FrontierRailItem = ApiOperationJsonResponse<'listKnowledgeFrontier'>['rows'][number];

export const getFrontier = () =>
  apiOperationJson('listKnowledgeFrontier', {
    url: '/api/knowledge/frontier',
    method: 'GET',
  });

// YUK-617 mode-1 — per-KC FSRS due summary（GET /api/knowledge/review-due-summary，YUK-142 Slice 2
// 已建、此前零消费者）。summary 键=knowledge_id，值={overdue, due_soon}。知识树行据此出「到期」徽标。
export type ReviewDueSummaryResponse = ApiOperationJsonResponse<'getKnowledgeReviewDueSummary'>;
export type ReviewDueNodeSummary = ReviewDueSummaryResponse['summary'][string];
export const getReviewDueSummary = () =>
  apiOperationJson('getKnowledgeReviewDueSummary', {
    url: '/api/knowledge/review-due-summary',
    method: 'GET',
  });

// ── A5 S4 (YUK-531) per-KC 误区 funnel wire（「指向此点的误区」）─────────────
// 后端 server/misconception-read.ts loadMisconceptionsForKc。两段：confirmed
// (RT1 误区) + candidate (猜想/候选)。conf 是定性档（高/中/低），裸 weight/
// confidence 绝不过 wire（⑥）。UI 组件是 PR-5；此处只供 fetch + 类型。
export type MisconceptionRow =
  ApiOperationJsonResponse<'listKnowledgeNodeMisconceptions'>['rows'][number];

export const getMisconceptions = (id: string) =>
  apiOperationJson('listKnowledgeNodeMisconceptions', {
    url: `/api/knowledge/${encodeURIComponent(id)}/misconceptions`,
    method: 'GET',
  });

// A5 S4 (YUK-531 PR-5) — candidate(猜想/候选) 误区 veto = dismiss 对应 pending conjecture 提议。
// id = candidate 段行 id = pending conjecture 提议 event id（两段 id 空间不相交，故 PR-5 仅对
// segment==='candidate' 调它）。Option A：confirmed(RT1 误区) archive 是延后 soft-track 后端
// slice —— UI 对 confirmed 行只渲乐观「已纠偏」本地态、绝不打此端点。
export const vetoMisconception = (id: string) =>
  apiOperationJson('createProposalDecision', {
    url: `/api/proposals/${encodeURIComponent(id)}/decisions`,
    method: 'POST',
    body: { decision: 'dismiss' },
  }).then((resource) => resource.result);

// ── 边 ──────────────────────────────────────────────────────────
type KnowledgeEdgeWire = ApiOperationJsonResponse<'listKnowledgeEdges'>['rows'][number];
export type KnowledgeEdgeRow = Pick<
  KnowledgeEdgeWire,
  'id' | 'from_knowledge_id' | 'to_knowledge_id' | 'relation_type' | 'weight'
> & {
  status: 'active' | 'archived';
};

export const getEdges = (subject?: string) =>
  apiOperationJson('listKnowledgeEdges', {
    url: subject
      ? `/api/knowledge/edges?subject=${encodeURIComponent(subject)}`
      : '/api/knowledge/edges',
    method: 'GET',
  }).then((response) => ({
    ...response,
    rows: response.rows.map(
      (row): KnowledgeEdgeRow => ({
        id: row.id,
        from_knowledge_id: row.from_knowledge_id,
        to_knowledge_id: row.to_knowledge_id,
        relation_type: row.relation_type,
        weight: row.weight,
        status: row.archived_at === null ? 'active' : 'archived',
      }),
    ),
  }));

export const createEdge = (input: ApiOperationRequestBody<'createKnowledgeEdge'>) =>
  apiOperationJson('createKnowledgeEdge', {
    url: '/api/knowledge/edges',
    method: 'POST',
    body: input,
  });

// ── 节点页聚合（KnowledgeNodePage wire，server/node-page.ts） ────
export type KnowledgeNodePage = ApiOperationJsonResponse<'getKnowledgeNode'>;
export type NoteSummary = Pick<
  KnowledgeNodePage['notes'][number],
  'id' | 'type' | 'title' | 'knowledge_ids' | 'verification_status' | 'updated_at'
>;
export type NodePageMeshNeighbor = KnowledgeNodePage['mesh_neighbors'][number];
export type NodePageChild = KnowledgeNodePage['children'][number];
export type NodePageBacklink = KnowledgeNodePage['backlinks'][number];
export type NodePageTimelineEntry = KnowledgeNodePage['timeline'][number];

export const getNodePage = (id: string) =>
  apiOperationJson('getKnowledgeNode', {
    url: `/api/knowledge/${encodeURIComponent(id)}`,
    method: 'GET',
  });

// ── 提议（节点 propose 决断 + 边提议读/决断） ────────────────────
export const decideNodeProposal = (id: string, decision: 'accept' | 'reject') =>
  apiOperationJson('createProposalDecision', {
    url: `/api/proposals/${encodeURIComponent(id)}/decisions`,
    method: 'POST',
    body: { decision: decision === 'reject' ? 'dismiss' : decision },
  }).then((resource) => resource.result);

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
      /** Pre-D4-E1 proposals omit edge_op and remain create proposals. */
      edge_op?: 'create' | 'archive';
      archive_edge_id?: string;
      from_knowledge_id?: string;
      to_knowledge_id?: string;
      relation_type?: string;
      weight?: number;
    };
  };
}

export function edgeProposalOperation(
  proposal: Pick<EdgeProposalInboxRow, 'payload'>,
): 'create' | 'archive' {
  return proposal.payload.proposed_change.edge_op === 'archive' ? 'archive' : 'create';
}

export const getEdgeProposals = () =>
  apiOperationJson('listProposals', {
    url: '/api/proposals?kind=knowledge_edge&status=pending',
    method: 'GET',
  }).then((response) => ({
    rows: response.rows as EdgeProposalInboxRow[],
  }));

export const decideEdgeProposal = (
  eventId: string,
  decision: 'accept' | 'reverse' | 'change_type' | 'dismiss',
  newRelationType?: string,
) =>
  apiOperationJson('createProposalDecision', {
    url: `/api/proposals/${encodeURIComponent(eventId)}/decisions`,
    method: 'POST',
    body: {
      decision,
      ...(newRelationType ? { new_relation_type: newRelationType } : {}),
    },
  }).then((resource) => resource.result);
