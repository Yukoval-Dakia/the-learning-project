// Record page transport (YUK-1473). Thin calls over the ingestion routes in
// src/capabilities/ingestion/manifest.ts; no learner rules live here.

import { type ApiOperationJsonResponse, apiFetch, apiJson, apiOperationJson } from '@/ui/lib/api';
import { expandDocx, expandPdf, uploadAsset } from '@/ui/lib/assets';
import { runIngestionOperation } from '@/ui/lib/ingestion-operations';

export type Entrypoint = 'vision_single' | 'vision_paper' | 'docx';
export type UsePolicy = 'allow' | 'answer_only';

type ListedRow = ApiOperationJsonResponse<'listIngestionSessions'>['data'][number];

/** A list row. path / title / item_count / started_at come from the list contract (YUK-1522). */
export type SessionRow = Pick<
  ListedRow,
  'id' | 'entrypoint' | 'status' | 'source_asset_ids' | 'path' | 'title' | 'item_count'
> & {
  block_count?: number;
  /** Unix seconds. */
  started_at?: number;
  /** Unix seconds. */
  created_at?: number;
};

/** GET /api/ingestion-sessions/{id}/history — what a finished recording was, and what it is now. */
export type SessionHistory = ApiOperationJsonResponse<'getIngestionSessionHistory'>;
export type HistoryItem = SessionHistory['items'][number];
export type HistoryAsk = SessionHistory['asks'][number];
export type HistoryPriorRun = SessionHistory['prior_runs'][number];

export interface SessionFacts {
  id: string;
  status: string;
  entrypoint: string | null;
  source_asset_ids: string[];
  warnings?: string[];
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface UsageReceipt {
  derivation_policy: UsePolicy;
  channels: { page_images: 'raw' | 'none'; extracted_text: 'redacted' | 'none' } | null;
  redaction_counts: Record<string, number>;
}

export interface SessionDetail {
  session: SessionFacts;
  usage_receipt: UsageReceipt | null;
}

export interface PageSpan {
  page_index: number;
  bbox: { x: number; y: number; width: number; height: number };
  role?: string;
}

export interface Block {
  id: string;
  source_asset_ids: string[];
  page_spans: PageSpan[];
  extracted_prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string | null;
  image_refs: string[];
  layout_quality: 'structured' | 'partial' | 'text_only';
  status: 'draft' | 'imported' | 'ignored' | 'auto_enrolled';
  auto_enroll_observation: {
    suggested_knowledge_ids?: string[];
    mistake_draft?: { wrong_answer?: string | null } | null;
  } | null;
}

export interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain?: string | null;
}

export interface ImportBlockBody {
  block_id: string;
  source_block_ids: string[];
  page_spans: PageSpan[];
  image_refs: string[];
  final_prompt_md: string;
  final_reference_md: string | null;
  final_wrong_answer_md: string;
  outcome: 'failure' | 'unanswered';
  knowledge_ids: string[];
  cause: null;
  difficulty: number;
  question_kind: string;
}

export type AskAnswerBody =
  | { kind: 'choice'; option_id: string }
  | { kind: 'text'; text: string; via_option?: 'none_of_these' }
  | { kind: 'skipped'; by: 'learner' };

const enc = encodeURIComponent;

export async function listSessions(): Promise<SessionRow[]> {
  const body = await apiOperationJson('listIngestionSessions', {
    url: '/api/ingestion-sessions?limit=30',
    method: 'GET',
  });
  return body.data as SessionRow[];
}

export const getHistory = (id: string) =>
  apiOperationJson('getIngestionSessionHistory', {
    url: `/api/ingestion-sessions/${enc(id)}/history`,
    method: 'GET',
    init: { cache: 'no-store' },
  });

export const getSession = (id: string) =>
  apiJson<SessionDetail>(`/api/ingestion-sessions/${enc(id)}`, { cache: 'no-store' });

export async function listBlocks(id: string): Promise<Block[]> {
  const body = await apiJson<{ rows: Block[] }>(`/api/ingestion/${enc(id)}/blocks`);
  return body.rows;
}

export async function listKnowledge(): Promise<KnowledgeNode[]> {
  const body = await apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge');
  return body.rows;
}

/** Photos and PDF pages become image assets; returns their ids in page order. */
export async function uploadPages(files: File[], onPage: (done: number) => void) {
  const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdf) {
    const expanded = await expandPdf(pdf);
    onPage(1);
    return expanded.asset_ids;
  }
  const ids: string[] = [];
  for (const file of files) {
    ids.push((await uploadAsset(file)).id);
    onPage(ids.length);
  }
  return ids;
}

export async function createSession(input: {
  entrypoint: Exclude<Entrypoint, 'docx'>;
  assetIds: string[];
  policy: UsePolicy;
}): Promise<string> {
  const body = await apiJson<{ session: { id: string } }>('/api/ingestion-sessions', {
    method: 'POST',
    body: JSON.stringify({
      entrypoint: input.entrypoint,
      asset_ids: input.assetIds,
      ...(input.policy === 'answer_only' ? { derivation_policy: 'answer_only' } : {}),
    }),
  });
  return body.session.id;
}

export async function createDocxSession(file: File, policy: UsePolicy): Promise<string> {
  const body = await expandDocx(
    file,
    policy === 'answer_only' ? { derivationPolicy: 'answer_only' } : {},
  );
  return body.session_id;
}

/** Starts a lane. The caller owns the key, so a manual retry replays the same start. */
export async function startLane(id: string, kind: 'extract' | 'agent', key: string) {
  await apiFetch(`/api/ingestion-sessions/${enc(id)}/operations`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ kind }),
  });
}

export async function answerAsk(id: string, askId: string, answer: AskAnswerBody, key: string) {
  await apiFetch(`/api/ingestion-sessions/${enc(id)}/asks/${enc(askId)}/answers`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ answer }),
  });
}

/** Puts recognised questions into the library; resolves once the server finished. */
export const importBlocks = (id: string, blocks: ImportBlockBody[]) =>
  runIngestionOperation(id, { kind: 'import', input: { blocks } });

export async function revertBlock(id: string, blockId: string) {
  await apiFetch(`/api/ingestion/${enc(id)}/revert`, {
    method: 'POST',
    body: JSON.stringify({ block_id: blockId }),
  });
}

export async function createWrongAnswer(input: {
  prompt: string;
  answer: string;
  knowledgeIds: string[];
}) {
  return apiJson<{ question_id: string }>('/api/mistakes', {
    method: 'POST',
    body: JSON.stringify({
      prompt_md: input.prompt,
      reference_md: null,
      wrong_answer_md: input.answer,
      knowledge_ids: input.knowledgeIds,
      cause: null,
      difficulty: 3,
      question_kind: 'short_answer',
      prompt_image_refs: [],
      wrong_answer_image_refs: [],
    }),
  });
}
