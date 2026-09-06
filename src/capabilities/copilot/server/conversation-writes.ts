// Copilot conversation writes: accepted input, committed reply, and atomic teaching output.
// Execution and queue ownership live in copilot_run and durable-dispatch.

import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { Db, Tx } from '@/db/client';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import type { CopilotModeState, CopilotSkillContextT, CopilotSkillTurn } from './chat-contracts';
import {
  type CopilotReplyFinalizationReceipt,
  type PreparedCopilotReply,
  extractPrimaryView,
  sealCommittedPresentationReply,
} from './reply-finalization';
import type { TeachingSkillResult } from './skills/teaching-skill';
import { materializeAskCheckQuestion } from './teaching/materialize-ask-check';
import type { CopilotPrimaryView } from './turns';

export type { PreparedCopilotReply } from './reply-finalization';

type WriteEventFn = (db: Db | Tx, input: WriteEventInput) => Promise<string>;

const CHIP_TRIGGER_EVENT_ACTION = 'experimental:copilot_chip_trigger';
const USER_ASK_EVENT_ACTION = 'experimental:copilot_user_ask';
// AF S3a / YUK-203 U3 — Copilot reply留痕. New experimental action (NOT in
// RESERVED_EXPERIMENTAL_ACTIONS), so it parses via the generic ExperimentalEvent
// escape hatch — zero schema change. Payload is free-form per ExperimentalEvent
// (z.record). See L-copilot pre-flight缺口表.
const REPLY_EVENT_ACTION = 'experimental:copilot_reply';

/** Persist the accepted ask/chip identity used by FIFO, replay and causal tool mirrors. */
export async function writeCopilotInputEvent(
  db: Db | Tx,
  params: {
    sessionId: string;
    userMessage: string;
    triggeredBy?: 'chat' | 'chip';
    chipKind?: string;
    now: Date;
    /** Stable id for an idempotently accepted turn; fixture callers may omit it. */
    eventId?: string;
    writeFn?: (db: Db | Tx, event: WriteEventInput) => Promise<unknown>;
  },
): Promise<string> {
  const write = params.writeFn ?? writeEvent;
  const isChip = params.triggeredBy === 'chip';
  const userAskEventId =
    params.eventId ?? `${isChip ? 'copilot_chip' : 'copilot_user_ask'}_${createId()}`;
  await write(db, {
    id: userAskEventId,
    session_id: params.sessionId,
    actor_kind: isChip ? 'system' : 'user',
    actor_ref: isChip ? 'ui:copilot_chip' : 'user:self',
    action: isChip ? CHIP_TRIGGER_EVENT_ACTION : USER_ASK_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: userAskEventId,
    outcome: null,
    payload: {
      surface: 'copilot',
      user_message: params.userMessage,
      ...(isChip ? { chip_kind: params.chipKind ?? null } : {}),
      // AF S3a — redundant portable copy of the conversation envelope id.
      session_id: params.sessionId,
    },
    created_at: params.now,
  });
  return userAskEventId;
}

/** The commit owner seals product-state disclosure and stores one causal reply. */
export interface WriteCopilotReplyResult {
  replyEventId: string;
  /** 剥掉 legacy primary_view marker 后的终稿（持久化 / 返回 / 重放历史都用这份）。 */
  cleanedReply: string;
  /** 模型 nominate 的 hero（无则 undefined）。 */
  primaryView?: CopilotPrimaryView;
}

export interface CopilotEvidenceValidationRef {
  status: 'pass' | 'repair' | 'degraded' | 'failed_closed';
  reference_task_run_ids: string[];
  comparison_task_run_ids: string[];
}

