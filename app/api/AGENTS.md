# app/api — 后端路由面（唯一后端入口）

> 所有后端逻辑 = App Router route handler，薄路由 → 调 `src/server/*` service。`middleware.ts` 拦截每个 `/api/*`：缺 `x-internal-token === INTERNAL_TOKEN` 则 401（**除** `/api/health`）。单用户工具，无 per-user auth。

## 路由面索引
| 前缀 | 职责 → service |
|------|------|
| `ai/[task]` | generic AI 入口——**仅** `ReviewIntentTask`；其余返回 require-domain-route（runner `src/server/ai/`）|
| `ingestion/[id]/{extract,import,rescue,blocks,events}` | 录入会话 + 抽取/导入/救援（`src/server/ingestion/` + `session/`）|
| `assets/[id]/content` | multipart 上传 → R2 + DB row（`src/server/r2.ts`）|
| `question-blocks/[id]/figures/[asset_id]` | 配图归属 PATCH（manual override）|
| `questions/[id]/timeline` | StructuredQuestion + event 时间线 |
| `knowledge/{[id],edges,proposals,review}` | 知识树/mesh CRUD + propose accept/dismiss + KnowledgeReviewTask |
| `events/[id]/{correct,rate}` | event 流读写 + rate/纠正 |
| `mistakes/recent` · `learning-items/[id]` · `learning-intents/[id]/accept` | 错题视图 / learning item / intent accept（触发 note_generate）|
| `review/{due,submit,plan,sessions/[id]/*,weekly,advice,appeal}` | FSRS 复习流 + session lifecycle（`src/server/review/` + `fsrs/`）|
| `proposals/[id]/{accept,dismiss,retract}` | 破坏性动作落地（`src/server/proposals/actions.ts`）|
| `artifacts/[id]/{body-blocks,sections,ai-changes/[eventId]/undo,backlinks,correct}` | Living Note 编辑（`src/server/artifacts/`）|
| `editing-session/{heartbeat,blur}` · `teaching-sessions/[id]/{turn,end}` · `copilot/chat` | 编辑 presence / tutor / copilot |
| `hubs/[id]/dismiss-link` · `embedded-check/attempt` · `echo/[id]/events` | hub / inline 自测 / echo golden E2E |
| `today/{proposals,ai-changes,copilot-summary}` · `cost/today` · `records/[id]` · `study-log/[id]` | today plan / 成本 / learning record |
| `admin/{cost,failures,runs/[id]}` | 管理面（生产 UI API 走可路由 admin，**不**走 `_/*`）|
| `_/{export,import,seed,logs,tools,backfill}` | dev/admin 工具——round-trip 测试在 `_/_round_trip.test.ts` |
| `health` | 唯一免 token 的 liveness probe |

## CONVENTIONS
- route 薄、逻辑在 service；写 `event`/`tool_call_log`/`cost_ledger` 留痕。
- route 测试可进 unit config **仅当** DB/R2/AI 依赖在 import 前被 mock；否则进 db config。
- `pnpm build` 校验 route export（tsc/biome/vitest 都漏，YUK-67）。

## ANTI-PATTERNS
- 别把生产 UI 依赖放进 `_/*`（dev-only）——走 `admin/*`。
- 别在 route 内直接对 LLM 暴露 mutation——破坏性动作只能 propose → accept route 落地。
