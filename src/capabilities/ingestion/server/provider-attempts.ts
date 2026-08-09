import { RetryableError } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { provider_attempt } from '@/db/schema';
import {
  type DirectProviderAttemptControl,
  type DirectProviderOperationContext,
  ProviderAttemptLifecycleError,
  createDirectProviderOperationContext,
  executeDirectProviderAttempt,
  providerOperationIdForInvocation,
  writeCostLedger,
} from '@/server/ai/provider-attempt-runtime';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

export const GLM_OCR_LAYOUT_PARSING_LANE = 'glm.ocr-layout-parsing';
export const TENCENT_OCR_QUESTION_MARK_LANE = 'tencent.question-mark-agent';
export const TENCENT_OCR_SUBMIT_OPERATION_KIND = 'ocr_page_submit';
export const TENCENT_OCR_DESCRIBE_OPERATION_KIND = 'ocr_page_describe';

type TencentSubmitParams = {
  readonly ImageUrl?: string;
  readonly ImageBase64?: string;
  readonly ImageUrlList?: string[];
};
type TencentDescribeResponse = {
  readonly JobStatus?: 'WAIT' | 'RUN' | 'DONE' | 'FAIL';
  readonly RequestId?: unknown;
  readonly [key: string]: unknown;
};
type TencentSubmit = (params: TencentSubmitParams) => Promise<string>;
type TencentDescribe = (jobId: string) => Promise<TencentDescribeResponse>;

type LegacyOcrLedgerInput = {
  readonly db: Db;
  readonly bossJobId: string;
  readonly engine: 'glm' | 'tencent';
  readonly outcome: 'success' | 'failed_retryable' | 'failed_permanent';
  readonly promptTokens: number;
  readonly completionTokens: number;
};

export class ProviderAttemptResumeConflictError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`provider attempts contain conflicting saved Tencent JobIds for ${operationId}`);
    this.name = 'ProviderAttemptResumeConflictError';
    this.operationId = operationId;
  }
}

export class TencentSubmitInProgressError extends RetryableError {
  readonly pageOperationId: string;

  constructor(pageOperationId: string, cause: ProviderAttemptLifecycleError) {
    super(`Tencent Submit is already owned for page operation ${pageOperationId}`, { cause });
    this.name = 'TencentSubmitInProgressError';
    this.pageOperationId = pageOperationId;
  }
}

export function extractionPageOperationId(input: {
  readonly canonicalOperationId?: string;
  readonly bossJobId: string;
  readonly pageIndex: number;
}): string {
  const anchor = input.canonicalOperationId ?? input.bossJobId;
  return providerOperationIdForInvocation(`ingestion-ocr:${anchor}:page:${input.pageIndex}`);
}

export async function findSavedTencentJobId(
  db: Db,
  pageOperationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ jobId: provider_attempt.external_request_id })
    .from(provider_attempt)
    .where(
      and(
        eq(provider_attempt.operation_id, pageOperationId),
        eq(provider_attempt.provider, 'tencent'),
        eq(provider_attempt.lane_id, TENCENT_OCR_QUESTION_MARK_LANE),
        eq(provider_attempt.operation_kind, TENCENT_OCR_SUBMIT_OPERATION_KIND),
        isNotNull(provider_attempt.external_request_id),
      ),
    )
    .orderBy(desc(provider_attempt.started_at), desc(provider_attempt.attempt_id));
  const jobIds = new Set(rows.flatMap((row) => (row.jobId === null ? [] : [row.jobId])));
  if (jobIds.size > 1) throw new ProviderAttemptResumeConflictError(pageOperationId);
  return jobIds.values().next().value ?? null;
}

export function createOcrPageProviderContext(
  db: Db,
  pageOperationId: string,
): DirectProviderOperationContext {
  return createDirectProviderOperationContext({
    db,
    caller: 'worker',
    mode: 'observe',
    deadlineAt: new Date(Date.now() + 180_000),
    operationAnchor: pageOperationId,
  });
}

export type OcrPageProviderContext = DirectProviderOperationContext;
export type OcrPageProviderAttemptControl = DirectProviderAttemptControl;

