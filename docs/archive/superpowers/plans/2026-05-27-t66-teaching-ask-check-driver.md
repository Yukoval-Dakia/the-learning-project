# T-66 Teaching ask_check Artifact — Track Driver

> Wave 1 track driver。复用 master-roadmap + YUK-88 driver 共用规则。

**Doc 日期**：2026-05-27
**Track ID**：T-66
**Linear**：[YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) — Backlog，Track-1 Follow-up project，M2 milestone，5pt Medium
**Estimate**：5 pt
**Worktree**：B (Wave 1)，T-RA 之后接力
**Owner**：lane subagent (model=opus)

---

## §0 状态校准

YUK-66 description 完整（见 master roadmap §11 T-66 card 引用 + YUK-66 Linear body）；scope / acceptance / boundaries 全在 Linear。本 driver 不重复，仅 per-track 特异部分。

YUK-66 status: Backlog；启动时手动 flip In Progress。

---

## §1 Scope（per YUK-66 description）

### §1.1 必交付项

1. **`TeachingTurnTask` ask_check schema 扩展**：output 增 `structured_question: { judge_kind_override, rubric_json, reference_md }` optional 字段
2. **`app/api/teaching-sessions/[id]/turn/route.ts`**：当 turn_kind=ask_check 时写 `question(source='teaching_check', learning_item_id, ...)` —— 复用现有 question 表 schema
3. **Attempt route**：复用 `/api/embedded-check/attempt` 语义 OR 新建 `/api/teaching-sessions/[id]/check/[question_id]/attempt`（spec 决定，post-grill 拍）
4. **Judge 走 CC-3 JudgeInvoker**：不绕过；同 EmbeddedCheck 路径
5. **`<TeachingDrawer>` UI**：内嵌 `<EmbeddedCheckSection>` 渲染 structured question（复用 atomic note embedded check 组件）
6. **Failure → mistake → variant chain**：teaching ask_check 失败 attempt 触发 attribution_followup（已 ship）→ AttributionTask judge → variant_gen（已 ship），全 e2e
7. **Doc cleanup**：`docs/architecture.md` Phase 2C 段去掉 "no inline question persistence" caveat

### §1.2 Out of scope

- ❌ 改 TeachingTurnTask 流程（仍是 single turn，no streaming）
- ❌ 改 JudgeInvoker 接口
- ❌ 改 mistake → variant chain（YUK-17 已 ship，consumer 不动）
- ❌ Tool call / inline question persistence in chat (这 IS the issue 本身，不要把 scope 扩到其他 inline persistence) 

---

## §2 Acceptance criteria（per YUK-66）

- [ ] `TeachingTurnTask` ask_check output schema 扩展（zod + prompt 改）
- [ ] Teaching chat ask_check 写 question + question 出现在 `/today` FSRS 队列
- [ ] User 失败 → mistake → variant chain 全 e2e 路径 test 覆盖
- [ ] `JudgeInvoker` 单入口 invariant 保持
- [ ] `docs/architecture.md` Phase 2C "no inline question persistence" 注释去掉
- [ ] `pnpm test:db` + `pnpm audit:schema` + `pnpm typecheck` + `pnpm lint` + `pnpm build` 全绿
- [ ] PR title `feat(teaching): ask_check artifact + judge + variant chain (YUK-66)`
- [ ] Commit message ends with `Closes YUK-66`

---

## §3 Pre-flight

1. **Verify YUK-66 status**：仍 Backlog（不是 In Progress）；启动手动 flip
2. **Verify TeachingTurnTask 当前 schema**：`Read src/core/schema/event/teaching.ts` + `src/server/ai/tasks/teaching-turn.ts`
3. **Verify EmbeddedCheck attempt 路径**：`Read app/api/embedded-check/attempt/route.ts` —— 决策 §1.1 step 3（复用 vs 新建）
4. **Verify JudgeInvoker 接口**（CC-3）：`Read src/server/judge/invoker.ts`
5. **Verify question 表 source enum**：`grep -A5 "source.*teaching_check\|source.*embedded" src/db/schema.ts` —— 确认是否需 audit-schema allowlist 入口 / 直接加 enum value
6. **UI design pre-flight**（per CLAUDE.md UI Design Compliance）：
   - 引用 design doc：`docs/design/2026-05-25-yuk-54-note-section-edit-in-place.md` (EmbeddedCheck 嵌入模式) + design brief v2.1 §"Teaching Drawer"
   - 组件类型：**TeachingDrawer 内嵌 inline question card**（复用 `<EmbeddedCheckSection>`，不新建）
   - touch 文件：`app/(app)/learning-items/[id]/page.tsx`（TeachingDrawer 区域改）+ 无新 UI 组件
   - **等用户 approve 才动 UI 代码**

### §3.1 ADR 触发条件

per YUK-66 description boundaries：

- **如果决定走"新 `/api/teaching-sessions/[id]/check/[question_id]/attempt`" 独立路由**（不复用 embedded-check attempt）→ 需 ADR 记录 attempt route 拓扑
- **如果引入 question 表 `source='teaching_check'` 新 enum value** → ADR 不必但需 audit-schema allowlist or migration

---

## §4 Files touched（预期）

```
src/core/schema/event/teaching.ts             # 改：ask_check structured_question optional
src/server/ai/tasks/teaching-turn.ts          # 改：prompt 加 structured_question 输出条件
src/db/schema.ts                              # 改：question.source enum 加 'teaching_check'

app/api/teaching-sessions/[id]/turn/route.ts  # 改：turn_kind=ask_check + structured 时写 question 表

# § attempt route 决策（pre-flight 拍）：
# 路径 A：复用 app/api/embedded-check/attempt/route.ts —— 改 source 限制
# 路径 B：新建 app/api/teaching-sessions/[id]/check/[question_id]/attempt/route.ts

app/(app)/learning-items/[id]/page.tsx        # 改：TeachingDrawer 区域嵌入 <EmbeddedCheckSection>

docs/architecture.md                          # 改：去掉 Phase 2C "no inline question persistence" caveat

tests/server/teaching/
  ask_check_artifact.test.ts                  # 新：e2e ask_check → question → attempt → mistake → variant
```

---

## §5 Forward-locks

- 无明确 forward-lock 别 track
- 内 unblock teaching loop "真闭环"（current ship state 是 ask_check 不持久；T-66 ship 后 chat 中产生的 quiz 题入 FSRS 队列）

---

## §6 Skills / MCP usage

- `superpowers:test-driven-development` —— e2e test 链 (ask_check → question → attempt → judge → mistake → variant) TDD
- `mcp__auggie__codebase-retrieval` —— attempt 路径决策时 search "embedded-check attempt" 全引用
- UI design pre-flight per CLAUDE.md

---

## §7 Risk

| Risk | Mitigation |
|---|---|
| attempt 路径决策（A 复用 vs B 新建）后期 regret | pre-flight §3 step 5 决策，写进 PR description；如新建（B），同 PR 写 ADR |
| `source='teaching_check'` 跟 `source='embedded'` UI 渲染分支扩散 | 复用 `<EmbeddedCheckSection>` 一律渲染；source 仅 storage / FSRS 队列 metadata |
| variant_gen 链对 teaching_check 题目可能产生不合适 variant | Phase 2C MVP 是 acceptable；如出现质量问题，单独 issue 追 |
| TeachingTurnTask prompt 改后既有 chat 历史回放冲突 | structured_question 是 optional；老 turn 不带不破坏渲染 |
