// jyeoo-rs 供给常量与环境读取（YUK-986 / Supply-Agent/1 瘦身版）。
//
// YUK-697 的旧机器面（JYEOO_FETCH_ENABLED kill switch、subject-profile jyeooSupply
// 声明、--dg 难度 token、dispatcher 可派性闸）已随 queue 形态退役——producer 经济学
// （grade 路线无 keyword/无 --dg，无法按 KC 定向；40 题/日/账号谨慎档）与逐目标
// dispatcher 派发根本不兼容。供给改由 agent tool 链承载：
//   server/tools/jyeoo-fetch-candidates.ts  → grade 路线抓自包含候选（budget 租约）
//   server/tools/store-sourced-question.ts  → 统一 commit seam（dedup/verify 权威）
// 本文件只剩 tool 链消费的常量与 producer binary/spawn 环境读取。

// 来源路由常量（与 sourcing_web / quiz_gen 同族）——difficulty_evidence.source_route、
// provenance 与 SupplyProducerRoute 词表沿用该字面量（retirement 后仍是合法值）。
export const JYEOO_FETCH_ROUTE = 'jyeoo_fetch';
// jyeoo 题面里的本地/远程图在入库前必须本地化到 loom 资产；URL 不允许引用外站图床。
export const JYEOO_SOURCE_HOST = 'www.jyeoo.com';

import { homedir } from 'node:os';

// Binary resolution: JYEOO_RS_BINARY wins; otherwise use the repo default
// (~/yukoval-projects/jyeoo-rs/target/release/jyeoo-rs). 本地 smoke 与生产 worker
// 同一路径约定。
export function jyeooBinaryPath(): string {
  const env = process.env.JYEOO_RS_BINARY;
  if (env && env.trim().length > 0) return env;
  return `${homedir()}/yukoval-projects/jyeoo-rs/target/release/jyeoo-rs`;
}

// Spawn bounds (functions, not module-load consts, so tests can set env per-case).
//
// 超时按 caller 语义区分（YUK-998）：grade 路线内容拉取 ~45s+/题串行（YUK-989 复验
// 实测 `pnpm jyeoo:backfill --max 4` 在 120s 默认下被 SIGKILL、丢 2 题已烧预算；
// JYEOO_SPAWN_TIMEOUT_MS=900000 复验 4/4 inserted）。
//   - in-band caller（jyeoo_fetch_candidates tool / supply_execute executor 路由）
//     走 jyeooSpawnTimeoutMs —— JYEOO_SPAWN_TIMEOUT_MS 默认 120s 是反卡死上界：
//     拉 N 题的会话须由 operator 把该 env 抬到 ≥ N×90s 档（见下方每题配额注释）。
//   - 手动批量 backfill（pnpm jyeoo:backfill）走 jyeooBackfillSpawnTimeoutMs ——
//     自带按批大小适配的默认，不再默默继承 120s 在内容拉取中途 SIGKILL 丢整批。
//
// 所有 JYEOO_SPAWN_* / JYEOO_BACKFILL_TIMEOUT_MS 均 Number.parseInt 直通：非数字
// 垃圾值 → NaN、非正值 → spawnJyeooFetch 边界校验拒绝（fail-closed，记 'spawn'
// failure）——该语义经 YUK-990 裁决接受，仅文档化，不做 env 侧纠偏。
export function jyeooSpawnTimeoutMs(): number {
  return Number.parseInt(process.env.JYEOO_SPAWN_TIMEOUT_MS ?? '120000', 10);
}

/**
 * backfill 默认超时的每题配额：producer 题间节奏实测 ~45s/题（含 jitter），×2 覆盖
 * 发现侧 pages/papers 遍历开销。默认 `--max 10` ⇒ 900s，即 YUK-989 复验实证可通过
 * 的 900000ms 档。
 */
export const JYEOO_BACKFILL_PER_QUESTION_MS = 90_000;

/**
 * `pnpm jyeoo:backfill`（批量 caller）的 spawn 超时解析，优先级：
 *   1. JYEOO_BACKFILL_TIMEOUT_MS —— backfill 专属显式覆盖（最高优先）；
 *   2. JYEOO_SPAWN_TIMEOUT_MS —— 共享 spawn 边界；operator 显式设置时对 backfill
 *      同样生效（YUK-989 复验即用此 env=900000）；
 *   3. sessionMax × JYEOO_BACKFILL_PER_QUESTION_MS —— 按批大小自适配默认，
 *      覆盖默认参数下的典型运行（--max 10 ⇒ 900s；--max 40 ⇒ 3600s）。
 * 空串视同未设置（继续下探）；非数字/非正值直通 NaN → spawn fail-closed（同上注释）。
 * 手动给值的推荐下界：本批 session_max × 90s。
 */
export function jyeooBackfillSpawnTimeoutMs(sessionMax: number): number {
  const explicit = process.env.JYEOO_BACKFILL_TIMEOUT_MS || process.env.JYEOO_SPAWN_TIMEOUT_MS;
  if (explicit) return Number.parseInt(explicit, 10);
  return sessionMax * JYEOO_BACKFILL_PER_QUESTION_MS;
}

export function jyeooSpawnMaxStdoutBytes(): number {
  return Number.parseInt(process.env.JYEOO_SPAWN_MAX_STDOUT_BYTES ?? String(8 * 1024 * 1024), 10);
}
export function jyeooSpawnMaxStderrBytes(): number {
  return Number.parseInt(process.env.JYEOO_SPAWN_MAX_STDERR_BYTES ?? String(1024 * 1024), 10);
}
