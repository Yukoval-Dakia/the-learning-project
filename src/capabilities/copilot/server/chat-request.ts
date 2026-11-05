// One complete request for durably accepting a conversation turn, shared by
// POST /api/copilot/chat and the Start server function. Errors are thrown as
// ApiError / ZodError-derived ApiError; each host renders them as its own response.
// Disconnects after acceptance only detach the client; the worker owns execution.

import { ZodError } from 'zod';
import type { Db } from '@/db/client';
import { shouldEnqueueBackgroundJobs } from '@/kernel/background-job-enqueue';
import { ApiError } from '@/kernel/http';
import { checkRateLimit } from '@/kernel/request-rate-limit';
import {
  type AcceptedCopilotTurn,
  acceptCopilotTurnAfterAdmission,
  recoverAcceptedCopilotTurn,
  requestAbortedError,
} from './chat-acceptance';
import { CopilotChatRequest } from './chat-contracts';
import * as Conversation from './conversation-lifecycle';
import { classifyCopilotAttachment, classifyCopilotTurn } from './crisis-guard';
import { MAX_OUTSTANDING_DURABLE_RUNS, countOutstandingDurableRuns } from './durable-backlog';
import { COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH, hashCopilotDurableInput } from './durable-dispatch';

// Closes the count-then-enqueue race inside the single Hono API process. A slot
// moves from this counter into durable job_events once QUEUED is committed.
let durableDispatchReservations = 0;

function assertRequestActive(signal: AbortSignal): void {
  if (signal.aborted) throw requestAbortedError();
}

type ParsedCopilotChatRequest = ReturnType<typeof CopilotChatRequest.parse>;

function durableAcceptance(acceptance: AcceptedCopilotTurn, parsed: ParsedCopilotChatRequest) {
  return {
    status: 202 as const,
    body: {
      run_id: acceptance.runId,
      session_id: acceptance.sessionId,
      derivation_policy: acceptance.derivationPolicy ?? 'allow',
      ...(parsed.triggered_by === 'chat' ? { checkpoint_event_id: acceptance.runId } : {}),
    },
    headers: {
      Location: `/api/jobs/copilot_run/${encodeURIComponent(acceptance.runId)}/events`,
    },
  };
}

export async function requestCopilotChat(
  db: Db,
  input: { readBody: () => Promise<unknown>; idempotencyKey: string | null; signal: AbortSignal },
) {
  // Validate before any durable side effect. HTTP owns acceptance, not execution.
  //
  // 危机分类必须先于 review_answer 契约检查——危机中的学习者绝不能因为携带
  // 附件而收到 400 校验错误而不是支持回应。命中危机分类时把 review_answer 从
  // 原始 body 中剔除：该回合按普通危机回合接纳（不附答案、不判分，worker 出
  // 同一条确定性支持模板），守卫事件只记 dropped_attachment_kind（记类型，不记
  // 原文）。分类是纯函数：同一 body 重放结果相同，剔除后的 parsed 与
  // durableInputHash 保持确定性。
  let parsed: ReturnType<typeof CopilotChatRequest.parse>;
  let crisisPreClassified: ReturnType<typeof classifyCopilotTurn> | null = null;
  let droppedReviewAnswer = false;
  try {
    let raw: unknown = await input.readBody();
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const rawBody = raw as Record<string, unknown>;
      if (typeof rawBody.user_message === 'string') {
        crisisPreClassified = classifyCopilotTurn(rawBody.user_message);
        if (!crisisPreClassified.forcedPolicy && rawBody.review_answer !== undefined) {
          crisisPreClassified = classifyCopilotAttachment(rawBody.review_answer);
        }
        if (
          crisisPreClassified.forcedPolicy &&
          (rawBody.review_answer !== undefined || rawBody.confirmation !== undefined)
        ) {
          droppedReviewAnswer = rawBody.review_answer !== undefined;
          raw = { ...rawBody, review_answer: undefined, confirmation: undefined };
        }
      }
    }
    parsed = CopilotChatRequest.parse(raw);
  } catch (err) {
    // A bare ZodError would surface as 500; schema failures are 400.
    if (err instanceof ZodError) {
      throw new ApiError('validation_error', err.issues.map((i) => i.message).join('; '), 400);
    }
    throw err;
  }
  const { signal } = input;
  if (signal.aborted) throw requestAbortedError();

  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  if (!idempotencyKey) {
    throw new ApiError('validation_error', 'Idempotency-Key is required', 400);
  }
  if (idempotencyKey.length > COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ApiError(
      'validation_error',
      `Idempotency-Key must be at most ${COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      400,
    );
  }
  const durableInputHash = hashCopilotDurableInput(parsed);

  // Replay accepted durable work before backlog/rate-limit/model triage.
  if (idempotencyKey) {
    const accepted = await recoverAcceptedCopilotTurn(db, {
      key: idempotencyKey,
      parsed,
      inputHash: durableInputHash,
    });
    if (accepted) return durableAcceptance(accepted, parsed);
  }

  // This flag disables queue writes in test environments; it is not a worker
  // health probe. Never fall back to request-owned execution.
  if (!shouldEnqueueBackgroundJobs()) {
    throw new ApiError('copilot_queue_disabled', 'Copilot queue is disabled', 503);
  }
  let reservedDispatchSlot = false;
  try {
    assertRequestActive(signal);
    const outstanding = await countOutstandingDurableRuns(db);
    assertRequestActive(signal);
    if (outstanding + durableDispatchReservations >= MAX_OUTSTANDING_DURABLE_RUNS) {
      throw new ApiError(
        'copilot_backlog_full',
        `Copilot backlog is full (max ${MAX_OUTSTANDING_DURABLE_RUNS})`,
        429,
        { 'Retry-After': '30' },
      );
    }
    durableDispatchReservations++;
    reservedDispatchSlot = true;
    checkRateLimit();
    assertRequestActive(signal);

    // 1) 复用 inline 同一会话信封：user_ask 与回复事件共享 session_id。
    const conv = await Conversation.findOrCreateCopilotConversation(db, {
      sessionId: parsed.session_id,
    });
    assertRequestActive(signal);
    // 2) 一个事务同时预留稳定 handle 并提交 user_ask + QUEUED。同 key + 同
    // normalized input 复用该 handle；input 变化是显式 409，而不是第二个付费 run。
    //
    // 接纳点危机分类（确定性词法，无模型调用）。命中时服务端强制
    // derivation_policy='crisis'（覆盖客户端送值）——该回合及其回复、镜像经既有
    // derivation-policy 机制被记忆摄取/简报横幅/画像排除；守卫事件与 user_ask
    // 同事务写入。回应模板在 worker 执行层出（见 jobs/copilot_run.ts 的 crisis
    // 分支），本层不产生文案。优先用接纳前的预分类（它已驱动附件剔除）；未预
    // 分类的奇异 body 由 parse 后文本再分类兜底。
    const crisis = crisisPreClassified ?? classifyCopilotTurn(parsed.user_message);
    const acceptance = await acceptCopilotTurnAfterAdmission(db, {
      key: idempotencyKey,
      parsed,
      inputHash: durableInputHash,
      sessionId: conv.sessionId,
      crisis,
      droppedReviewAnswer,
      signal: signal,
    });
    return durableAcceptance(acceptance, parsed);
  } finally {
    if (reservedDispatchSlot) durableDispatchReservations--;
  }
}
