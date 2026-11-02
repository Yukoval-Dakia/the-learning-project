// Seed derivation for deterministic selection replay.
//
// Reuses the existing mulberry32 rather than adding a PRNG: same seed plus same inputs yields
// the same selection. Seeds are 32-bit FNV-1a hashes of date, event kind, and trigger id, and
// are logged rather than stored, so replay needs the log plus an injected rng. Compose and
// rerank derive independent seeds.

import { mulberry32 } from '@/core/rng';

/**
 * 选题抽样事件的种别（的两独立抽样事件 + 其 compose 变体）。
 * - `compose` / `compose-nightly` / `recompose`：物化/compose 路径（消费点 softmax-selection.ts:376）。
 * - `rerank`：答后增量重排（消费点 stream-store.ts:1076，经 advanceStreamItem rerankDeps 线程）。
 */
export type SelectionSeedEventKind = 'compose' | 'compose-nightly' | 'recompose' | 'rerank';

/**
 * 简单确定性 32-bit 整数 hash（FNV-1a 变体）。无需 crypto——seed 只需稳定、可记录、
 * 不同 (localDate, eventKind, triggerId) 三元组**统计上**散开（mulberry32 对 seed 满意）。
 *
 * 导出（非 lambda 局部）以便单测 pin 其确定性（同三元组 ⇒ 同 seed）。
 */
export function hashSelectionSeed(
  localDate: string,
  eventKind: SelectionSeedEventKind,
  triggerId: string,
): number {
  let h = 0x811c9dc5; // FNV offset basis (32-bit).
  const s = `${localDate}|${eventKind}|${triggerId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime (32-bit).
  }
  return h >>> 0; // 无符号 32-bit（mulberry32 seed 入口 `>>> 0`）。
}

/**
 * 构造 seeded rng（mulberry32）+ **惰性**自记 seed/eventKind/triggerId 日志（log-only，不进 DB）。
 *
 * production caller 在最外层调本 helper，把返回的 rng 经 composeSoftmaxDeps.rng /
 * rerankDeps.rng 线程注入 sampler。seed 派生是确定性的（同三元组 ⇒ 同 rng ⇒ 同选集），
 * 让选题决策可重构——register (a) 静默分支日志（softmax-selection.ts:478/:483 的 warn）
 * + 本 seed log 共同支撑「这次选题是怎么来的」回放。
 *
 * **惰性日志（C2）**：日志推迟到 rng **首次真实被调用**（首次抽签）时才打，且**恰打一次**。
 * 缘由：caller 无条件构造 rng 并经 DI 线程注入，但许多路径根本不消费它——已物化流的 GET
 * （composeIfEmpty 命中已存流）/ no-op nightly（当日已产）/ 非 rerank 的 PATCH（done/skip 不触发
 * 重排抽样）。若在构造期即打日志，这些路径会产生 decoy「seeded」行（误导回放：日志说抽了签，
 * 实际没抽）。惰性 thunk 让日志与真实抽签一一对应——未消费 ⇒ 零日志。
 */
export function buildSeededSelectionRng(
  localDate: string,
  eventKind: SelectionSeedEventKind,
  triggerId: string,
): () => number {
  const seed = hashSelectionSeed(localDate, eventKind, triggerId);
  let inner: (() => number) | null = null;
  return () => {
    if (inner === null) {
      // Log-only。回放 = 看日志 + 手喂 seed 重跑。
      // 恰在首次真实抽签时打（惰性）——未消费的 rng 零 decoy 日志。
      console.log('[selection] seeded', { eventKind, triggerId, localDate, seed });
      inner = mulberry32(seed);
    }
    return inner();
  };
}
