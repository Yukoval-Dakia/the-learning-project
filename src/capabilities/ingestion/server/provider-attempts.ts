import { sql } from 'drizzle-orm';
import { RetryableError } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import {
  type DirectProviderAttemptControl,
  type DirectProviderOperationContext,
  ProviderAttemptAdmissionLaneSchema,
  ProviderAttemptLifecycleError,
  createDirectProviderOperationContext,
  executeDirectProviderAttempt,
  providerOperationIdForInvocation,
  resolveProviderAttemptAdmission,
} from '@/server/ai/provider-attempt-runtime';

export { ProviderAttemptLifecycleError };

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
  readonly reason: ProviderAttemptLifecycleError['reason'];

  constructor(pageOperationId: string, cause: ProviderAttemptLifecycleError) {
    super(`Tencent Submit is already owned for page operation ${pageOperationId}`, { cause });
    this.name = 'TencentSubmitInProgressError';
    this.pageOperationId = pageOperationId;
    this.reason = cause.reason;
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

type TencentSubmitHistoryRow = {
  readonly attempt_id: string;
  readonly external_request_id: string | null;
  readonly provider_start_reserved_at: Date | string | null;
  readonly admission_status: string | null;
  readonly lease_live: boolean;
};

type TencentSubmitHistoryResolution =
  | { readonly kind: 'needs_fence' }
  | { readonly kind: 'resume'; readonly jobId: string }
  | { readonly kind: 'submit' };

async function resolveTencentSubmitHistory(
  db: Db,
  pageOperationId: string,
): Promise<TencentSubmitHistoryResolution> {
  const rows = await db.execute<TencentSubmitHistoryRow>(sql`
    SELECT a.attempt_id::text, a.external_request_id, a.provider_start_reserved_at,
      d.status AS admission_status,
      COALESCE(d.status IN ('acquired', 'would_deny')
        AND d.lease_expires_at > clock_timestamp()
        AND d.deadline_at > clock_timestamp(), false) AS lease_live
    FROM provider_attempt a
    LEFT JOIN provider_attempt_admission d USING (attempt_id)
    WHERE a.operation_id = ${pageOperationId}
      AND a.provider = 'tencent'
      AND a.lane_id = ${TENCENT_OCR_QUESTION_MARK_LANE}
      AND a.operation_kind = ${TENCENT_OCR_SUBMIT_OPERATION_KIND}
    ORDER BY a.started_at DESC, a.attempt_id DESC
  `);
  const savedJobIds = new Set(
    rows.flatMap((row) => (row.external_request_id === null ? [] : [row.external_request_id])),
  );
  if (savedJobIds.size > 1) throw new ProviderAttemptResumeConflictError(pageOperationId);
  const liveBlocker = rows.find((row) => row.provider_start_reserved_at !== null && row.lease_live);
  if (liveBlocker) {
    throw new TencentSubmitInProgressError(
      pageOperationId,
      new ProviderAttemptLifecycleError('active_duplicate', liveBlocker.attempt_id),
    );
  }
  const expiredActive = rows.some(
    (row) =>
      row.provider_start_reserved_at !== null &&
      (row.admission_status === 'acquired' || row.admission_status === 'would_deny'),
  );
  if (expiredActive) return { kind: 'needs_fence' };
  const recoveryBlocker = rows.find(
    (row) => row.provider_start_reserved_at !== null && row.external_request_id === null,
  );
  if (recoveryBlocker) {
    throw new TencentSubmitInProgressError(
      pageOperationId,
      new ProviderAttemptLifecycleError('recovery_required', recoveryBlocker.attempt_id),
    );
  }
  const savedJobId = savedJobIds.values().next().value;
  return savedJobId === undefined ? { kind: 'submit' } : { kind: 'resume', jobId: savedJobId };
}

async function resolveTencentSubmitHistoryForAdmission(input: {
  readonly db: Db;
  readonly pageOperationId: string;
  readonly attemptId: string;
  readonly mode: 'off' | 'observe' | 'enforce';
}): Promise<TencentSubmitHistoryResolution> {
  try {
    return await resolveTencentSubmitHistory(input.db, input.pageOperationId);
  } catch (error) {
    if (
      error instanceof ProviderAttemptResumeConflictError ||
      error instanceof TencentSubmitInProgressError
    ) {
      throw error;
    }
    if (input.mode === 'enforce') {
      throw new ProviderAttemptLifecycleError('control_plane_unavailable', input.attemptId, error);
    }
    return { kind: 'submit' };
  }
}

export function createOcrPageProviderContext(
  db: Db,
  pageOperationId: string,
): DirectProviderOperationContext {
  return createDirectProviderOperationContext({
    db,
    caller: 'worker',
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
  readonly bossJobId: string;
  readonly deliveryRetryCount: number;
  readonly deliveryStartedOn: Date;
  readonly params: TencentSubmitParams;
  readonly submit: TencentSubmit;
  readonly afterJobSaved?: (jobId: string) => Promise<void>;
}): Promise<string> {
  const attemptAnchor = `ingestion-ocr:${input.pageOperationId}:tencent-submit:${input.bossJobId}:delivery:${input.deliveryRetryCount}`;
  const attemptId = providerOperationIdForInvocation(attemptAnchor);
  const configured = resolveProviderAttemptAdmission(
    process.env,
    ProviderAttemptAdmissionLaneSchema.parse(TENCENT_OCR_QUESTION_MARK_LANE),
  );
  const history = await resolveTencentSubmitHistoryForAdmission({
    db: input.db,
    pageOperationId: input.pageOperationId,
    attemptId,
    mode: configured.mode,
  });
  if (history.kind === 'resume') return history.jobId;
  const deadlineAt = new Date(input.deliveryStartedOn.getTime() + 60_000);
  const context = createDirectProviderOperationContext({
    db: input.db,
    caller: 'worker',
    mode: configured.mode,
    policy: configured.policy,
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
        attemptAnchor,
        providerStartFence: 'operation_kind',
      },
      async (attempt) => {
        const jobId = await input.submit(input.params);
        await attempt.recordExternalRequestId(jobId);
        return jobId;
      },
    );
    await input.afterJobSaved?.(result.value);
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
    const resolved = await resolveTencentSubmitHistoryForAdmission({
      db: input.db,
      pageOperationId: input.pageOperationId,
      attemptId,
      mode: configured.mode,
    });
    if (resolved.kind === 'resume') return resolved.jobId;
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
