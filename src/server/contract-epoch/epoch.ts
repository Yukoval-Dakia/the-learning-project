// ====================================================================
// YUK-1055 — DB contract epoch · 读写面（DB IO；规则判定在 ./rules.ts）
// ====================================================================
//
// `contract_epoch` 表：append-only 迁移历史；当前 epoch = seq 最大行。
// runtime 裁决（rules.ts）：
//   - 表缺（42P01）/空表 → 隐式 ('legacy','active') —— 只读路径这样解释；
//     写路径（transitionContractEpoch）对空表只允许 begin_prepare 落首个 marker。
//   - 'preparing'/'ready' → 一切 runtime fenced。
//   - 'active' → marker.epoch === CODE_CONTRACT_EPOCH 才放行。
//
// 用电面（本模块的三个入口）：
//   - startBossWorker 第一步 await waitForRunnableEpoch —— epoch guard 在
//     recovery/handlers/cron 之前生效（grounding §15）。fenced 时等待轮询而不
//     退出：进程被容器 restart-loop 拉起时只会再回这里睡觉，不会 crash-loop。
//   - API middleware（server/app.ts）每请求 gateContractEpoch → 503
//     contract_epoch_fenced；/api/health 与 /api/ready 豁免（health ≠ readiness）。
//   - boss.work 消费者 wrapper（./boss-fence.ts）—— 防「一个活着的旧 worker
//     错过停机」在 epoch 翻转后继续消费：per-delivery fence。

import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { contract_epoch } from '@/db/schema';
import {
  CODE_CONTRACT_EPOCH,
  CONTRACT_EPOCH_LOG_TAG,
  ContractEpochFenceError,
  type EpochMarker,
  type EpochTransitionKind,
  gateContractEpoch,
  logContractEpochFence,
  validateEpochTransition,
} from './rules';

export type { EpochGateVerdict, EpochMarker, EpochTransitionKind } from './rules';
export {
  ASSESSMENT_CONTRACT_EPOCH,
  CODE_CONTRACT_EPOCH,
  CONTRACT_EPOCH_LOG_TAG,
  CONTRACT_EPOCH_STATES,
  ContractEpochFenceError,
  gateContractEpoch,
  logContractEpochFence,
} from './rules';

/** 单写者串行化 namespace（advisory-locks.ts 的 hashtext 惯例）。 */
const EPOCH_TRANSITION_LOCK = 'contract-epoch:transition';

// db.execute<T> 要求 T extends Record<string, unknown> —— interface 不自带隐式
// index signature，type literal 自带（testDb().execute<{…}> 同型先例）。
type EpochRow = {
  seq: number;
  epoch: string;
  state: string;
  entered_at: Date;
  entered_by: string;
  note: string | null;
};

export interface ContractEpochMarker extends EpochMarker {
  seq: number;
  enteredAt: Date;
  enteredBy: string;
  note: string | null;
}

/**
 * 读当前 epoch marker。表不存在（42P01：pre-0109 DB）或空表 → null（调用方按
 * rules.ts 的隐式 legacy/active 解释）。其它错误原样抛出——读不出 marker 时
 * 不许猜成可运行（fail-visible）。
 */
export async function readContractEpoch(db: Db): Promise<ContractEpochMarker | null> {
  let rows: EpochRow[];
  try {
    rows = await db.execute<EpochRow>(sql`
      select seq, epoch, state, entered_at, entered_by, note
      from contract_epoch
      order by seq desc
      limit 1
    `);
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
  const row = rows[0];
  if (!row) return null;
  return {
    seq: row.seq,
    epoch: row.epoch,
    state: row.state as ContractEpochMarker['state'],
    enteredAt: row.entered_at,
    enteredBy: row.entered_by,
    note: row.note,
  };
}

// drizzle 把 PostgresError 包成 DrizzleQueryError（SQLSTATE 在 err.cause.code）；
// 直透 postgres-js 时则在 err.code —— 两侧都要看（boss/client.ts:45 同款）。
export function isUndefinedTable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const direct = (err as { code?: string }).code;
  const nested = (err as { cause?: { code?: string } }).cause?.code;
  return direct === '42P01' || nested === '42P01';
}

export interface EpochGateStatus {
  runnable: boolean;
  marker: EpochMarker | null; // null = 隐式 legacy/active（表缺/空）
  reason?: 'maintenance' | 'epoch_mismatch';
}

/** 读 marker + 裁决一步完成（API middleware / readiness 的共用入口）。 */
export async function checkContractEpoch(db: Db): Promise<EpochGateStatus> {
  const marker = await readContractEpoch(db);
  const verdict = gateContractEpoch(marker);
  return verdict.runnable
    ? { runnable: true, marker: verdict.marker }
    : { runnable: false, marker: verdict.marker, reason: verdict.reason };
}

