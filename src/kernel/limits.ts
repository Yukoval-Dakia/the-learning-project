// Kernel facade for cross-cutting numeric limits（公共件，非契约 —— 同 http.ts 形制）。
//
// Capability 包只能依赖 @/kernel/* + 自身 + 共享 UI 件（src/capabilities/AGENTS.md），
// 因此不能直接 import @/core/limits。本模块是取这些上界的合法路径。
//
// 为何不塞进 capability-contract-schemas.ts：那个 facade 是 ~11 个 Zod schema 模块的 barrel，
// 而顶层 `z.object(...)` 调用无法被证明无副作用 → bundler 摇不掉。从它取一个数字会把整个 core
// schema 面（含全套 event schema）拖进 SPA 图。PR #1069 实测（esbuild metafile，仅计一方模块）：
//
//   import { REASONING_TRACE_MAX_LEN } from …
//     '@/core/schema/event/known'            → 8 模块（2 个 event schema）， 46,758 B  ← 旧写法，越界
//     '@/kernel/capability-contract-schemas' → 34 模块（13 个 event schema）、252,892 B  ← 更糟
//     '@/kernel/limits'                      → 2 模块（0 个 event schema）、     107 B  ← 本模块
//
// 保持本模块是 core/limits.ts 纯叶子的 re-export，正是浏览器侧 practice UI 能零成本取到这个
// 上界的原因。单一真源不变：定义仍在 core/limits.ts。
//
// 按「第二实例原则」只导出有真实使用方的项——需要别的上界时再往下加。
export { REASONING_TRACE_MAX_LEN } from '@/core/limits';
