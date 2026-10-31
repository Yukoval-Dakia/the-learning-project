// Copilot conversation writes: accepted input, committed reply, and atomic teaching output.
// Execution and queue ownership live in copilot_run and durable-dispatch.

import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import { ApiError } from '@/kernel/http';
import type { CopilotPublicProse, CopilotPublicProseFailure } from '../public-prose-contract';
import type { CopilotModeState, CopilotSkillContextT, CopilotSkillTurn } from './chat-contracts';
import { type ReviewAnswerAttachment, captureReviewAnswerBinding } from './practice-port';
import {
  publicProseFailureForReason,
  publicProseFailureMessage,
  publicProseStatus,
  readCopilotPublicProse,
} from './public-prose';
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
// Experimental action parsed by the generic ExperimentalEvent escape hatch, so
// no schema change is needed; its payload is free-form per that event.
const REPLY_EVENT_ACTION = 'experimental:copilot_reply';

/** Persist the accepted ask/chip identity used by FIFO, replay and causal tool mirrors. */
export async function writeCopilotInputEvent(
  db: Db | Tx,
  params: {
    sessionId: string;
    userMessage: string;
    derivationPolicy?: DerivationPolicyT;
    reviewAnswer?: ReviewAnswerAttachment;
    triggeredBy?: 'chat' | 'chip';
    chipKind?: string;
    now: Date;
    /** Stable id for an idempotently accepted turn; fixture callers may omit it. */
    eventId?: string;
    writeFn?: (db: Db | Tx, event: WriteEventInput) => Promise<unknown>;
  },
): Promise<string> {
  // crisis 与 answer_only 同为受限回合，都不接纳 review_answer。未传策略即
  // allow（fixture / 旧调用方），不能被当成受限回合拒掉。
  const policy = params.derivationPolicy ?? 'allow';
  if (params.reviewAnswer && policy !== 'allow') {
    throw new ApiError(
      'validation_error',
      `review_answer is not supported for ${policy} turns`,
      400,
    );
  }
  if (params.reviewAnswer) return db.transaction((tx) => persistCopilotInputEvent(tx, params));
  return persistCopilotInputEvent(db, params);
}

async function persistCopilotInputEvent(
  db: Db | Tx,
  params: Parameters<typeof writeCopilotInputEvent>[1],
): Promise<string> {
  const write = params.writeFn ?? writeEvent;
  const isChip = params.triggeredBy === 'chip';
  const userAskEventId =
    params.eventId ?? `${isChip ? 'copilot_chip' : 'copilot_user_ask'}_${createId()}`;
  const requestedReviewAnswer = params.reviewAnswer;
  const reviewAnswer = requestedReviewAnswer
    ? await db.transaction((tx) =>
        captureReviewAnswerBinding(tx, {
          sessionId: params.sessionId,
          originalRef: userAskEventId,
          original: requestedReviewAnswer,
        }),
      )
    : undefined;
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
      derivation_policy: readDerivationPolicy({ derivation_policy: params.derivationPolicy }),
      ...(reviewAnswer ? { review_answer: reviewAnswer } : {}),
      ...(isChip ? { chip_kind: params.chipKind ?? null } : {}),
      // Redundant portable copy of the conversation envelope id.
      session_id: params.sessionId,
    },
    created_at: params.now,
  });
  return userAskEventId;
}

