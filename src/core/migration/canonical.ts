import { createHash } from 'node:crypto';

// ====================================================================
// 迁移捕获 · canonical 序列化与哈希原语（grounding §13–§14）
// ====================================================================
//
// Manifest 的 canonical hash / edge hash 必须跨运行稳定：同一 DB 状态重跑
// capture 产生逐字节相同的哈希（幂等），否则「无重复捕获」无从判定。
// 这里统一两个纪律：
//   1. stableStringify —— 对象键排序、数组保序、确定性 number/Date 序列化；
//   2. 可变运维字段【绝不】进入 raw-fact 哈希（event.ingest_at、*.updated_at
//      等；grounding §14 明令分离记录）。

export { stableStringify } from './stable-stringify';

import { stableStringify } from './stable-stringify';

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
