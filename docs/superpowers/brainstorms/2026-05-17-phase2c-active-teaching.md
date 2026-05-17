# Phase 2C — Active Teaching Session MVP brainstorm

**Date**: 2026-05-17
**Spec parent**: `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 2C
**Task**: #18

> 写在前面：上一轮 Phase 2B 因为先写了显式 IN-SCOPE / OUT-OF-SCOPE，未飘。本文沿用同一模板。本任务目标是 **proof-of-concept**：跑通一个 LearningItem 的对话教学循环，让 Phase 3 Coach 有真实的 conversation 数据可读。

## 长期意图（spec 原文摘录）

```
读取目标和状态
-> 选择下一步：讲解 / 例题 / 复习 / 变式 / 追问
-> 用户作答或记录
-> judge / attribution / study log
-> 更新 evidence
-> 决定继续、切换、结束或安排下次
```

完成标准（spec）：系统不只是出题或写笔记，而能围绕一个 LearningItem 连续推进学习。

## v0 MVP IN-SCOPE

| 项 | 说明 |
|---|---|
| `learning_session(type='conversation', status='active'\|'ended')` | 已存在 enum + Zod；写路径是新的。`idle` 状态本期不实装。 |
| `src/server/session/conversation.ts` namespace | `startConversation`、`endConversation`、`assertActive` 三个最小 API；single-owner invariant 同 review/ingestion。 |
| `TeachingTurnTask` | 输入 = { learning_item, recent_messages, parent_hub_outline }；输出 = `{ kind: 'explain' \| 'ask_check' \| 'end', text_md, suggested_next?: 'continue' \| 'end' }`。单 pass，mimo-v2.5-pro，无 tool call。 |
| 3 个 API route | `POST /api/teaching-sessions`（start，body={learning_item_id}）；`POST /api/teaching-sessions/[id]/turn`（user 发 message → LLM → 1 个 agent message 返回）；`POST /api/teaching-sessions/[id]/end`。 |
| event payload | 用 `experimental:teach_message`（actor∈{user,agent}, subject_kind='learning_session', payload={ role, text_md, turn_kind? }）—— 走 experimental 不动 `src/core/schema/event/known.ts`。 |
| 最小 UI | `/learn/[learning_item_id]/chat` 页：聊天消息列表 + 输入框 + 结束按钮；样式沿用 `docs/design/loom-design-v2.1/`。 |
| 测试 | conversation namespace 状态机测试（start / end / double-end）；teaching turn route 单测（mock runTaskFn）；session-single-owner audit test 加 conversation 分支。 |

## v0 ABSOLUTELY-NOT-IN-SCOPE

- ❌ 中途生成 persistent `question` 行（check-question 仅作为 message 内联，不入题库）
- ❌ judge / attribution 对 inline check-question（用户答错不入错题流；只是聊天）
- ❌ LLM 用 tool call 主动调 quiz / variant_gen（任何 turn 都是纯文本）
- ❌ Streaming SSE（agent reply 一次性返回；UI 不闪烁）
- ❌ Session resume / idle state machine（active → ended 一条路）
- ❌ Conversation 自动生成 StudyLog（用户想要就手动 /study-log；非本期 hook）
- ❌ "ai_propose next session" → Coach（Phase 3）
- ❌ 用 Claude Agent SDK / MCP / Skills（CLAUDE.md scope discipline）
- ❌ 修改 `src/core/schema/event/known.ts`（实验信号走 experimental:）

## 最可能漂移的点（提前自警）

1. **加 streaming**：mimo 支持 SSE，但本期 UI 不需要逐字渲染。一次性返回，下期再 stream。
2. **想把 inline check 写成真 question**：诱惑大（"既然 LLM 出了题，存起来不浪费"）—— 不存。spec 明确说 active teaching 是 evidence 累积，question 走 ingestion / variant 已有路径。
3. **想加 tool call 让 LLM 自己调 VariantGenTask**：spec 写的是「选择下一步：讲解 / 例题 / 复习 / 变式」，但 v0 让 LLM 只产文字，不做副作用。orchestrator 编排留 Phase 3。
4. **改 conversation 状态机**：spec 写 active/idle/ended 三态；MVP 只走 active → ended，idle 留空。不要"补全"延期决策。
5. **在 ingestion route 里塞 conversation 触发**："学完发现这是错题"是 Phase 3 跨 lane 行为；不在 2C 内。

## 数据流

```
[POST /api/teaching-sessions { learning_item_id }]
  → Conversation.startConversation
    INSERT learning_session(type='conversation', status='active')
    INSERT event(experimental:teach_message, actor=agent, payload={ role:agent, text_md:opening, turn_kind:explain })
  → 返回 { session_id, initial_message }

[POST /api/teaching-sessions/[id]/turn { text_md }]
  → assertActive
  → INSERT event(experimental:teach_message, actor=user, payload={ role:user, text_md })
  → 加载 session 全部 teach_message + learning_item context
  → runTask('TeachingTurnTask', { learning_item, messages, parent_hub_outline })
  → INSERT event(experimental:teach_message, actor=agent, payload={ role:agent, text_md, turn_kind })
  → 如果 turn_kind === 'end' 且 LLM 建议结束 → 提示前端展示「结束按钮」（不自动关）
  → 返回 { agent_message, suggested_next }

[POST /api/teaching-sessions/[id]/end]
  → Conversation.endConversation
    UPDATE learning_session SET status='ended', ended_at=now()
  → 返回 { ok:true }
```

## 验收门

- `pnpm typecheck` clean
- `pnpm lint` clean
- `pnpm test src/server/session/conversation.test.ts` 全过
- `pnpm test app/api/teaching-sessions/**.test.ts` 全过
- 浏览器手测：`/learn/[learning_item_id]/chat` 能连发 3 turn 不报错；session 关闭后再发请求 422

## 风险登记

- mimo-v2.5-pro 单 turn 出 markdown 不稳定 → JSON schema 严格 + Zod parse，失败 fallback 到 text-only
- learning_session table 行多了之后 SELECT 全部 teach_message ineficient → MVP 单 session ≤ 50 turn 无所谓，Phase 3 再加 messages 表 / index

## 跟 Phase 2A/B 的关系

- 2A 给 "今天复习什么"；本期不动 review 流。
- 2B 给 LearningItem 树和 atomic note artifact；本期消费 — `parent_hub.summary_md` + atomic note `sections` 作为 system prompt 上下文。
- 2C 跑出来的 conversation 是 Phase 3 Coach 的输入素材（"上周用户在哪些 LearningItem 卡住了"）。