/**
 * fence 检查：不可运行 → logContractEpochFence + ContractEpochFenceError。
 * surface 是日志/错误里的调用位标识（如 'job:judge_run'、'api'、'worker-boot'）。
 */
export async function assertContractEpochRunnable(db: Db, surface: string): Promise<void> {
  const marker = await readContractEpoch(db);
  const verdict = gateContractEpoch(marker);
  if (verdict.runnable) return;
  logContractEpochFence(surface, verdict);
  throw new ContractEpochFenceError(surface, verdict);
}

const DEFAULT_EPOCH_POLL_MS = 15_000;

/**
 * worker 启动期 epoch 闸门：每 pollIntervalMs 重读 marker，直到 runnable 返回。
 * 无限等待是有意的——「fenced 不 crash-loop」：进程停在闸门内睡觉，operator
 * 把 marker 推到本代码 epoch 的 'active'（或回滚镜像）即自动继续启动；
 * SIGTERM 仍走 shutdown handler（bounded tail + exit owner 在 worker-boot.ts）。
 */
export async function waitForRunnableEpoch(
  db: Db,
  options: { pollIntervalMs?: number } = {},
): Promise<void> {
  const poll = options.pollIntervalMs ?? DEFAULT_EPOCH_POLL_MS;
  let announced = false;
  for (;;) {
    const marker = await readContractEpoch(db);
    const verdict = gateContractEpoch(marker);
    if (verdict.runnable) {
      if (announced) {
        console.info(CONTRACT_EPOCH_LOG_TAG, {
          event: 'unfenced',
          surface: 'worker-boot',
          epoch: verdict.marker.epoch,
          state: verdict.marker.state,
        });
      }
      return;
    }
    if (!announced) {
      logContractEpochFence('worker-boot', verdict);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

export interface EpochTransitionResult {
  seq: number;
  epoch: string;
  state: string;
}

/**
 * 推进 epoch 状态机（CLI/运维入口）。事务内 advisory lock 串行化并发迁移者；
 * 转移合法性全由 validateEpochTransition 裁决（失败 → 抛错，不落行）。
 * 并发安全：lock 内重读 max(seq)，INSERT 新行（append-only）。
 */
export async function transitionContractEpoch(
  db: Db,
  kind: EpochTransitionKind,
  targetEpoch: string,
  actor: string,
  note?: string,
): Promise<EpochTransitionResult> {
  if (actor.trim().length === 0) {
    throw new Error('contract epoch transition requires a non-empty actor');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${EPOCH_TRANSITION_LOCK}))`);
    const rows = await tx.execute<EpochRow>(sql`
      select seq, epoch, state, entered_at, entered_by, note
      from contract_epoch
      order by seq desc
      limit 1
    `);
    const current: EpochMarker | null = rows[0]
      ? { epoch: rows[0].epoch, state: rows[0].state as EpochMarker['state'] }
      : null;
    const decision = validateEpochTransition(current, kind, targetEpoch);
    if (!decision.ok || !decision.next) {
      throw new Error(
        `contract epoch transition '${kind}' → '${targetEpoch}' rejected: ` +
          `${decision.error} (current: ${current ? `${current.epoch}/${current.state}` : 'none'})`,
      );
    }
    const nextSeq = (rows[0]?.seq ?? -1) + 1;
    // schema-builder insert（audit:schema 看得见写路径；raw execute 会被计为 stub）。
    const inserted = await tx
      .insert(contract_epoch)
      .values({
        seq: nextSeq,
        epoch: decision.next.epoch,
        state: decision.next.state,
        entered_by: actor,
        note: note ?? null,
      })
      .returning({ seq: contract_epoch.seq });
    return { seq: inserted[0]?.seq ?? nextSeq, ...decision.next };
  });
}

/**
 * translate 类 job 的出生 epoch（boss-fence.ts 用）：job 创建时刻处于 'active'
 * 的最新 marker 的 epoch；早于全部 marker（或表缺）→ 'legacy'。
 * 「出生在旧 epoch 的 translate payload 绝不按新合同执行」的判别式。
 */
export async function readJobBirthEpoch(db: Db, createdOn: Date): Promise<string> {
  let rows: { epoch: string }[];
  try {
    // postgres-js 不序列化 Date 参数 → 传 ISO 串 + 显式 timestamptz cast。
    rows = await db.execute<{ epoch: string }>(sql`
      select epoch
      from contract_epoch
      where state = 'active'
        and entered_at <= ${createdOn.toISOString()}::timestamptz
      order by seq desc
      limit 1
    `);
  } catch (err) {
    if (isUndefinedTable(err)) return CODE_CONTRACT_EPOCH;
    throw err;
  }
  return rows[0]?.epoch ?? 'legacy';
}
