// ====================================================================
// DB contract epoch · 读写面（DB IO；规则判定在 ./rules.ts）
// ====================================================================
//
// `contract_epoch` 是 append-only 迁移历史；当前 epoch = seq 最大行。
// 缺表（42P01）/空表时读路径按隐式 (CODE_CONTRACT_EPOCH,'active') 解释，
// 写路径（transitionContractEpoch）对空表只允许 begin_prepare 落首个 marker。
//
// 三个消费入口：
//   - startBossWorker 先 await waitForRunnableEpoch —— 在 recovery/handlers/cron
//     之前生效。fenced 时等待轮询而不退出，容器 restart-loop 拉起时不会 crash-loop。
//   - API middleware（server/app.ts）每请求 gateContractEpoch → 503
//     contract_epoch_fenced；/api/health 与 /api/ready 豁免（health ≠ readiness）。
//   - boss.work 消费者 wrapper（./boss-fence.ts）补 per-delivery fence：防一个
//     活着的旧 worker 在 epoch 翻转后继续消费。

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
  // postgres-js 把 ::timestamptz 投影成 string（非 Date）。归一化放边界内，
  // 下游所有消费方拿到的都是真 Date。
  entered_at: Date | string;
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
 * 读当前 epoch marker。表不存在（42P01）或空表 → null（调用方按隐式
 * code-epoch/active 解释）。其它错误原样抛出——读不出 marker 时不许猜成可运行。
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
    enteredAt: row.entered_at instanceof Date ? row.entered_at : new Date(row.entered_at),
    enteredBy: row.entered_by,
    note: row.note,
  };
}

// drizzle 把 PostgresError 包成 DrizzleQueryError（SQLSTATE 在 err.cause.code）；
// 直透 postgres-js 时则在 err.code —— 两侧都要看。
export function isUndefinedTable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const direct = (err as { code?: string }).code;
  const nested = (err as { cause?: { code?: string } }).cause?.code;
  return direct === '42P01' || nested === '42P01';
}

export interface EpochGateStatus {
  runnable: boolean;
  marker: EpochMarker | null; // null = 隐式 code-epoch/active（表缺/空）
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
 * 无限等待是有意的（fenced 不 crash-loop）；SIGTERM 仍走 shutdown handler。
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
 * 转移合法性全由 validateEpochTransition 裁决（失败即抛错，不落行）。
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
 * translate 类 job 的出生 epoch（boss-fence.ts 用）：job 创建时刻之前最近一个
 * 'active' marker 的 epoch；早于全部 marker → 'legacy'（marker 系统之前的旧合同
 * payload）；表缺 → CODE_CONTRACT_EPOCH，与 gate 的隐式语义对齐。
 */
export async function readJobBirthEpoch(db: Db, createdOn: Date | string): Promise<string> {
  try {
    // postgres-js 不序列化 Date 参数 → 统一转 ISO 串 + 显式 timestamptz cast。
    // created_on 读出来也可能是 string（postgres-js 对 timestamptz 不构造 Date）。
    const iso = createdOn instanceof Date ? createdOn.toISOString() : String(createdOn);
    // marker_count 与命中行同查询读出：空表 = 隐式当前 epoch（与 readContractEpoch
    // 的 null 路径同语义），不能误判成 'legacy'；resetDb() 会 TRUNCATE contract_epoch，
    // 误判会让一切 translate 类 job 在隔离测试库被 fence。
    const rows = await db.execute<{ epoch: string | null; marker_count: number | string }>(sql`
      select
        (select count(*)::int from contract_epoch) as marker_count,
        (select epoch
           from contract_epoch
          where state = 'active'
            and entered_at <= ${iso}::timestamptz
          order by seq desc
          limit 1) as epoch
    `);
    const row = rows[0];
    if (row === undefined || Number(row.marker_count) === 0) {
      return CODE_CONTRACT_EPOCH;
    }
    return row.epoch ?? 'legacy';
  } catch (err) {
    if (isUndefinedTable(err)) return CODE_CONTRACT_EPOCH;
    throw err;
  }
}