export async function executeGlmOcrWireAttempt<T>(
  context: OcrPageProviderContext,
  execute: (attempt: OcrPageProviderAttemptControl) => Promise<T>,
): Promise<T> {
  const result = await executeDirectProviderAttempt(
    context,
    {
      provider: 'glm',
      model: 'glm-ocr',
      lane: GLM_OCR_LAYOUT_PARSING_LANE,
      protocol: 'http',
      endpointClass: 'glm.layout-parsing',
      operationKind: 'ocr_page_fetch',
      unknownCostCurrency: 'CNY',
    },
    execute,
  );
  return result.value;
}

export async function executeTencentOcrSubmit(input: {
  readonly db: Db;
  readonly pageOperationId: string;
  readonly deliveryRetryCount: number;
  readonly deliveryStartedOn: Date;
  readonly params: TencentSubmitParams;
  readonly submit: TencentSubmit;
}): Promise<string> {
  const deadlineAt = new Date(input.deliveryStartedOn.getTime() + 60_000);
  const context = createDirectProviderOperationContext({
    db: input.db,
    caller: 'worker',
    mode: 'observe',
    deadlineAt,
    operationAnchor: input.pageOperationId,
  });
  try {
    const result = await executeDirectProviderAttempt(
      context,
      {
        provider: 'tencent',
        model: 'QuestionMarkAgent',
        lane: TENCENT_OCR_QUESTION_MARK_LANE,
        protocol: 'http',
        endpointClass: 'tencent.question-mark-agent.submit',
        operationKind: TENCENT_OCR_SUBMIT_OPERATION_KIND,
        unknownCostCurrency: 'CNY',
        attemptAnchor: `ingestion-ocr:${input.pageOperationId}:tencent-submit:generation:${input.deliveryRetryCount}`,
      },
      async (attempt) => {
        const jobId = await input.submit(input.params);
        await attempt.recordExternalRequestId(jobId);
        return jobId;
      },
    );
    return result.value;
  } catch (error) {
    if (!(error instanceof ProviderAttemptLifecycleError)) throw error;
    switch (error.reason) {
      case 'active_duplicate':
      case 'deadline_mismatch':
      case 'recovery_required':
      case 'terminal_reuse':
        break;
      default:
        throw error;
    }
    const savedJobId = await findSavedTencentJobId(input.db, input.pageOperationId);
    if (savedJobId !== null) return savedJobId;
    throw new TencentSubmitInProgressError(input.pageOperationId, error);
  }
}

export async function executeTencentOcrDescribe(input: {
  readonly db: Db;
  readonly pageOperationId: string;
  readonly jobId: string;
  readonly describe: TencentDescribe;
}): Promise<TencentDescribeResponse> {
  const context = createDirectProviderOperationContext({
    db: input.db,
    caller: 'worker',
    mode: 'observe',
    deadlineAt: new Date(Date.now() + 60_000),
    operationAnchor: input.pageOperationId,
  });
  const result = await executeDirectProviderAttempt(
    context,
    {
      provider: 'tencent',
      model: 'QuestionMarkAgent',
      lane: TENCENT_OCR_QUESTION_MARK_LANE,
      protocol: 'http',
      endpointClass: 'tencent.question-mark-agent.describe',
      operationKind: TENCENT_OCR_DESCRIBE_OPERATION_KIND,
      unknownCostCurrency: 'CNY',
    },
    async (attempt) => {
      const response = await input.describe(input.jobId);
      const requestId = response.RequestId;
      if (typeof requestId === 'string' && requestId.trim().length > 0) {
        await attempt.recordExternalRequestId(requestId);
      }
      if (response.JobStatus === 'FAIL') {
        attempt.markTerminal('failed', 'provider_job_failed');
      }
      return response;
    },
  );
  return result.value;
}

/** Transitional legacy zero/estimated ledger mirror; delete with F0.5 cutover. */
export async function writeLegacyOcrCostLedger(input: LegacyOcrLedgerInput): Promise<void> {
  const tokensIn = input.engine === 'glm' ? input.promptTokens : 0;
  const tokensOut = input.engine === 'glm' ? input.completionTokens : 0;
  await writeCostLedger(input.db, {
    task_kind: 'tencent_ocr_extract',
    provider: input.engine,
    model: input.engine === 'glm' ? 'glm-ocr' : 'QuestionMarkAgent',
    cost: input.engine === 'glm' ? ((tokensIn + tokensOut) / 1_000_000) * 0.2 : 0,
    currency: 'CNY',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    outcome: input.outcome,
    pgboss_job_id: input.bossJobId,
  });
}
