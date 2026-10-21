// Kernel facade for cross-cutting numeric limits（公共件，非契约）。
//
// Capability 包不能直接 import @/core/limits，本模块是合法路径。它必须保持纯叶子
// re-export：放进 capability-contract-schemas 的 schema barrel 会让顶层 z.object
// 把整套 core schema（含 event schema）拖进 SPA 图。
//
// 单一真源仍是 core/limits.ts；按第二实例原则只导出有真实使用方的项。
export { COPILOT_REUSE_WINDOW_MS, REASONING_TRACE_MAX_LEN } from '@/core/limits';
