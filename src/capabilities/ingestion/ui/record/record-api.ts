// Record page transport (YUK-1473). Thin calls over the ingestion routes in
// src/capabilities/ingestion/manifest.ts; no learner rules live here.

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  ApiError,
  type ApiOperationJsonResponse,
  type ApiOperationRequestBody,
  apiFetch,
  apiOperationJson,
} from '@/ui/lib/api';
import { expandDocx, expandPdf, uploadAsset } from '@/ui/lib/assets';
import {
  type IngestionOperationResource,
  runIngestionOperation,
} from '@/ui/lib/ingestion-operations';

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

/**
 * A recognised question as GET /blocks returns it. Current extraction leaves extracted_prompt_md
 * and reference_md null and keeps the question in `structured`; older rows may lack spans or refs.
 */
export interface Block {
  id: string;
  /** The row's real version. An older server leaves it out; then nothing can be confirmed. */
  version?: number;
  source_asset_ids: string[] | null;
  page_spans: PageSpan[] | null;
  extracted_prompt_md: string | null;
  structured: StructuredQuestionT | null;
  reference_md: string | null;
  wrong_answer_md: string | null;
  image_refs: string[] | null;
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

export function projectSessionListResponse(
  body: ApiOperationJsonResponse<'listIngestionSessions'>,
): SessionRow[] {
  return body.data as SessionRow[];
}

export async function listSessions(): Promise<SessionRow[]> {
  const body = await apiOperationJson('listIngestionSessions', {
    url: '/api/ingestion-sessions?limit=30',
    method: 'GET',
  });
  return projectSessionListResponse(body);
}

export const getHistory = (id: string) =>
  apiOperationJson('getIngestionSessionHistory', {
    url: `/api/ingestion-sessions/${encodeURIComponent(id)}/history`,
    method: 'GET',
    init: { cache: 'no-store' },
  });

export function projectRecordSessionDetailResponse(
  body: ApiOperationJsonResponse<'getIngestionSession'>,
): SessionDetail {
  return body as SessionDetail;
}

export async function getSession(id: string): Promise<SessionDetail> {
  const body = await apiOperationJson('getIngestionSession', {
    url: `/api/ingestion-sessions/${encodeURIComponent(id)}`,
    method: 'GET',
    init: { cache: 'no-store' },
  });
  return projectRecordSessionDetailResponse(body);
}

export function projectSessionBlocksResponse(
  body: ApiOperationJsonResponse<'listIngestionSessionBlocks'>,
): Block[] {
  return body.rows as Block[];
}

export async function listBlocks(id: string): Promise<Block[]> {
  const body = await apiOperationJson('listIngestionSessionBlocks', {
    url: `/api/ingestion/${encodeURIComponent(id)}/blocks`,
    method: 'GET',
  });
  return projectSessionBlocksResponse(body);
}

export async function listKnowledge(): Promise<KnowledgeNode[]> {
  const body = await apiOperationJson('getKnowledgeTreeSnapshot', {
    url: '/api/knowledge',
    method: 'GET',
  });
  return body.rows as KnowledgeNode[];
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

export type CreateRecordSessionInput = {
  entrypoint: Exclude<Entrypoint, 'docx'>;
  assetIds: string[];
  policy: UsePolicy;
};

export function buildRecordSessionCreateBody(input: CreateRecordSessionInput) {
  return {
    entrypoint: input.entrypoint,
    asset_ids: input.assetIds,
    ...(input.policy === 'answer_only' ? { derivation_policy: 'answer_only' as const } : {}),
  };
}

export function projectRecordSessionCreateResponse(
  body: ApiOperationJsonResponse<'createIngestionSession'>,
): string {
  return body.session.id;
}

export async function createSession(input: CreateRecordSessionInput): Promise<string> {
  const body = await apiOperationJson('createIngestionSession', {
    url: '/api/ingestion-sessions',
    method: 'POST',
    body: buildRecordSessionCreateBody(input),
  });
  return projectRecordSessionCreateResponse(body);
}

export async function createDocxSession(file: File, policy: UsePolicy): Promise<string> {
  const body = await expandDocx(
    file,
    policy === 'answer_only' ? { derivationPolicy: 'answer_only' } : {},
  );
  return body.session_id;
}

/**
 * Starts a lane. The caller owns the key, so a manual retry replays the same start. A replay of a
 * start the server already refused comes back 200 with status 'failed'; that is thrown as the
 * refusal it was, never read as started.
 */
export async function startLane(id: string, kind: 'extract' | 'agent', key: string) {
  const res = await apiFetch(`/api/ingestion-sessions/${encodeURIComponent(id)}/operations`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ kind }),
  });
  const op = (await res.json().catch(() => null)) as IngestionOperationResource | null;
  if (op?.status === 'failed') {
    const e = op.error;
    throw new ApiError(e?.message ?? 'start refused', e?.status ?? 500, e?.code, { ...e });
  }
}

