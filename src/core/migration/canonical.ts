import { createHash } from 'node:crypto';

// ====================================================================
// YUK-1048 — 迁移捕获 · canonical 序列化与哈希原语（grounding §13–§14）
// ====================================================================
//
// Manifest 的 canonical hash / edge hash 必须跨运行稳定：同一 DB 状态重跑
// capture 产生逐字节相同的哈希（幂等），否则「无重复捕获」无从判定。
// 这里统一两个纪律：
//   1. stableStringify —— 对象键排序、数组保序、确定性 number/Date 序列化；
//   2. 可变运维字段【绝不】进入 raw-fact 哈希（event.ingest_at、*.updated_at
//      等；grounding §14 明令分离记录）。

/** 确定性 JSON 序列化：对象键按字典序，数组保序（数组顺序是事实）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return normalizeScalar(value);
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value instanceof Date) {
    // DB 时间戳是事实；统一为 ISO UTC 毫秒形态，杜绝本地时区漂移。
    return value.toISOString();
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    // undefined 键直接丢弃（与 JSON.stringify 语义一致）：{a:1,b:undefined} 与
    // {a:1} 哈希相同，避免跨运行形状漂移。
    if (entry === undefined) continue;
    out[key] = sortValue(entry);
  }
  return out;
}

function normalizeScalar(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON 无法表达 NaN/Infinity；DB 不产这些值，防御性归一避免跨运行差异。
    return String(value);
  }
  if (typeof value === 'bigint') {
    // bigint 列（如 event.dispatch_seq mode:'number' 不会出现，但 sql 原读可能）
    // 以十进制字符串进入哈希，与 PG 解析形态一致。
    return value.toString();
  }
  return value;
}

/** sha256 hex。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** canonical 哈希：stableStringify → sha256。 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/**
 * 有序 id 列表的 digest（升序排序后取 canonical 哈希）。
 * 集合语义：行序无关，集合相同即 digest 相同。
 */
export function digestOfIds(ids: readonly string[]): string {
  return canonicalHash([...ids].sort());
}

/** 结构化 id 列表的 digest（先按稳定键排序再哈希），用于 edge 列表等。 */
export function digestOfRecords<T>(records: readonly T[], keyOf: (record: T) => string): string {
  const sorted = [...records].sort((a, b) =>
    keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
  );
  return canonicalHash(sorted);
}

/** 短哈希前缀（内容寻址文件名用）。 */
export function shortHash(hash: string, len = 12): string {
  return hash.slice(0, len);
}