/** Seals product-state disclosure and stores one causal reply. */
export interface WriteCopilotReplyResult {
  replyEventId: string;
  /** 剥掉 legacy primary_view marker 后的终稿（持久化 / 返回 / 重放历史都用这份）。 */
  cleanedReply: string;
  primaryView?: CopilotPrimaryView;
  publicProse?: CopilotPublicProse;
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
     * A reply already normalized by root finalization. When present, its digest
     * is checked before the commit owner seals product-state disclosure.
     */
    preparedReply?: PreparedCopilotReply;
    /** Actor identity resolved by the execution owner. */
    actorRef: string;
    /** 真实 task_run_id（cost-trace 链锚）。 */
    taskRunId: string;
    /** Sealed FULL-validator run linkage; contains no model prose or reasoning. */
    evidenceValidation?: CopilotEvidenceValidationRef;
    /** Compact root-owned structural finalization receipt. */
    replyFinalization?: CopilotReplyFinalizationReceipt;
    /** Product mode state persisted with the reply; never included in model input. */
    modeState?: CopilotModeState;
    /** Structured, whitelisted failure supplied by the execution owner; never raw errors. */
    publicProseFailure?: CopilotPublicProseFailure;
    /**
     * Optional terminal outcome for durable recovery. A durable success marker
     * lets a pg-boss redelivery repair missing job terminal events without
     * running the paid model/tools a second time; historical callers may omit it.
     */
    outcome?: 'success' | 'failure' | 'partial';
    /** Durable success metadata needed to rebuild the DONE projection. */
    durableFinishReason?: string;
    /** Durable failure metadata needed to rebuild the FAILED projection. */
    durableFailure?: { reason: string; error: string; checkpoint_safe?: boolean };
    /** ask 的 created_at；reply 戳 now+1ms 保证 (created_at,id) 排序里 reply 在 ask 之后。 */
    now: Date;
    writeFn?: WriteEventFn;
  },
): Promise<WriteCopilotReplyResult> {
  const write = params.writeFn ?? writeEvent;
  // Durable callers hold the original settlement lock. Freeze the committed
  // public channel in this same reply marker, before any terminal suffix.
  const publicProse: CopilotPublicProse | undefined =
    params.userAskEventId && params.outcome
      ? {
          ...((await readCopilotPublicProse(db, [params.userAskEventId])).get(
            params.userAskEventId,
          ) ?? { version: 1 as const, text: '', last_event_id: 0 }),
          status: publicProseStatus(
            params.outcome === 'success'
              ? undefined
              : (params.publicProseFailure ??
                  publicProseFailureForReason(params.durableFailure?.reason)),
          ),
          ...(params.outcome === 'success'
            ? {}
            : {
                failure:
                  params.publicProseFailure ??
                  publicProseFailureForReason(params.durableFailure?.reason),
              }),
        }
      : undefined;
  const preservePublic = publicProse && params.outcome !== 'success';
  const replyText = preservePublic
    ? publicProse.text || publicProseFailureMessage(publicProse.failure)
    : params.replyText;
  const prepared = preservePublic
    ? { text: replyText }
    : params.preparedReply?.text === params.replyText
      ? params.preparedReply
      : {
          text: extractPrimaryView(params.replyText, {
            taskRunId: params.taskRunId,
          }).text,
        };
  const persistedDigest = createHash('sha256').update(prepared.text, 'utf8').digest('hex');
  const receiptMatches = params.replyFinalization?.reply_sha256 === persistedDigest;
  if (params.replyFinalization && !receiptMatches) {
    console.warn('[writeCopilotReply] dropped finalization receipt', {
      run_id: params.userAskEventId ?? params.taskRunId,
      task_run_id: params.taskRunId,
      reason:
        params.preparedReply?.text === params.replyText
          ? 'digest_does_not_match_prepared_text'
          : 'prepared_text_does_not_match_reply_text',
    });
  }
  const receipt = receiptMatches ? params.replyFinalization : undefined;
  const sealed = sealCommittedPresentationReply(prepared, receipt);
  const cleanedReply = sealed.preparedReply.text;
  const primaryView = receipt ? sealed.preparedReply.primaryView : undefined;
  // created_at 严格晚于 ask（now + 1ms）：整轮共享一个 now，无偏移则 ask/reply
  // 在 created_at 上打平，turns 读取器的 (created_at, id) 排序可能把 reply 排到
  // 自己的 ask 之前。
  const derivationPolicy = params.userAskEventId
    ? await readEventDerivationPolicy(db, params.userAskEventId)
    : 'allow';
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
      ...(publicProse ? { public_prose: publicProse } : {}),
      derivation_policy: derivationPolicy,
      task_run_id: params.taskRunId,
      ...(params.evidenceValidation ? { evidence_validation: params.evidenceValidation } : {}),
      ...(sealed.receipt ? { reply_finalization: sealed.receipt } : {}),
      ...(params.durableFinishReason ? { durable_finish_reason: params.durableFinishReason } : {}),
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
      // Reply METADATA only, persisted so replay can restore it. The {role,text}
      // history projection keeps it structurally out of every future prompt;
      // conditional spread keeps absent-nomination payloads byte-identical.
      ...(primaryView ? { primary_view: primaryView } : {}),
    },
    caused_by_event_id: params.userAskEventId ?? null,
    task_run_id: params.taskRunId,
    created_at: replyAt,
  });
  return {
    replyEventId,
    cleanedReply,
    ...(primaryView ? { primaryView } : {}),
    ...(publicProse ? { publicProse } : {}),
  };
}

/** Question materialization and the terminal reply are one teaching-owned commit. */
export async function writeTeachingCopilotReply(
  db: Db | Tx,
  params: Pick<
    Parameters<typeof writeCopilotReply>[1],
    'sessionId' | 'userAskEventId' | 'actorRef' | 'durableFinishReason' | 'now' | 'writeFn'
  > & {
    outcome?: 'success';
    skillContext: CopilotSkillContextT;
    skillResult: TeachingSkillResult;
    materializeAskCheckFn?: typeof materializeAskCheckQuestion;
  },
): Promise<WriteCopilotReplyResult & { skillTurn: CopilotSkillTurn; materialized: boolean }> {
  const { skillContext, skillResult, materializeAskCheckFn, ...commit } = params;
  if (
    params.userAskEventId &&
    (await readEventDerivationPolicy(db, params.userAskEventId)) !== 'allow'
  ) {
    throw new Error('仅用于本次回答：不创建教学练习，请重新提交需要用于日常学习的内容。');
  }
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
