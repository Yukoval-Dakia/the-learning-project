import { z } from 'zod';
import {
  ExperimentalEvent,
  MemoryBriefRefreshExperimental,
  RecordCaptureExperimental,
  UserCauseExperimental,
} from './experimental';
import { GenesisExperimental } from './genesis';
import { KnownEvent } from './known';
import { StateSnapshotExperimental } from './state-snapshot';

export * from './blocks';
export * from './known';
export * from './experimental';
export * from './state-snapshot';
export * from './genesis';

// ====================================================================
// Event — 顶层 union
// ====================================================================
//
// Parse precedence（z.union 按顺序 try，第一个成功胜出）：
//   1. KnownEvent — 15 个稳定分支（含 ToolUseQuery，自 ADR-0011 §1.1 promote 自
//      `experimental:tool_use`；含 SuppressArtifactLink，YUK-95 P5 Lane-D
//      ADR-0020 §9 dismiss）
//   2. UserCauseExperimental — experimental:user_cause 的特化（payload shape 已 locked）
//   3. RecordCaptureExperimental — experimental:record_capture
//   4. MemoryBriefRefreshExperimental — experimental:memory_brief_refresh
//   5. StateSnapshotExperimental — experimental:state_snapshot 的特化（ADR-0044 §3）
//   6. GenesisExperimental — experimental:genesis 的特化（YUK-471 W1, Codex #4 parse barrier）
//   7. ExperimentalEvent — 通用 experimental:* 命名空间逃逸阀
//
// 顺序要点：特化 experimental schemas 必须排在通用 ExperimentalEvent 之前，否则后者的
// payload (任意 record) 会先 match 走，结构信息丢失。

export const Event = z.union([
  KnownEvent,
  UserCauseExperimental,
  RecordCaptureExperimental,
  MemoryBriefRefreshExperimental,
  StateSnapshotExperimental,
  GenesisExperimental,
  ExperimentalEvent,
]);
export type EventT = z.infer<typeof Event>;

// 业务层入口 —— 所有 event 写入必经 parseEvent。
export const parseEvent = (input: unknown): EventT => Event.parse(input);
