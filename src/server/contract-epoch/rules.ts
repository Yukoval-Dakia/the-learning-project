// ====================================================================
// DB contract epoch · 纯规则（零 IO；读写面在 ./epoch.ts）
// ====================================================================
//
// 唯一职责：判断本进程能否在 `contract_epoch` marker 所示的 DB 上执行 runtime。
//
// Marker 语义：
//   - 缺表 / 空表 → 隐式 (CODE_CONTRACT_EPOCH, 'active')，让 fresh DB 能先 migrate 再 serve。
//   - 'preparing'：迁移维护窗口 —— 任何 epoch 的 runtime 全部 fenced。
//   - 'ready'：迁移完成待激活 —— 仍 fenced（新旧两侧都停的安静窗口）。
//   - 'active'：仅 marker.epoch === 代码 epoch 才放行 —— 新代码不跑旧数据，旧代码也不跑新数据。
//
// 旧二进制没有本检查，停旧 writer 是运维动作；本 fence 只约束含本代码的进程。

/** 全量迁移后代码携带的 epoch 名（评估契约系列的目标 epoch）。 */
export const ASSESSMENT_CONTRACT_EPOCH = 'assessment-contract-v1' as const;

/**
 * 本代码构建所实现的 contract epoch。常量必须随部署一起翻转：镜像与 DB marker
 * 不一致时进程会 epoch_mismatch 自锁。
 */
export const CODE_CONTRACT_EPOCH = ASSESSMENT_CONTRACT_EPOCH;

export type ContractEpochState = 'preparing' | 'ready' | 'active';

export const CONTRACT_EPOCH_STATES: readonly ContractEpochState[] = [
  'preparing',
  'ready',
  'active',
];

/** DB marker 一行的最小形状（epoch.ts 的 SELECT 列投影）。 */
export interface EpochMarker {
  epoch: string;
  state: ContractEpochState;
}

/** 缺表/空表的隐式 marker：无 marker 的 DB 对本代码天然 runnable。 */
export const IMPLICIT_EPOCH_MARKER: EpochMarker = {
  epoch: CODE_CONTRACT_EPOCH,
  state: 'active',
};

export type EpochGateVerdict =
  | { readonly runnable: true; readonly marker: EpochMarker }
  | {
      readonly runnable: false;
      readonly marker: EpochMarker;
      readonly reason: 'maintenance' | 'epoch_mismatch';
    };

export function gateContractEpoch(
  marker: EpochMarker | null,
  codeEpoch: string = CODE_CONTRACT_EPOCH,
): EpochGateVerdict {
  const effective = marker ?? IMPLICIT_EPOCH_MARKER;
  if (effective.state !== 'active') {
    return { runnable: false, marker: effective, reason: 'maintenance' };
  }
  if (effective.epoch !== codeEpoch) {
    return { runnable: false, marker: effective, reason: 'epoch_mismatch' };
  }
  return { runnable: true, marker: effective };
}

// ───────────────────────── 状态迁移（entered_by 写 DB 前的校验） ─────────────────────────

export type EpochTransitionKind =
  /** 进入维护窗：恒允许（安全方向），可同时换目标 epoch。 */
  | 'begin_prepare'
  /** 迁移核验通过，进入待激活安静窗口；可在此完成 epoch 名切换。 */
  | 'mark_ready'
  /** 激活目标 epoch；same-epoch 可从 preparing/ready 恢复，换 epoch 只能从 ready 起。 */
  | 'activate';

export type EpochTransitionError =
  | 'no_current_epoch' // mark_ready/activate 需要现状行存在（seed 后恒有）
  | 'ready_requires_preparing'
  | 'activate_new_epoch_requires_ready'
  | 'noop_active_to_active' // activate 同 epoch 已 active：拒绝，避免假历史行
  | 'invalid_state';

export interface EpochTransitionDecision {
  ok: boolean;
  error?: EpochTransitionError;
  /** 结果行（epoch, state）。ok=false 时无意义。 */
  next?: EpochMarker;
}

/**
 * 迁移状态机（写路径唯一校验，transitionContractEpoch 在事务内调用）。
 * 只有安全方向（进入 preparing）无条件放行；激活换 epoch 必须先经过目标 epoch
 * 的 ready 安静窗口，active→active 同 epoch 拒绝以免留下假迁移历史。
 */
export function validateEpochTransition(
  current: EpochMarker | null,
  kind: EpochTransitionKind,
  targetEpoch: string,
): EpochTransitionDecision {
  if (targetEpoch.trim().length === 0) {
    return { ok: false, error: 'invalid_state' };
  }
  if (current === null) {
    // 表刚建好/被清空：只有 begin_prepare 能作为首个显式 marker 落地
    // （等价于从隐式 code-epoch/active 起窗）。
    if (kind === 'begin_prepare') {
      return { ok: true, next: { epoch: targetEpoch, state: 'preparing' } };
    }
    return { ok: false, error: 'no_current_epoch' };
  }
  switch (kind) {
    case 'begin_prepare': {
      // 进入维护窗永远放行：起窗、cutover 换 epoch、放弃 ready 回炉、preparing 幂等。
      return { ok: true, next: { epoch: targetEpoch, state: 'preparing' } };
    }
    case 'mark_ready': {
      if (current.state === 'preparing') {
        return { ok: true, next: { epoch: targetEpoch, state: 'ready' } };
      }
      if (current.state === 'ready' && current.epoch === targetEpoch) {
        return { ok: true, next: { epoch: targetEpoch, state: 'ready' } };
      }
      return { ok: false, error: 'ready_requires_preparing' };
    }
    case 'activate': {
      if (current.state === 'active' && current.epoch === targetEpoch) {
        return { ok: false, error: 'noop_active_to_active' };
      }
      if (current.epoch === targetEpoch) {
        return { ok: true, next: { epoch: targetEpoch, state: 'active' } };
      }
      // 换 epoch 激活：必须先处于该目标的 ready（安静窗口核验）。
      return { ok: false, error: 'activate_new_epoch_requires_ready' };
    }
    default:
      return { ok: false, error: 'invalid_state' };
  }
}

// ───────────────────────── fence 观测面 ─────────────────────────

/** fence 命中/解除的日志 tag —— grep/告警的唯一稳定键。 */
export const CONTRACT_EPOCH_LOG_TAG = '[contract-epoch]';

/** 每次 fence 命中发一条确定 shape 的日志（不 crash、不静默）。 */
export function logContractEpochFence(
  surface: string,
  verdict: Extract<EpochGateVerdict, { runnable: false }>,
  extra?: Record<string, unknown>,
): void {
  console.warn(CONTRACT_EPOCH_LOG_TAG, {
    event: 'fenced',
    surface,
    epoch: verdict.marker.epoch,
    state: verdict.marker.state,
    reason: verdict.reason,
    ...extra,
  });
}

/** fence 命中时抛出的确定性错误（boss 重投/DLQ 与 API 503 的共同类型）。 */
export class ContractEpochFenceError extends Error {
  readonly marker: EpochMarker;
  readonly reason: 'maintenance' | 'epoch_mismatch';

  constructor(surface: string, verdict: Extract<EpochGateVerdict, { runnable: false }>) {
    super(
      `contract epoch fence: ${surface} refused — db epoch ` +
        `${verdict.marker.epoch}/${verdict.marker.state} (${verdict.reason})`,
    );
    this.name = 'ContractEpochFenceError';
    this.marker = verdict.marker;
    this.reason = verdict.reason;
  }
}
