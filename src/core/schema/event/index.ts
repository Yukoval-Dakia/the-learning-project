import { z } from 'zod';
import { ExperimentalEvent, ToolUseExperimental } from './experimental';
import { KnownEvent } from './known';

export * from './blocks';
export * from './known';
export * from './experimental';

// ====================================================================
// Event — 顶层 union
// ====================================================================
//
// Parse precedence（z.union 按顺序 try，第一个成功胜出）：
//   1. KnownEvent — 11 个稳定分支
//   2. ToolUseExperimental — experimental:tool_use 的特化（payload shape 已 locked）
//   3. ExperimentalEvent — 通用 experimental:* 命名空间逃逸阀
//
// 顺序要点：ToolUseExperimental 必须排在 ExperimentalEvent 之前，否则后者的 payload
// (任意 record) 会先 match 走，结构信息丢失。

export const Event = z.union([KnownEvent, ToolUseExperimental, ExperimentalEvent]);
export type EventT = z.infer<typeof Event>;

// 业务层入口 —— 所有 event 写入必经 parseEvent。
export const parseEvent = (input: unknown): EventT => Event.parse(input);
