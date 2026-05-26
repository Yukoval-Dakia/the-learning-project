# YUK-85 — Note 申诉 / 标错 UX (Path A: artifact + section_id 粒度)

**Phase outline**: [`2026-05-26-track-1-followup-phase.md`](2026-05-26-track-1-followup-phase.md) W1.3
**Linear**: [YUK-85](https://linear.app/yukoval-studios/issue/YUK-85) — M1 Quick wins
**Date**: 2026-05-26
**Wave**: W1.3
**估时**：**3 → 8 pts**（pre-flight 调研后从 outline 3 pts 上修，原因见下）

## 背景

[`docs/planning/v0.4-complete-form-roadmap.md`](../../planning/v0.4-complete-form-roadmap.md) §6 P2.4 "Note appeal / mark-wrong UX" 列为 Track-1 follow-up。本 phase outline 把它放 W1.3 估 3 pts，scope 写作"atomic note section 加'申诉/标错'按钮 + `experimental:correction_event { kind='mark_wrong', target_kind='artifact', target_id, section_idx, note_md }`"。

**Pre-flight 调研（2026-05-26）发现 outline 字面 scope 与现有 schema 不匹配**：

| 维度 | outline 假设 | 现状 |
|---|---|---|
| Correction event target | `target_kind='artifact'` | [`src/core/schema/event/known.ts:181`](../../../src/core/schema/event/known.ts) `CorrectEvent.subject_kind: z.literal('event')` 硬约束 |
| Section identifier | `section_idx`（数组下标） | [`src/core/schema/business.ts:221`](../../../src/core/schema/business.ts) `NoteSection.id: z.string()` 已存在 stable id |
| `affected_refs` 约束 | （outline 未提） | `CorrectEvent.payload.affected_refs: z.array(ActivityRef).min(1)` —— artifact target 无自然 ActivityRef |
| Existing correction API | （outline 暗示复用） | `/api/events/[id]/correct` 只接 event id；artifact 没有对应 route |
| effective-truth projection | （outline 暗示复用） | [`src/server/review/effective-truth.ts`](../../../src/server/review/effective-truth.ts) 只投 event-state，不投 artifact section-state |
| CorrectionStateRenderer | "复用 [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40)" | 渲染 `effective_event_id` / `replacement_event_id` 等 event-snapshot 字段，section-state 不是 event-snapshot |

字面照 outline 实现要扩 schema + 新 route + 新 projection + renderer 适配 + ADR，规模与 outline 估时不符。

**User 决定（2026-05-26）**：走 **Path A**（section_id 粒度，~8 pts，含 ADR-0019）。Path C（atomic 粗粒度）和 Path B（experimental:note_appeal channel）的对比见 phase outline / 当次决策对话。

## UI Design Compliance pre-flight

> 按 [`CLAUDE.md`](../../../CLAUDE.md) "UI Design Compliance" 规定，逐字引用 design doc 段落。

**没有专门 design doc 直接覆盖 atomic note section mark_wrong UX**。最近的同类 UX 先例：

- [`docs/design/2026-05-25-yuk-54-note-section-edit-in-place.md`](../../design/2026-05-25-yuk-54-note-section-edit-in-place.md) line 5：
  > "目标是在 atomic note 阅读页内直接编辑单个 section，同时保留现有 note markdown 渲染、embedded check 展示和 artifact 单写入口约束。"

  本 lane 沿用同一 "section-level user action on atomic note" UX 范式：YUK-54 已建立 "section 内 inline 用户动作"模式，本 lane 在同样 surface 上加"标错"动作。

**架构层 invariant 引用**：

- [`docs/architecture.md`](../../../docs/architecture.md) line 30：
  > "判定（quiz answer 判分、申诉重判）"
- [`docs/architecture.md`](../../../docs/architecture.md) line 45：
  > "**Judgment 不可变**：申诉重判 = 新建 Judgment，不修改旧的"

  对应到 correction event 模型：**correct event 不可变；restore = 新 correct event with `kind='restore'`**，不修改先前 mark_wrong 事件。本 lane 沿用此 invariant。

- [`docs/modules/notes.md`](../../modules/notes.md) line 141：
  > "Living note 对 `user_verified` section **不主动覆盖**，只 propose"

  本 lane 的标错事件作为 user-side 信号，对应 user_verified 反向：用户主动标 "此 section 错"，下游 Living Note (W2.3 [YUK-87](https://linear.app/yukoval-studios/issue/YUK-87) `NoteRefineTask`) 应**优先**触发该 section 的 refine 提议。

**组件类型声明**：
- 主要：**section-level overflow menu**（…按钮）+ **inline 状态徽章**（`marked_wrong` / `retracted`）
- 次要：reason_md 短表单（modal 或 inline expander 二选一，落地时根据现有 NoteRenderer 决定）
- 不引入新页面、不引入 drawer

**将要 touch 的文件**：

Server / schema：
- `src/core/schema/event/known.ts` — 新增 `CorrectArtifactEvent` 或松开 `CorrectEvent.subject_kind` 为 `z.union`（决策见 ADR-0019）
- `src/server/review/effective-truth.ts` — 新增 `getArtifactCorrectionState(db, artifactId, sectionId?): CorrectionStateSnapshot`
- `src/server/events/queries.ts` — 可能需要新 `findArtifactCorrectionEvents(db, artifactId)` helper
- 新建 `app/api/artifacts/[id]/correct/route.ts`
- 新建 `app/api/artifacts/[id]/correct/route.test.ts`
- 新建 `src/server/review/effective-truth.test.ts` 中 artifact-section 测例
- 新建 ADR `docs/adr/0019-correction-event-artifact-section-subject.md`

UI（需 design-doc pre-flight 再起）：
- `src/ui/components/NoteRenderer/` 或 `app/(app)/learning-items/[id]/page.tsx` —— 加 section-level overflow menu + 标错按钮
- 复用 `src/ui/correction/CorrectionStateRenderer.tsx`（必要时 minor 适配让其接受 "non-event" snapshot，或新建 `<SectionCorrectionBadge>` 包同样视觉规范）
- 测试：组件 unit + 阅读视图 integration

不动：
- ❌ `/api/events/[id]/correct` 现有 route（保持 event-correction 路径不动，避免回归）
- ❌ `CorrectEventPayload.affected_refs` 现 event-target 路径的 `.min(1)` 约束（artifact-target 走新 schema，不复用）
- ❌ `NoteSection` schema（已有 `id`，不动）
- ❌ Living Note `NoteRefineTask`（W2.3 [YUK-87](https://linear.app/yukoval-studios/issue/YUK-87) 的 lane；本 lane 只**提供** mark_wrong 信号，consumer 留 W2.3）

## Scope

### Sub 1 (server)：Schema + projection（~3 pts）

**Schema**：
- 新 `CorrectArtifactEvent` zod（兄弟于 `CorrectEvent`）：
  ```ts
  CorrectArtifactEvent = z.object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('self'),
    action: z.literal('correct'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string(),  // artifact_id
    outcome: z.literal('success'),
    payload: z.object({
      correction_kind: CorrectionKind,  // 复用现有 enum
      section_id: z.string().optional(),  // 未传 = 整 atomic 级 mark_wrong
      reason_md: z.string().min(1).max(2000),
      replacement_artifact_id: z.string().optional(),  // for 'supersede'
    }),
    ...baseOptionalFields,
  }).superRefine(/* supersede 必带 replacement_artifact_id 等约束 */)
  ```
- 加入 `AnyKnownEvent` union（事件读路径自动覆盖）
- 不动 `CorrectEvent`（event-target 路径），避免回归

**Projection**：
- 新 `getArtifactCorrectionState(db, artifactId, opts: { sectionId?: string }): CorrectionStateSnapshot`
- 读 `events WHERE action='correct' AND subject_kind='artifact' AND subject_id=artifactId AND (payload.section_id = sectionId OR sectionId IS NULL)`
- 按时序合成：mark_wrong + 后续 restore → active；mark_wrong + 后续 retract → retracted；mark_wrong + supersede → superseded
- 不污染现有 event-state projection（独立 API）

**Acceptance**：
- [ ] `CorrectArtifactEvent` zod + tests（valid / invalid / supersede 约束）
- [ ] `getArtifactCorrectionState` 7+ test 例（单事件 mark_wrong / 跨 section / restore 还原 / retract 终态 / supersede 替换链 / 空状态）
- [ ] `pnpm test:db` + `pnpm typecheck` + `pnpm audit:schema` 全绿
- [ ] 不破坏现有 `effective-truth.test.ts` event-state 测例

### Sub 2 (server)：API route + tests（~2 pts）

- 新 `POST /api/artifacts/[id]/correct` route
- Body 校验走新 `CorrectArtifactBody` zod（不直接复用 CorrectBody）
- 校验：
  - artifact 存在
  - `section_id` 若提供，必须存在于 `artifact.sections[].id`（不能虚指）
  - `correction_kind === 'supersede'` 必须带 `replacement_artifact_id` 且该 artifact 存在
- 写 event：`actor_kind='user', action='correct', subject_kind='artifact', subject_id=<id>, payload=<...>, caused_by_event_id=null`
- 返回 `{ correction_event_id }`
- DB integration test：mark_wrong / restore / retract / 错误路径（404 artifact / 404 section_id / 不合法 supersede）

**Acceptance**：
- [ ] 5+ DB integration test 例
- [ ] `pnpm test:db` 通过
- [ ] `pnpm build` 通过（新 route 进 manifest）

### Sub 3 (UI)：Section 标错入口 + 状态徽章（~3 pts）

**前置 gate**：Sub 1 + Sub 2 merged 到 main 后再起；UI design-doc pre-flight 落地后才动 UI 代码。

- `NoteRenderer` section 添加 overflow menu（"…"）：
  - "标错（mark_wrong）"
  - "撤回（retract）" —— 仅 user-verified 或 user 此前标错过该 section 时显示
  - "恢复（restore）" —— 仅当前 section 处于 marked_wrong / retracted 状态时显示
- 点击触发短表单：`reason_md` 输入 + 提交按钮
- 提交走 `POST /api/artifacts/[id]/correct`
- 状态徽章：在 section header / footer 显示 `marked_wrong` / `retracted` / `superseded` —— 复用 `CorrectionStateRenderer`，或新建 `<SectionCorrectionBadge>` 走相同 Badge tone 表
- 阅读视图加载时调 `GET /api/artifacts/[id]`（已存在），artifact 详情返回每 section 的 correction state（projection 在 GET 路径里调）—— 此处可能需要扩 GET 返回 shape，留 Sub 3 实施时细化

**Acceptance**：
- [ ] 5 section kind 全部能触发标错动作
- [ ] 提交后页面刷新可见徽章
- [ ] 不影响现有 proposal inbox retract UI / 现有 event-correction UI
- [ ] `pnpm test:db` + 浏览器 smoke 通过

## ADR-0019 outline

新建 `docs/adr/0019-correction-event-artifact-section-subject.md`，记录：

1. **Status**: accepted
2. **Context**:
   - Correction event ([ADR-0014 §6](../../adr/0014-generalized-activity-and-capability-registry.md) / [ADR-0011 v2](../../adr/0011-tool-use-and-edge-event-paths.md)) 当前 subject_kind 锁 `'event'`
   - Note artifact 用户标错需求（v0.4 §6 P2.4）出现，event-level 粒度不够（section 级才能驱动 Living Note `NoteRefineTask` 触发器）
3. **Decision**:
   - 不改 `CorrectEvent` schema，新建并行 `CorrectArtifactEvent`，避免污染 event-target 路径
   - section 标识用 `NoteSection.id`（stable string），**不**用 `section_idx`（避免 reorder staleness）
   - effective-truth 拆出独立 `getArtifactCorrectionState` 投影 API
   - `CorrectionKind` enum 不动（复用现有 `mark_wrong / retract / restore / supersede`）
   - `affected_refs` 字段不强求（artifact-target 无自然 ActivityRef）
4. **Consequences**:
   - Living Note `NoteRefineTask`（[YUK-87](https://linear.app/yukoval-studios/issue/YUK-87)）触发器表新增"用户标错 atomic / section ≥ 1" trigger
   - section reorder（YUK-54 in-place edit landed）必须保 section_id 稳定 —— code path 已遵守，但 ADR 显式锁定为 invariant
   - 未来扩到 question artifact / variant artifact correction 时，沿用同 schema（subject_id 切换 + section_id 不传即可）
5. **Alternatives considered**:
   - Path C（artifact-level only）：拒绝原因是 Living Note refine 触发器需要 section 粒度
   - Path B（`experimental:note_appeal` channel）：拒绝原因是与 ADR-0014 §6 correction event 统一语义指挥冲突
   - Widen `CorrectEvent.subject_kind` 到 union：拒绝原因是 `affected_refs.min(1)` 等 event-target 专属 invariant 会被迫松开，污染原路径

## 依赖关系图

```
Sub 1 schema + projection (server) ────→ Sub 2 API route (server) ────→ Sub 3 UI integration
        │                                       │                            │
        └─ ADR-0019 land                        └─ unblocks 浏览器 smoke      └─ design-doc pre-flight gate
```

无外部 blocker。Sub 1+2 可立即起。Sub 3 等 Sub 1+2 merge + design-doc pre-flight 通过。

## Cross-cutting helpers

- **CC-2 Correction state read model + renderer** ([YUK-40](https://linear.app/yukoval-studios/issue/YUK-40))：本 lane 新增 `getArtifactCorrectionState` API 是 read model 扩张；`CorrectionStateRenderer` 优先复用，如 snapshot shape 需求差异较大则新建 `<SectionCorrectionBadge>` 但**视觉一致**走 Badge primitive
- **CC-4 Proposal lifecycle** ([YUK-42](https://linear.app/yukoval-studios/issue/YUK-42)/[43](https://linear.app/yukoval-studios/issue/YUK-43)/[44](https://linear.app/yukoval-studios/issue/YUK-44))：本 lane**不**走 proposal channel —— 用户主动标错是直接 user signal，不需要 propose-accept 二阶段
- 不触 CC-1 / CC-3 / CC-5

## 实施顺序与 PR 切分

| Chunk | 内容 | 文件 | 估时 | 阻塞下一 chunk |
|---|---|---|---|---|
| 1 | schema + projection + ADR-0019 | `event/known.ts` / `effective-truth.ts` / `0019-*.md` + tests | 3 pts | unblocks 2 |
| 2 | API route + tests | `app/api/artifacts/[id]/correct/route.{ts,test.ts}` | 2 pts | unblocks 3 |
| 3 | UI section action + badge | `NoteRenderer` / `learning-items/[id]/page.tsx` / Sub 3 acceptance | 3 pts | （末） |

每 chunk 独立 PR + chain-merge。Sub 3 启动前重做一次 UI Design Compliance pre-flight（届时 Sub 1+2 已 land，schema 明确）。

## Risks

| 风险 | 缓解 |
|---|---|
| 现有 `CorrectionStateRenderer` snapshot shape 不直接适用 section-state | 优先 minor 适配（增 optional `target_kind` 字段），不行则新组件复用 Badge / 视觉规范 |
| Sub 2 API 写 event 后 Sub 3 渲染 stale —— 用户标错后立即看不到徽章 | `react-query invalidateQueries(['learning-item', id])`；Sub 3 提交后强制 refetch |
| Sub 1 schema 新增 union case 漏在某 event 读路径 | `pnpm audit:schema` + `AnyKnownEvent` union exhaustiveness; targeted `events/queries.test.ts` add cases |
| 用户连续标错同 section → 多个 mark_wrong event 投影歧义 | projection 取最近一条非 restore 事件作为终态；如果最近是 restore，回到 active；test 覆盖时序歧义 |
| section_id 被 in-place edit 改 | YUK-54 已在 main：section.id 在 edit 路径保持不变（content_md 只改 body_md，不重置 id）—— ADR-0019 显式 lock 此 invariant |

## Exit criteria（lane 整体）

- [ ] ADR-0019 land
- [ ] Sub 1 / Sub 2 / Sub 3 各 chunk 单独 PR 走完
- [ ] `pnpm test` + `pnpm test:migration` + `pnpm audit:schema` 全绿
- [ ] 浏览器 smoke：在 atomic note 阅读视图标错 1 个 section，徽章显示正确
- [ ] [YUK-87](https://linear.app/yukoval-studios/issue/YUK-87) Living Note 启动时可直接读 `getArtifactCorrectionState` 作为触发器 6（user mark_wrong）信号源

## Linear estimate 调整

YUK-85 当前 estimate 3 pts → **调整为 8 pts**。outline phase 表格的 estimate 也相应更新（M1 7 pts → 12 pts；总 23 → 28 pts）。M1 target 2026-06-04 可能滑到 2026-06-11；M2 target 不动。
