// ====================================================================
// YUK-1059 — 集成发布 manifest（grounding §15 末项 + §16 rollback 边界）
// ====================================================================
//
// 一次 release 的证据工件生成器（**不改 production**：只读 git + PG）。
// 三块：
//   lanes       — 本评估契约系列的 merged lanes（contract 1044-1057 /
//                 corrective 1091-1100 / context 1040-1043 / meta 1058-1059），
//                 从 git log 解析（subject + PR #），不是手维护清单。
//   migrations  — 本系列新增的 drizzle/*.sql 文件 + 目标库 applied 对账
//                 （drizzle.__drizzle_migrations 计数；0103 等 pre-series
//                 文件不在此列表）。
//   assertions  — post-release 断言表（§15 三个验证点展开）：每条带
//                 sql/command + 评估状态（ok/fail/info/skip）。目标库可达时
//                 真实评估；不可达时全部 status='skip'（manifest 仍可产出
//                 —— 边界语义与门禁表本身是交付物）。
//
// 单测只测纯函数（lane 分类 / assertions 定义表）；DB 评估由
// cutover runbook + scratch run（pnpm release:manifest --target=...）证明。
// ====================================================================

import { sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import {
  ASSESSMENT_CONTRACT_EPOCH,
  CODE_CONTRACT_EPOCH,
  type OutstandingJobDisposition,
  isUndefinedTable,
  readContractEpoch,
  reportOutstandingBossJobs,
} from '@/server/contract-epoch';

// ── lanes ────────────────────────────────────────────────────────────────────

export type LaneBucket = 'contract' | 'corrective' | 'context' | 'meta';

export interface LaneRow {
  ticket: string; // 'YUK-1044'
  bucket: LaneBucket;
  sha: string;
  subject: string;
  pr: number | null;
}

/**
 * 本 ticket 系列的界定带（context 1040-1043 / contract 1044-1057 /
 * meta 1058-1059 / corrective 1091-1100）。lane commit 与 migration
 * 文件分类共用同一份区间表 —— 两边不各写一份会漂移的魔法数。
 */
export const SERIES_TICKET_BANDS: ReadonlyArray<readonly [number, number]> = [
  [1040, 1059],
  [1091, 1100],
];

export function inSeriesBand(ticketNum: number): boolean {
  return SERIES_TICKET_BANDS.some(([lo, hi]) => ticketNum >= lo && ticketNum <= hi);
}

/** ticket → bucket（1058/1059 是 meta：gates/集成本身；1040-1043 是前置 context）。 */
export function bucketFor(ticketNum: number): LaneBucket {
  if (ticketNum >= 1044 && ticketNum <= 1057) return 'contract';
  if (ticketNum >= 1091 && ticketNum <= 1100) return 'corrective';
  if (ticketNum === 1058 || ticketNum === 1059) return 'meta';
  return 'context'; // 1040-1043 与意外落入范围内的其他票
}

/** 从 git log subject 提取（'feat(YUK-1047): … (#1471)'）。 */
export function parseLaneCommit(sha: string, subject: string): LaneRow | null {
  const t = /YUK-(\d+)/.exec(subject);
  if (!t) return null;
  const num = Number(t[1]);
  if (!inSeriesBand(num)) return null;
  const pr = /\(#(\d+)\)\s*$/.exec(subject);
  return {
    ticket: `YUK-${num}`,
    bucket: bucketFor(num),
    sha,
    subject,
    pr: pr ? Number(pr[1]) : null,
  };
}

/**
 * `git log --format='%H%x09%s'` 输出 → LaneRow[]（非本系列的行丢弃；
 * 保持 git log 的 newest-first 顺序）。
 */
export function parseLaneLog(stdout: string): LaneRow[] {
  const rows: LaneRow[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.indexOf('\t');
    if (t === -1) continue;
    const row = parseLaneCommit(line.slice(0, t), line.slice(t + 1));
    if (row) rows.push(row);
  }
  return rows;
}

// ── migrations ───────────────────────────────────────────────────────────────

export interface MigrationRow {
  file: string; // drizzle/0104_yuk1044_….sql
  addedBy: string; // 引入该文件的 commit sha（short）
  ticket: string | null; // 文件名 yukNNNN tag 或引入 commit 的 YUK-N
}

/** 文件名携带的 ticket tag（'0107_yuk1044_….sql' → 1044）；无 tag → null。 */
export function migrationFileTicket(file: string): number | null {
  const m = /yuk(\d{4})/i.exec(file);
  return m ? Number(m[1]) : null;
}

/**
 * 判定一个 drizzle/*.sql 是否属于本系列的迁移：文件名 tag 在带内，或引入
 * 该文件的 commit subject 携带带内 YUK-N（处理未打 tag 的文件名）。
 */
export function isSeriesMigration(
  file: string,
  addedBySubject: string | null,
): { series: boolean; ticket: string | null } {
  const byName = migrationFileTicket(file);
  if (byName !== null && inSeriesBand(byName)) {
    return { series: true, ticket: `YUK-${byName}` };
  }
  if (addedBySubject !== null) {
    const m = /YUK-(\d+)/.exec(addedBySubject);
    if (m && inSeriesBand(Number(m[1]))) {
      return { series: true, ticket: `YUK-${m[1]}` };
    }
  }
  return { series: false, ticket: byName !== null ? `YUK-${byName}` : null };
}

// ── assertions（post-release 断言；§15 三验证点 + 边界完整性）───────────────

export type AssertionStatus = 'ok' | 'fail' | 'info' | 'skip';

export interface ManifestAssertion {
  id: string;
  /** §15 验证点归属：'unified-write' | 'no-fallback' | 'translations' | 'integrity' */
  group: 'unified-write' | 'no-fallback' | 'translations' | 'integrity';
  statement: string;
  /** 复核路径（runbook 引用同一命令）。 */
  verify: string;
  status: AssertionStatus;
  detail: string;
}

export interface AssertionContext {
  /** pgboss outstanding（含 failed）；translate/fenced 分别统计。 */
  outstanding: OutstandingJobDisposition[];
  /** 当前 contract_epoch marker；null = 隐式 code-epoch/active（表缺/空）。 */
  epoch: { epoch: string; state: string; seq: number } | null;
  /** drizzle.__drizzle_migrations 行数。 */
  migrationsApplied: number | null;
  /** drizzle/*.sql 全量文件数（系列 + 历史）。 */
  migrationFilesTotal: number;
  /** 本系列新增文件名集合（drizzle/0104…）。 */
  seriesMigrationFiles: string[];
  /** 旧 subscriber_version 上仍 non-terminal 的 delivery 数（无表 → null）。 */
  staleSubscriptionDeliveries: number | null;
  /** status='pending' 的 evaluation 行数（无表 → null）。 */
  pendingEvaluations: number | null;
  /** 新代码的 contract epoch 名（ASSESSMENT_CONTRACT_EPOCH 常量）。 */
  expectedEpoch: string;
}

/** 断言定义（statement/verify 静态；status 由 evaluate 填）。 */
export function buildAssertions(ctx: AssertionContext): ManifestAssertion[] {
  const out: ManifestAssertion[] = [];
  const push = (
    id: string,
    group: ManifestAssertion['group'],
    statement: string,
    verify: string,
    status: AssertionStatus,
    detail: string,
  ) => out.push({ id, group, statement, verify, status, detail });

  const translateOutstanding = ctx.outstanding
    .filter((o) => o.disposition === 'translate')
    .reduce((a, o) => a + o.count, 0);
  const fencedOutstanding = ctx.outstanding
    .filter((o) => o.disposition === 'fenced')
    .reduce((a, o) => a + o.count, 0);

  // ── unified-write：只新写口活跃，旧 write path 被 epoch 栅栏关停 ──
  if (ctx.epoch === null) {
    push(
      'epoch-active',
      'unified-write',
      'contract_epoch.marker = assessment-contract-v1/active —— 新契约已激活（旧代码 epoch_mismatch）',
      'pnpm migration:epoch status --target=<pg> ⇒ active / assessment-contract-v1',
      'info',
      'marker absent（无 marker DB；隐式 code-epoch/active）— 发布前应为 active',
    );
  } else {
    const ok = ctx.epoch.state === 'active' && ctx.epoch.epoch === ctx.expectedEpoch;
    push(
      'epoch-active',
      'unified-write',
      'contract_epoch.marker = assessment-contract-v1/active —— 新契约已激活（旧代码 epoch_mismatch）',
      'pnpm migration:epoch status --target=<pg> ⇒ active / assessment-contract-v1',
      ok ? 'ok' : 'fail',
      `marker=${ctx.epoch.epoch}/${ctx.epoch.state} seq=${ctx.epoch.seq}` +
        (ok ? '' : `（期望 ${ctx.expectedEpoch}/active）`),
    );
  }

  // epoch 历史完整性：迁移窗口必须走完 preparing → ready → active。
  push(
    'epoch-history',
    'unified-write',
    'contract_epoch 历史含 preparing→ready→active 全序（迁移窗口审计证据）',
    'select epoch,state,seq,entered_by from contract_epoch order by seq —— 见 runbook §验证',
    ctx.epoch === null ? 'skip' : ctx.epoch.state === 'active' ? 'ok' : 'fail',
    ctx.epoch === null
      ? '表缺/空（尚未进窗口）'
      : `seq=${ctx.epoch.seq} state=${ctx.epoch.state}（历史行须人工复核 ≥3）`,
  );

  // ── no-fallback：运行时无对旧 route/路径的猜测（静态证明 + fence 活证据）─
  push(
    'no-runtime-fallback',
    'no-fallback',
    '无 runtime fallback 猜测旧路由 —— 1097 组缓存/映射冻结、1099 结构化发布、1055 epoch 栅栏共同钉死（静态：fenceAwareJobHandler/epoch gate 覆盖所有写口；旧代码经 epoch_mismatch 拒跑）',
    'src/server/contract-epoch/epoch.db.test.ts + boss-fence 覆盖；rehearsal step 09 epoch 栅栏三态实证',
    ctx.epoch !== null && ctx.epoch.state === 'active' ? 'ok' : 'info',
    ctx.epoch !== null && ctx.epoch.state === 'active'
      ? 'active marker 已立——fence 生效中'
      : 'active marker 未立（fence 未激活；发布前须为 active）',
  );

  // ── translations：队列与订阅 pending 翻译全部处置完 ──
  if (ctx.staleSubscriptionDeliveries === null) {
    push(
      'subscription-translations-zero',
      'translations',
      '旧 subscriber_version 上无非终态 delivery（bootstrap 翻译已处置 outstanding）',
      "select count(*) from event_subscription_delivery d join event_subscription_checkpoint c on d.subscriber_id=c.subscriber_id and d.subscriber_version<c.subscriber_version where d.status in ('pending','claimed','retry_wait')",
      'info',
      'event_subscription_* 表缺（库未达或表未建）',
    );
  } else {
    push(
      'subscription-translations-zero',
      'translations',
      '旧 subscriber_version 上无非终态 delivery（bootstrap 翻译已处置 outstanding）',
      "select count(*) from event_subscription_delivery d join event_subscription_checkpoint c on d.subscriber_id=c.subscriber_id and d.subscriber_version<c.subscriber_version where d.status in ('pending','claimed','retry_wait')",
      ctx.staleSubscriptionDeliveries === 0 ? 'ok' : 'fail',
      `stale-version non-terminal deliveries=${ctx.staleSubscriptionDeliveries}`,
    );
  }
  push(
    'translate-outstanding-disposed',
    'translations',
    'pgboss translate-disposition 队列无未处置 outstanding（translate 类须显式转换/处置，不得在新 epoch 下原样跑）',
    'pnpm migration:epoch outstanding --target=<pg>',
    'info',
    `translate=${translateOutstanding} fenced=${fencedOutstanding}（runbook：窗口内逐条翻译/处置；fenced 不允许新 epoch 运行是【设计内】）`,
  );
  if (ctx.pendingEvaluations === null) {
    push(
      'pending-evaluations-zero',
      'translations',
      "无遗留 status='pending' evaluation（evaluated→activate 前置已清）",
      "select count(*) from evaluation where status='pending'",
      'info',
      'evaluation 表缺（库未达或表未建）',
    );
  } else {
    push(
      'pending-evaluations-zero',
      'translations',
      "无遗留 status='pending' evaluation（evaluated→activate 前置已清）",
      "select count(*) from evaluation where status='pending'",
      ctx.pendingEvaluations === 0 ? 'ok' : 'fail',
      `pending=${ctx.pendingEvaluations}`,
    );
  }

  // ── integrity：migration 账本对账 ──
  if (ctx.migrationsApplied === null) {
    push(
      'migrations-applied',
      'integrity',
      'drizzle.__drizzle_migrations 行数 = drizzle/*.sql 文件数（zero drift）',
      'pnpm delivery:evidence 的 migrations check + 本 manifest',
      'info',
      '库未达（无 __drizzle_migrations 计数）',
    );
  } else {
    push(
      'migrations-applied',
      'integrity',
      'drizzle.__drizzle_migrations 行数 = drizzle/*.sql 文件数（zero drift）',
      'pnpm delivery:evidence 的 migrations check + 本 manifest',
      ctx.migrationsApplied === ctx.migrationFilesTotal ? 'ok' : 'fail',
      `applied=${ctx.migrationsApplied} files=${ctx.migrationFilesTotal} ` +
        `series_new=${ctx.seriesMigrationFiles.length}（${ctx.seriesMigrationFiles.join(', ')}）`,
    );
  }

  return out;
}

// ── 顶层 manifest ────────────────────────────────────────────────────────────

export interface AssessmentReleaseManifest {
  kind: 'assessment-release-manifest';
  generated_at: string;
  contract_epoch: string; // 期望激活的 epoch 名
  code_epoch_before: string; // 生成本 manifest 的代码 epoch（CODE_CONTRACT_EPOCH）
  series_base: string; // 系列起点 commit（1040-首提交 parent）
  lanes: LaneRow[];
  migrations: MigrationRow[];
  assertions: ManifestAssertion[];
  rollback: {
    boundary_a: string;
    boundary_b: string;
  };
  notes: string[];
}

/** DB 侧 assertion 输入采集（一次连接；任一探测失败 → 该字段 null）。 */
export async function collectAssertionContext(
  db: Db,
  opts: { migrationFilesTotal: number; seriesMigrationFiles: string[] },
): Promise<AssertionContext> {
  const epoch = await readContractEpoch(db);
  const outstanding = await reportOutstandingBossJobs(db).catch(() => []);

  let migrationsApplied: number | null = null;
  try {
    const r = await db.execute<{ c: number }>(sql`
      select count(*)::int as c from drizzle.__drizzle_migrations
    `);
    migrationsApplied = r[0]?.c ?? null;
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }

  let staleSubscriptionDeliveries: number | null = null;
  try {
    const r = await db.execute<{ c: number }>(sql`
      select count(*)::int as c
      from event_subscription_delivery d
      join event_subscription_checkpoint c
        on c.subscriber_id = d.subscriber_id
       and c.subscriber_version > d.subscriber_version
      where d.status in ('pending','claimed','retry_wait')
    `);
    staleSubscriptionDeliveries = r[0]?.c ?? null;
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }

  let pendingEvaluations: number | null = null;
  try {
    const r = await db.execute<{ c: number }>(sql`
      select count(*)::int as c from evaluation where status = 'pending'
    `);
    pendingEvaluations = r[0]?.c ?? null;
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }

  return {
    outstanding,
    epoch: epoch === null ? null : { epoch: epoch.epoch, state: epoch.state, seq: epoch.seq },
    migrationsApplied,
    migrationFilesTotal: opts.migrationFilesTotal,
    seriesMigrationFiles: opts.seriesMigrationFiles,
    staleSubscriptionDeliveries,
    pendingEvaluations,
    expectedEpoch: ASSESSMENT_CONTRACT_EPOCH,
  };
}

export function buildAssessmentManifest(args: {
  lanes: LaneRow[];
  migrations: MigrationRow[];
  seriesBase: string;
  assertions: ManifestAssertion[];
}): AssessmentReleaseManifest {
  return {
    kind: 'assessment-release-manifest',
    generated_at: new Date().toISOString(),
    contract_epoch: ASSESSMENT_CONTRACT_EPOCH,
    code_epoch_before: CODE_CONTRACT_EPOCH,
    series_base: args.seriesBase,
    lanes: args.lanes,
    migrations: args.migrations,
    assertions: args.assertions,
    rollback: {
      boundary_a:
        '新写入之前：restore 一致的冻结 data/queues/subscriptions/assets + 旧 images ' +
        '（ rehearsal step 04 restore-proof：pg_restore → snapshotDbState 逐表比对）。',
      boundary_b:
        '新写入之后：默认 maintenance + roll-forward；必须 restore 时先导出全部新 ' +
        'submissions/drafts/eval/receipt/blobs，在独立 target 恢复并有证明的对账 ' +
        '（rehearsal step 11-12 delta-export → rehearsal_rollback restore → replay+reconcile）。' +
        '旧 app 无法表示新 shape —— 不存在无损 image rollback。',
    },
    notes: [
      '本 manifest 只证明「已发布的 lanes + migrations + post-release 断言面」；',
      '部署/activate 本身不授权 —— runbook §窗口步骤由 owner 拍板执行。',
      'assertions 状态在目标库可达时实时评估；不可达时全部 info/skip。',
    ],
  };
}