export async function writeCopilotReply(
  db: Db | Tx,
  params: {
    sessionId: string;
    /** Server-generated id shared with teaching question source_ref. */
    replyEventId?: string;
    teaching?: { context: CopilotSkillContextT; turn: CopilotSkillTurn };
    /** caused_by + in_reply_to 锚——通常是 user_ask（chat）或 chip trigger event id。 */
    userAskEventId?: string;
    /** 模型终稿；遗留 primary_view marker 只会被剥除，不再授予展示权限。 */
    replyText: string;
    /**
     * A reply already normalized by root finalization. When present,
     * its digest is checked before the commit owner seals product-state disclosure.
     */
    preparedReply?: PreparedCopilotReply;
    /** Actor identity resolved by the execution owner. */
    actorRef: string;
    /** 真实 task_run_id（cost-trace 链锚）。 */
    taskRunId: string;
    /** Sealed FULL-validator run linkage; contains no model prose or reasoning. */
    evidenceValidation?: CopilotEvidenceValidationRef;
    /** Compact root-owned structural finalization receipt for new Copilot replies. */
    replyFinalization?: CopilotReplyFinalizationReceipt;
    /** Product mode state persisted with the reply; never included in model input. */
    modeState?: CopilotModeState;
    /**
     * Optional terminal outcome for durable recovery. Historical callers may
     * omit it, preserving legacy null outcomes. A durable success
     * marker lets a pg-boss redelivery repair missing job terminal events
     * without running the paid model/tools a second time.
     */
    outcome?: 'success' | 'failure' | 'partial';
    /** Durable success metadata needed to rebuild the DONE projection. */
    durableFinishReason?: string;
    /**
     * Durable YUK-832 projection contract. When true, recovery must publish one
     * finalized full-text DELTA in the same transaction and immediately before
     * REPLY/DONE or FAILED. The marker makes that suffix recoverable after an
     * owner crash; legacy markers omit it and keep their previous projection.
     */
    durableEmitReviewedDelta?: boolean;
    /** Durable failure metadata needed to rebuild the FAILED projection. */
    durableFailure?: { reason: string; error: string; checkpoint_safe?: boolean };
    /** ask 的 created_at；reply 戳 now+1ms 保证 (created_at,id) 排序里 reply 在 ask 之后。 */
    now: Date;
    writeFn?: WriteEventFn;
  },
): Promise<WriteCopilotReplyResult> {
  const write = params.writeFn ?? writeEvent;
  if (params.preparedReply && params.preparedReply.text !== params.replyText) {
    throw new Error('prepared copilot reply bytes do not match replyText');
  }
  // Verify the incoming seal before applying the commit-owned storage policy.
  // Model normalization is already complete; legacy callers only strip markers.
  // The product policy reseals its own final bytes below, never a stale digest.
  const prepared =
    params.preparedReply ??
    ({
      text: extractPrimaryView(params.replyText, {
        taskRunId: params.taskRunId,
      }).text,
    } satisfies PreparedCopilotReply);
  if (
    params.replyFinalization &&
    params.replyFinalization.reply_sha256 !==
      createHash('sha256').update(prepared.text, 'utf8').digest('hex')
  ) {
    throw new Error('copilot reply finalization digest does not match persisted bytes');
  }
  const sealed = sealCommittedPresentationReply(prepared, params.replyFinalization);
  const cleanedReply = sealed.preparedReply.text;
  const primaryView = prepared.primaryView;
  // created_at 严格晚于 ask（now + 1ms）：整轮共享一个 now，无偏移则 ask/reply
  // 在 created_at 上打平，turns 读取器的 (created_at, id) 排序可能把 reply 排到自己
  // 的 ask 之前。reply 真在 ask 之后发生，1ms bump 既忠实又保 pair 顺序。
  const replyAt = new Date(params.now.getTime() + 1);
  const replyEventId = params.replyEventId ?? `copilot_reply_${createId()}`;
  await write(db, {
    id: replyEventId,
    session_id: params.sessionId,
    actor_kind: 'agent',
    actor_ref: params.actorRef,
    action: REPLY_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: replyEventId,
    outcome: params.outcome ?? null,
    payload: {
      surface: 'copilot',
      session_id: params.sessionId,
      reply_md: cleanedReply,
      task_run_id: params.taskRunId,
      ...(params.evidenceValidation ? { evidence_validation: params.evidenceValidation } : {}),
      ...(sealed.receipt ? { reply_finalization: sealed.receipt } : {}),
      ...(params.durableFinishReason ? { durable_finish_reason: params.durableFinishReason } : {}),
      ...(params.durableEmitReviewedDelta ? { durable_emit_reviewed_delta: true } : {}),
      ...(params.durableFailure ? { durable_failure: params.durableFailure } : {}),
      ...(params.modeState ?? {}),
      ...(params.teaching
        ? {
            turn_kind: params.teaching.turn.kind,
            skill_turn: params.teaching.turn,
            skill_context: params.teaching.context,
          }
        : {}),
      in_reply_to_event_id: params.userAskEventId ?? null,
      // YUK-307 (S3a additive) — persist hero nomination so Dock replay can restore
      // it. Reply METADATA only（assembleConversationHistory 的 {role,text} strip 把
      // 它结构性挡在每条未来 prompt 外，YUK-267 红线）。conditional spread — 无 nomination
      // 时 payload 与 pre-YUK-307 byte-identical。
      ...(primaryView ? { primary_view: primaryView } : {}),
    },
    caused_by_event_id: params.userAskEventId ?? null,
    task_run_id: params.taskRunId,
    created_at: replyAt,
  });
  return primaryView ? { replyEventId, cleanedReply, primaryView } : { replyEventId, cleanedReply };
}

/** Question materialization and the terminal reply are one teaching-owned commit. */
export async function writeTeachingCopilotReply(
  db: Db | Tx,
  params: Pick<
    Parameters<typeof writeCopilotReply>[1],
    | 'sessionId'
    | 'userAskEventId'
    | 'actorRef'
    | 'durableFinishReason'
    | 'durableEmitReviewedDelta'
    | 'now'
    | 'writeFn'
  > & {
    outcome?: 'success';
    skillContext: CopilotSkillContextT;
    skillResult: TeachingSkillResult;
    materializeAskCheckFn?: typeof materializeAskCheckQuestion;
  },
): Promise<WriteCopilotReplyResult & { skillTurn: CopilotSkillTurn; materialized: boolean }> {
  const { skillContext, skillResult, materializeAskCheckFn, ...commit } = params;
  return db.transaction(async (tx) => {
    const replyEventId = `copilot_reply_${createId()}`;
    const question = skillResult.pendingQuestion
      ? await (materializeAskCheckFn ?? materializeAskCheckQuestion)(tx, {
          ...skillResult.pendingQuestion,
          sourceRef: replyEventId,
        })
      : undefined;
    const skillTurn: CopilotSkillTurn = {
      kind: skillResult.kind,
      suggested_next: skillResult.suggested_next,
      ...(question ? { structured_question: question } : {}),
    };
    const reply = await writeCopilotReply(tx, {
      ...commit,
      replyEventId,
      replyText: skillResult.text_md,
      taskRunId: skillResult.task_run_id,
      teaching: { context: skillContext, turn: skillTurn },
    });
    return { ...reply, skillTurn, materialized: Boolean(question) };
  });
}
