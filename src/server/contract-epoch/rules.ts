// ====================================================================
// YUK-1055 — DB contract epoch · 纯规则（零 import，unit-partition 可测）
// ====================================================================
//
// 「本进程能否在 `contract_epoch` marker 所示的 DB 上执行 runtime 路径」的唯一
// 裁决者。DB IO 在 ./epoch.ts；本文件只做判定，永不触连接。
//
// Marker 语义（schema.ts `contract_epoch` 表注释同款）：
//   - 缺表 / 空表 → 隐式 ('legacy', 'active')：pre-cutover DB 天然 runnable。
//   - 'preparing'：迁移维护窗口 —— 任何 epoch 的 runtime 全部 fenced。
//   - 'ready'：迁移完成待激活 —— 仍 fenced（新旧两侧都停，安静窗口）。
//   - 'active'：仅 marker.epoch === 代码 contract epoch 才 runnable ——
//     post-cutover app/worker 绝不在 pre-cutover 数据上跑（反之亦然）。
//
// 「新 guard 不能 fence 旧可执行」（grounding §15）：旧二进制没有本检查，
// 停旧 writer 是运维动作（cutover runbook）；本 fence 只约束含本代码的进程。

/** 本代码构建所实现的 contract epoch。新版本在统一切换 lane（YUK-1059）改值。 */
export const CODE_CONTRACT_EPOCH = 'legacy' as const;

/** 全量迁移后代码携带的 epoch 名（契约常量，本 lane 只声明不使用）。 */
export const ASSESSMENT_CONTRACT_EPOCH = 'assessment-contract-v1' as const;

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

/** 缺表（42P01）/ 空表的隐式 marker。 */
export const IMPLICIT_LEGACY_MARKER: EpochMarker = {
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

/** 统一裁决：给定 marker（null = 表缺/空）与代码 epoch，runtime 是否放行。 */
export function gateContractEpoch(
  marker: EpochMarker | null,
  codeEpoch: string = CODE_CONTRACT_EPOCH,
): EpochGateVerdict {
  const effective = marker ?? IMPLICIT_LEGACY_MARKER;
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
  /** 进入维护窗口：恒允许（安全方向）；可换目标 epoch（cutover 起点）。 */
  | 'begin_prepare'
  /** 迁移完成、已核验，进入待激活安静窗口。只能 preparing→ready；此处完成
   *  epoch 名切换（legacy→新 epoch）——迁移产物属于新合同。 */
  | 'mark_ready'
  /** 统一切换：激活目标 epoch。same-epoch 可从 preparing 或 ready（恢复中断的
   *  维护窗）；换 epoch 激活只能从 ready 走（必须先安静窗口核验）。 */
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
 *
 *   begin_prepare : (cur, *)         → (target, preparing)          恒允许（安全方向）
 *   mark_ready    : (E1, preparing)  → (E2, ready)               迁移核验通过；E2 通常≠E1
 *                   (E2, ready)      → (E2, ready)               幂等
 *   activate      : (E, preparing|ready) → (E, active)           same-epoch 恢复/完成切换
 *                   (E1, ready)      → (E2≠E1, active)           拒绝——必须先 ready(E2)
 *                   (E, active)      → (E, active)               拒绝（假迁移历史）
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
    // （等价于从隐式 legacy/active 起窗）。
    if (kind === 'begin_prepare') {
      return { ok: true, next: { epoch: targetEpoch, state: 'preparing' } };
    }
    return { ok: false, error: 'no_current_epoch' };
  }
  switch (kind) {
    case 'begin_prepare': {
      // 进入维护窗永远放行（安全方向）：(E, active)→(E, preparing) 起窗；
      // (E1, active)→(E2, preparing) 是 cutover 起点；(E, ready)→(E, preparing)
      // 是放弃 ready 回炉；(E, preparing)→(E, preparing) 是幂等重进。
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

/** fence 命中/解除的结构化日志 tag —— grep/告警的唯一稳定键（deterministic）。 */
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

/** fence 命中时抛出的确定性错误（boss 重投/DLQ 与 API 503 的公共类型）。 */
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
