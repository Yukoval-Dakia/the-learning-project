import { z } from 'zod';
import {
  ArtifactCreateExperimental,
  ArtifactLifecycleExperimental,
  BodyBlocksEditExperimental,
  NoteRefineUndoExperimental,
} from './artifact-events';
import {
  ExperimentalEvent,
  MemoryBriefRefreshExperimental,
  RecordCaptureExperimental,
  UserCauseExperimental,
} from './experimental';
import { GenesisExperimental } from './genesis';
import { GoalScopeUpdateExperimental, GoalStatusUpdateExperimental } from './goal-events';
import { KnownEvent } from './known';
import {
  LearningItemArchiveExperimental,
  LearningItemCompleteExperimental,
  LearningItemRelearnExperimental,
} from './learning-item-events';
import { MistakeVariantCreateExperimental } from './mistake-variant-events';
import {
  EditQuestionBlockStructuredExperimental,
  QuestionBlockCreateExperimental,
  QuestionBlockLifecycleExperimental,
} from './question-block-events';
import { StateSnapshotExperimental } from './state-snapshot';

export * from './blocks';
export * from './known';
export * from './experimental';
export * from './state-snapshot';
export * from './genesis';
export * from './goal-events';
export * from './learning-item-events';
export * from './mistake-variant-events';
export * from './artifact-events';
export * from './question-block-events';

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
//   7. GoalStatusUpdateExperimental / GoalScopeUpdateExperimental — goal 动作事件特化
//      （YUK-471 W2，使 status/scope 变更 fold-visible，./goal-events.ts）
//   8. MistakeVariantCreateExperimental — mistake_variant 运行时 creation BASE 事件特化
//      （YUK-471 W2 critic A4：携带 fold-blind cause_category；genesis 仅 backfill，
//       runtime create 用专属事件，./mistake-variant-events.ts）
//   9. LearningItemComplete/Relearn/ArchiveExperimental — learning_item 状态转移动作事件特化
//      （YUK-471 W2：使 complete/relearn/archive fold-visible via Q1，./learning-item-events.ts）
//  10. BodyBlocksEdit/ArtifactCreate/ArtifactLifecycle/NoteRefineUndoExperimental — artifact 动作事件特化
//      （YUK-471 W3-A1：body 编辑 / 运行时新建 / 生命周期变更 fold-visible；W3-C1γ：note-refine undo
//       自携 restored body fold-visible，./artifact-events.ts。NoteRefineUndo 复用既有 action 名，
//       fold 字段 optional 保 getEvents 旧 loose 事件读取不 throw）
//  11. EditQuestionBlockStructured/QuestionBlockCreate/QuestionBlockLifecycleExperimental —
//      question_block 动作事件特化（YUK-471 W3-A2：structured 编辑（merge 多行 after）/ 运行时新建
//      fold-visible；W3-D：lifecycle 使 5 个无事件 fold-truth mutator（reassignFigure / auto-enroll /
//      import-enroll / import-ignore / revert）fold-visible，./question-block-events.ts）
//  12. ExperimentalEvent — 通用 experimental:* 命名空间逃逸阀
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
  GoalStatusUpdateExperimental,
  GoalScopeUpdateExperimental,
  MistakeVariantCreateExperimental,
  LearningItemCompleteExperimental,
  LearningItemRelearnExperimental,
  LearningItemArchiveExperimental,
  BodyBlocksEditExperimental,
  ArtifactCreateExperimental,
  ArtifactLifecycleExperimental,
  NoteRefineUndoExperimental,
  EditQuestionBlockStructuredExperimental,
  QuestionBlockCreateExperimental,
  QuestionBlockLifecycleExperimental,
  ExperimentalEvent,
]);
export type EventT = z.infer<typeof Event>;

// 业务层入口 —— 所有 event 写入必经 parseEvent。
export const parseEvent = (input: unknown): EventT => Event.parse(input);