export async function answerAsk(id: string, askId: string, answer: AskAnswerBody, key: string) {
  await apiFetch(
    `/api/ingestion-sessions/${encodeURIComponent(id)}/asks/${encodeURIComponent(askId)}/answers`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ answer }),
    },
  );
}

/** Puts recognised questions into the library; resolves once the server finished. */
export const importBlocks = (id: string, blocks: ImportBlockBody[]) =>
  runIngestionOperation(id, { kind: 'import', input: { blocks } });

export interface CheckedBlock {
  block_id: string;
  version: number;
}

/**
 * Records that the learner checked every question of a classic recording (YUK-1522). Resolves
 * only once the operation finished; the caller owns the key so an unknown outcome is looked up
 * with the same key and body instead of sending a second one.
 */
export const reviewBlocks = (id: string, checked: CheckedBlock[], key: string) =>
  runIngestionOperation<{ status?: string }>(
    id,
    { kind: 'review', input: { checked_blocks: checked } },
    { idempotencyKey: key },
  );

/**
 * Reads one recognised question again from its page with a stronger reader (paid, learner-pressed).
 * The key is the caller's, so a retry after a lost response replays the same read.
 */
export const rescueBlock = (id: string, blockId: string, page: number, tier: 2 | 3, key: string) =>
  runIngestionOperation(
    id,
    { kind: 'rescue', input: { block_id: blockId, page, tier } },
    { idempotencyKey: key },
  );

export async function revertBlock(id: string, blockId: string) {
  await apiFetch(`/api/ingestion/${encodeURIComponent(id)}/revert`, {
    method: 'POST',
    body: JSON.stringify({ block_id: blockId }),
  });
}

export type RecordManualMistakeInput = {
  prompt: string;
  answer: string;
  knowledgeIds: string[];
};

export function buildRecordManualMistakeBody(
  input: RecordManualMistakeInput,
): ApiOperationRequestBody<'createMistake'> {
  return {
    prompt_md: input.prompt,
    reference_md: null,
    wrong_answer_md: input.answer,
    knowledge_ids: input.knowledgeIds,
    cause: null,
    difficulty: 3,
    question_kind: 'short_answer',
    prompt_image_refs: [],
    wrong_answer_image_refs: [],
  };
}

export async function createWrongAnswer(input: RecordManualMistakeInput) {
  return apiOperationJson('createMistake', {
    url: '/api/mistakes',
    method: 'POST',
    body: buildRecordManualMistakeBody(input),
  });
}

export type PurposeInput = ApiOperationRequestBody<'changeIngestionPurpose'>;
export type PurposeImpact = ApiOperationJsonResponse<'getIngestionPurposeImpact'>;
export type PurposeResult = ApiOperationJsonResponse<'changeIngestionPurpose'>;

export function purposeLocation(id: string, requestId?: string): string {
  const path = `/api/ingestion-sessions/${encodeURIComponent(id)}/purpose`;
  return requestId ? `${path}?request_id=${encodeURIComponent(requestId)}` : path;
}

/** A receipt Location must stay bound to this session and this exact request. */
function checkedPurposeLocation(id: string, requestId: string, location: string): string {
  const base = window.location.origin;
  const actual = new URL(location, base);
  const expected = new URL(purposeLocation(id, requestId), base);
  if (actual.href !== expected.href) {
    throw new ApiError(
      '用途回执地址与原请求不一致，保留原请求等待核对。',
      0,
      'purpose_location_mismatch',
    );
  }
  return actual.pathname + actual.search;
}

export async function getPurposeImpact(id: string, requestId?: string, location?: string) {
  const url =
    requestId && location
      ? checkedPurposeLocation(id, requestId, location)
      : purposeLocation(id, requestId);
  const impact = await apiOperationJson('getIngestionPurposeImpact', {
    url,
    method: 'GET',
    init: { cache: 'no-store' },
  });
  if (impact.current.session_id !== id) {
    throw new ApiError('用途记录与这次录入不一致。', 0, 'purpose_session_mismatch');
  }
  return impact;
}

/** Generated wire types; raw response retained only to consume the canonical Location header. */
export async function changePurpose(id: string, body: PurposeInput) {
  const response = await apiFetch(purposeLocation(id), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const location = checkedPurposeLocation(
    id,
    body.request_id,
    response.headers.get('Location') ?? purposeLocation(id, body.request_id),
  );
  const result = (await response.json()) as PurposeResult;
  return { ...result, location };
}
