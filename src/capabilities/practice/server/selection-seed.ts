// YUK-558 (worklist #7, spec docs/design/2026-07-03-softmax-spec.md Q6-A / M2) — 种子化 prod sampler
// 的 seed 派生 + log-only 记录。让选题决策**可重构**（同 seed + 同输入 ⇒ 同选集），闭合 register
// (a) 的「prod 走裸 Math.random，不可确定性回放」缺口。
//
// 不新写 PRNG：复用 src/server/calibration/rng.ts 的 mulberry32（forward-sampler.ts / bootstrap
// 已在用——duplicate building 是反模式，Lens B-F5）。本文件只派生 seed + 记日志。
//
// 统计上无害（HT 无偏性只依赖记录的 π_i 正确，与 realized 抽签机制无关——audit-only）；
// seed 走 **log-only**（不进 DB 列——加列 = 5 面登记税，Q-d deferred；回放 = 看日志 + 手喂 seed）。
//
// 注入面（spec M2 / Lens B-F6 修正后的 touch 图）：
//   - compose/物化事件 → softmax-selection.ts:376 的 deps.rng（经 composeSoftmaxDeps 线程）。
//   - 重排事件 → stream-store.ts:1076 的 opts.rng（经 advanceStreamItem:708 rerankDeps →
//     reRankAfterAnswer:743/:899 线程）。
//   **两抽样事件各派生独立 seed**（eventKind ‖ triggerId 区分），互不干扰。
//
// seed 形：简单 32-bit 整数 hash(localDate ‖ eventKind ‖ triggerId)（FNV-1a 变体——无需 crypto，
// seed 只需稳定 + 可记录）。production caller（route handler / 夜跑 job）在最外层构造 rng 并经
// DI 线程穿透，stream-store / softmax-selection 的函数签名**不变**（rng 仍是 `() => number` 可选 DI）。

import { mulberry32 } from '@/server/calibration/rng';

/**
 * 选题抽样事件的种别（spec M2 的两独立抽样事件 + 其 compose 变体）。
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
 * 构造 seeded rng（mulberry32）+ log seed/eventKind/triggerId（log-only，不进 DB）。
 *
 * production caller 在最外层调本 helper，把返回的 rng 经 composeSoftmaxDeps.rng /
 * rerankDeps.rng 线程注入 sampler。seed 派生是确定性的（同三元组 ⇒ 同 rng ⇒ 同选集），
 * 让选题决策可重构——register (a) 静默分支日志（softmax-selection.ts:478/:483 的 warn）
 * + 本 seed log 共同支撑「这次选题是怎么来的」回放。
 */
export function buildSeededSelectionRng(
  localDate: string,
  eventKind: SelectionSeedEventKind,
  triggerId: string,
): () => number {
  const seed = hashSelectionSeed(localDate, eventKind, triggerId);
  // Log-only（spec Q-d：seed 列 deferred，加列 = 5 面登记税）。回放 = 看日志 + 手喂 seed 重跑。
  console.log('[selection] seeded', { eventKind, triggerId, localDate, seed });
  return mulberry32(seed);
}
