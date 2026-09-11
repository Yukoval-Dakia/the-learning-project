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

// Spawn bounds (functions, not module-load consts, so tests can set env per-case):
export function jyeooSpawnTimeoutMs(): number {
  return Number.parseInt(process.env.JYEOO_SPAWN_TIMEOUT_MS ?? '120000', 10);
}
export function jyeooSpawnMaxStdoutBytes(): number {
  return Number.parseInt(process.env.JYEOO_SPAWN_MAX_STDOUT_BYTES ?? String(8 * 1024 * 1024), 10);
}
export function jyeooSpawnMaxStderrBytes(): number {
  return Number.parseInt(process.env.JYEOO_SPAWN_MAX_STDERR_BYTES ?? String(1024 * 1024), 10);
}
