// YUK-1398 (Stage 1 · B6 S2/S3) — Copilot 接纳面的危机守卫服务件。
//
// 职责边界（最小）：
//   - `classifyCopilotTurn`：在 HTTP 接纳点对 user_message 做确定性分类；
//     命中时强制 derivation_policy='crisis'（覆盖客户端送来的任何值）。
//   - `writeCrisisGuardEvent`：在同一事务里写一条**非身份化**守卫事件
//     （类别 / 模板版本 / 审定状态 / 入口 / 配置版本），供后续专家审定对账。
//     绝不写原始文本——原文只存在于既有会话事件里。
//
// 回应模板不在这里：见 `src/core/crisis/config.ts`（单一版本化文件，
// 每条模板带 review_status，审定人只改那个文件）。

import {
  CRISIS_GUARD_CONFIG_VERSION,
  type CrisisDetectionClass,
  classifyCrisisExpression,
  crisisTemplateForClass,
} from '@/core/crisis/classify';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';

/** 守卫事件的动作名（未进 RESERVED_EXPERIMENTAL_ACTIONS：走通用 ExperimentalEvent 解析，零 schema 变更）。 */
export const CRISIS_GUARD_EVENT_ACTION = 'experimental:crisis_guard' as const;

/** 回应入口标识（事件里只存这个，不存原文）。 */
export type CrisisEntryPoint = 'copilot_chat' | 'copilot_chip';

export interface CrisisTurnClassification {
  readonly detectionClass: CrisisDetectionClass;
  /** 命中时为 'crisis'；未命中为 null（沿用请求自带策略，默认 allow）。 */
  readonly forcedPolicy: 'crisis' | null;
}

/** 接纳点分类：纯函数，无 IO、无模型调用。 */
export function classifyCopilotTurn(userMessage: string): CrisisTurnClassification {
  const detectionClass = classifyCrisisExpression(userMessage);
  return {
    detectionClass,
    forcedPolicy: detectionClass === 'none' ? null : 'crisis',
  };
}

export interface CrisisGuardEventInput {
  /** 所在会话（与 user_ask 同 session，便于审定人按会话对账——不新增文本暴露面）。 */
  sessionId: string;
  /** user_ask / chip trigger 事件 id（因果根；该事件本身已带 crisis 策略）。 */
  askEventId: string;
  detectionClass: Exclude<CrisisDetectionClass, 'none'>;
  entryPoint: CrisisEntryPoint;
  /** 稳定事件 id（幂等重放不重复写）。 */
  eventId: string;
  now: Date;
}

/**
 * 非身份化守卫事件。payload 只含类别与版本坐标：
 * detection_class / entry_point / guard_version /（若已选模板）template_version
 * 与 template_review_status。无原文、无用户标识、无会话文本摘录。
 */
export async function writeCrisisGuardEvent(
  db: Db | Tx,
  input: CrisisGuardEventInput,
): Promise<string> {
  const template = crisisTemplateForClass(input.detectionClass);
  await writeEvent(db, {
    id: input.eventId,
    session_id: input.sessionId,
    actor_kind: 'system',
    actor_ref: 'crisis-guard',
    action: CRISIS_GUARD_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: input.askEventId,
    outcome: 'success',
    payload: {
      detection_class: input.detectionClass,
      entry_point: input.entryPoint,
      guard_version: CRISIS_GUARD_CONFIG_VERSION,
      template_version: template.version,
      template_review_status: template.review_status,
      // 双保险：事件自身也声明受限用途（其因果根 user_ask 已是 crisis）。
      derivation_policy: 'crisis',
    },
    caused_by_event_id: input.askEventId,
    // 系统观测事件：写入点即退出记忆摄取（actor_kind='system' 本就不进抽取，
    // 这里显式 opt-out 让它连 outbox 都不进）。
    ingest_at: input.now,
    affected_scopes: [],
    created_at: input.now,
  });
  return input.eventId;
}
